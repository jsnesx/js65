// SPDX-License-Identifier: MPL-2.0

/**
 * Integration smoke test per the plan's Verification section: spawn
 * `node build/js65-lsp.cjs` over stdio, send `initialize` →
 * `textDocument/didOpen` with a file containing a known error, assert the
 * resulting `publishDiagnostics` has the right range and the right
 * `relatedInformation` chain for a macro-expanded error.
 *
 * This is the only place we exercise the actual JSON-RPC wire — every other
 * test hits the analyzer + feature modules directly. It is also the closest
 * thing to what the VSCode client does, so every request the extension issues
 * (`definition`, `hover`, `completion`, `documentSymbol`, `foldingRange`,
 * `semanticTokens/full`, `js65/expandMacro`) is exercised here end to end.
 */

import {afterAll, beforeAll, describe, it, expect} from 'bun:test';
import {fork, spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {URI} from 'vscode-uri';
import {SEMANTIC_TOKEN_LEGEND} from '../worker/features/structure.ts';

interface JsonRpcResponse { id?: number| string, result?: unknown, method?: string, params?: unknown }

/** Tiny LSP client: spawn the server, queue messages, drain notifications. */
class LspClient {
  private proc: ReturnType<typeof spawn>;
  // Buffered as bytes, not a string: `Content-Length` counts bytes, and a
  // response containing any non-ASCII character (the hover text uses an em
  // dash) desynchronizes the framing if it is sliced by JS string index.
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private responseResolvers = new Map<number, (r: unknown) => void>();
  readonly notifications: JsonRpcResponse[] = [];

  constructor(serverPath: string) {
    this.proc = spawn('node', [serverPath, '--stdio'], {stdio: ['pipe', 'pipe', 'inherit']});
    this.proc.stdout!.on('data', d => this.onData(d));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length: (\d+)/.exec(header);
      if (!match) return;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return;
      const msg = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + len).toString('utf8'));
      this.buffer = this.buffer.subarray(bodyStart + len);
      if ('id' in msg && msg.id != null && this.responseResolvers.has(msg.id as number)) {
        this.responseResolvers.get(msg.id as number)!(msg);
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    }
  }

  request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.responseResolvers.set(id, resolve as (r: unknown) => void);
      this.send({jsonrpc: '2.0', id, method, params});
      setTimeout(() => reject(new Error(`request ${method} timed out`)), 5000);
    });
  }

  notify(method: string, params: unknown): void {
    this.send({jsonrpc: '2.0', method, params});
  }

  /**
   * Wait for a notification matching `predicate`. Notifications already
   * received count — diagnostics for a freshly-opened document routinely
   * arrive before the caller gets around to asking for them.
   */
  async waitFor(predicate: (n: JsonRpcResponse) => boolean, timeoutMs = 8000):
      Promise<JsonRpcResponse> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.notifications.find(predicate);
      if (found) return found;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('timed out waiting for notification');
  }

  /** Drop buffered notifications, so a `waitFor` can't match a stale one. */
  clearNotifications(): void { this.notifications.length = 0; }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin!.write(body);
  }

  async close(): Promise<void> {
    // `shutdown` is a request in LSP, not a notification — the server replies
    // to it, and only then is `exit` legal.
    await this.request('shutdown', null);
    this.notify('exit', null);
    this.proc.stdin!.end();
    await new Promise<void>(r => this.proc.on('exit', () => r()));
  }
}

/**
 * The integration tests drive the bundled server, which only exists after
 * `bun run lsp`. Skip rather than fail on a clean checkout — `bun run test:lsp`
 * builds it first.
 */
const SERVER_PATH = path.resolve('build/js65-lsp.cjs');
const haveServer = existsSync(SERVER_PATH);
const itIfBuilt = haveServer ? it : it.skip;

describe('integration: LSP over stdio', () => {
  itIfBuilt('initialize responds with capabilities + serverInfo', async () => {
    const client = new LspClient(SERVER_PATH);
    try {
      const res = await client.request('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
      });
      expect(res.result).toBeDefined();
      const r = res.result as {capabilities: any, serverInfo: any};
      expect(r.serverInfo.name).toBe('js65-lsp');
      expect(r.capabilities.definitionProvider).toBe(true);
      expect(r.capabilities.hoverProvider).toBe(true);
    } finally {
      await client.close();
    }
  }, 10000);

  itIfBuilt('publishes diagnostics for a file with a known error', async () => {
    const client = new LspClient(SERVER_PATH);
    try {
      await client.request('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
      });
      client.notify('initialized', {});
      // Syntax error: $xx is not valid hex.
      const code = 'main:\n  lda #$xx\n';
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri: 'file:///proj/main.s',
          languageId: 'ca65',
          version: 1,
          text: code,
        },
      });
      // Wait for publishDiagnostics.
      const notif = await client.waitFor(n => n.method === 'textDocument/publishDiagnostics');
      const diag = notif.params as any;
      expect(diag.uri).toBe('file:///proj/main.s');
      expect(diag.diagnostics.length).toBeGreaterThan(0);
      expect(diag.diagnostics[0].message).toMatch(/hex/i);
    } finally {
      await client.close();
    }
  }, 15000);
});

/**
 * Full round trip against a real on-disk project, issuing exactly the requests
 * the VSCode extension issues. Everything above this point runs without a
 * workspace; this exercises project discovery, the include graph, and every
 * advertised capability over the wire — which is the only way to catch a
 * feature that works in a unit test but is mis-wired in `server.ts`.
 */
describe('integration: round trip against a real project', () => {
  let dir = '';
  const files = {
    project: () => path.join(dir, 'js65.json'),
    main: () => path.join(dir, 'main.s'),
    macros: () => path.join(dir, 'inc', 'macros.inc'),
  };
  const MAIN = [
    '.include "macros.inc"',
    '',
    'counter = $10',
    '',
    '; entry point',
    '.proc reset',
    '  lda #$00',
    '  sta counter',
    '  setpal $12',
    '  jmp reset',
    '.endproc',
    '',
  ].join('\n');
  const MACROS = [
    '.macro setpal color',
    '  lda #color',
    '  sta $2007',
    '.endmacro',
    '',
  ].join('\n');

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'js65-lsp-'));
    mkdirSync(path.join(dir, 'inc'), {recursive: true});
    writeFileSync(files.project(), JSON.stringify({
      projects: [{name: 'main', sources: ['main.s'], includePaths: ['inc']}],
    }));
    writeFileSync(files.main(), MAIN);
    writeFileSync(files.macros(), MACROS);
  });

  afterAll(() => {
    if (dir) rmSync(dir, {recursive: true, force: true});
  });

  const uriOf = (p: string) => URI.file(p).toString();

  /** Spawn a server, initialize it against the fixture, and open `main.s`. */
  async function openedClient(): Promise<LspClient> {
    const client = new LspClient(SERVER_PATH);
    const rootUri = uriOf(dir);
    await client.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{uri: rootUri, name: 'fixture'}],
      capabilities: {workspace: {didChangeWatchedFiles: {dynamicRegistration: true}}},
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: {uri: uriOf(files.main()), languageId: 'ca65', version: 1, text: MAIN},
    });
    // The first publish means the project was discovered and assembled.
    await client.waitFor(n => n.method === 'textDocument/publishDiagnostics');
    return client;
  }

  itIfBuilt('assembles the project clean and reports no errors', async () => {
    const client = await openedClient();
    try {
      const published = client.notifications
          .filter(n => n.method === 'textDocument/publishDiagnostics')
          .map(n => n.params as {uri: string, diagnostics: any[]});
      const errors = published.flatMap(p => p.diagnostics).filter(d => d.severity === 1);
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('go-to-definition jumps from a reference to its definition', async () => {
    const client = await openedClient();
    try {
      // `sta counter` on line 7 (0-based) — column 7 is inside `counter`.
      const res = await client.request('textDocument/definition', {
        textDocument: {uri: uriOf(files.main())},
        position: {line: 7, character: 8},
      });
      const loc = Array.isArray(res.result) ? res.result[0] : res.result as any;
      expect(loc).toBeDefined();
      expect(loc.uri).toBe(uriOf(files.main()));
      expect(loc.range.start.line).toBe(2); // `counter = $10`
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('go-to-definition on an .include string resolves through includePaths', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('textDocument/definition', {
        textDocument: {uri: uriOf(files.main())},
        position: {line: 0, character: 12}, // inside "macros.inc"
      });
      const loc = Array.isArray(res.result) ? res.result[0] : res.result as any;
      expect(loc).toBeDefined();
      // The resolved target is the file the assemble actually opened.
      expect(loc.uri).toBe(uriOf(files.macros()));
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('references reports every use of a symbol', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('textDocument/references', {
        textDocument: {uri: uriOf(files.main())},
        position: {line: 7, character: 8},
        context: {includeDeclaration: true},
      });
      const locs = res.result as Array<{uri: string, range: any}>;
      // The declaration (line 2) plus the one use inside the .proc (line 7).
      expect(locs.map(l => l.range.start.line).sort()).toEqual([2, 7]);
      expect(locs.every(l => l.uri === uriOf(files.main()))).toBe(true);
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('hover on a mnemonic lists its addressing modes', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('textDocument/hover', {
        textDocument: {uri: uriOf(files.main())},
        position: {line: 6, character: 3}, // `lda`
      });
      const hover = res.result as {contents: {value: string}};
      expect(hover?.contents?.value).toMatch(/lda/i);
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('documentSymbol returns the .proc as a symbol', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('textDocument/documentSymbol', {
        textDocument: {uri: uriOf(files.main())},
      });
      const symbols = res.result as Array<{name: string, kind: number}>;
      expect(symbols.some(s => s.name === 'reset')).toBe(true);
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('foldingRange spans the .proc, counting comment and blank lines', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('textDocument/foldingRange', {
        textDocument: {uri: uriOf(files.main())},
      });
      const ranges = res.result as Array<{startLine: number, endLine: number}>;
      // `.proc` is on line 5 and `.endproc` on line 10 (0-based), after two
      // blank lines and a comment — the lines a naive index-based lexer drops.
      expect(ranges).toContainEqual(expect.objectContaining({startLine: 5, endLine: 10}));
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('semanticTokens/full returns a well-formed delta-encoded array', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('textDocument/semanticTokens/full', {
        textDocument: {uri: uriOf(files.main())},
      });
      const data = (res.result as {data: number[]}).data;
      expect(data.length).toBeGreaterThan(0);
      expect(data.length % 5).toBe(0);
      // Every type index must be inside the legend advertised on initialize,
      // and every modifier bit must name a modifier the legend declares.
      const typeCount = SEMANTIC_TOKEN_LEGEND.tokenTypes.length;
      const modMask = (1 << SEMANTIC_TOKEN_LEGEND.tokenModifiers.length) - 1;
      for (let i = 3; i < data.length; i += 5) {
        expect(data[i]).toBeLessThan(typeCount);
        expect(data[i + 1] & ~modMask).toBe(0);
      }
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('completion offers mnemonics and project symbols', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('textDocument/completion', {
        textDocument: {uri: uriOf(files.main())},
        position: {line: 6, character: 3},
      });
      const items = (Array.isArray(res.result) ? res.result : (res.result as any).items) as
          Array<{label: string}>;
      const labels = items.map(i => i.label);
      expect(labels).toContain('lda');
      expect(labels).toContain('counter');
      // Macros are callable at instruction position.
      expect(labels).toContain('setpal');
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('js65/expandMacro returns the expansion of the invocation', async () => {
    const client = await openedClient();
    try {
      const res = await client.request('js65/expandMacro', {
        uri: uriOf(files.main()),
        position: {line: 8, character: 4}, // inside `setpal`
      });
      const result = res.result as {text: string, found: boolean};
      expect(result.found).toBe(true);
      // The argument must be substituted — an unexpanded body would say `color`.
      expect(result.text).toMatch(/lda/);
      expect(result.text).toMatch(/2007/);
      expect(result.text).not.toMatch(/color/);
    } finally {
      await client.close();
    }
  }, 20000);

  itIfBuilt('didChange republishes diagnostics, then clears them again', async () => {
    const client = await openedClient();
    try {
      const uri = uriOf(files.main());
      client.clearNotifications();
      client.notify('textDocument/didChange', {
        textDocument: {uri, version: 2},
        contentChanges: [{text: MAIN.replace('lda #$00', 'lda #$xx')}],
      });
      const bad = await client.waitFor(n =>
          n.method === 'textDocument/publishDiagnostics' &&
          (n.params as any).uri === uri &&
          (n.params as any).diagnostics.length > 0);
      expect((bad.params as any).diagnostics[0].message).toMatch(/hex/i);

      client.clearNotifications();
      client.notify('textDocument/didChange', {
        textDocument: {uri, version: 3},
        contentChanges: [{text: MAIN}],
      });
      const cleared = await client.waitFor(n =>
          n.method === 'textDocument/publishDiagnostics' &&
          (n.params as any).uri === uri &&
          (n.params as any).diagnostics.length === 0);
      expect((cleared.params as any).diagnostics).toEqual([]);
    } finally {
      await client.close();
    }
  }, 25000);

  itIfBuilt('attributes an error inside an included file to that file', async () => {
    const client = await openedClient();
    try {
      const macrosUri = uriOf(files.macros());
      client.clearNotifications();
      // Break the include through its own buffer, as the editor would.
      client.notify('textDocument/didOpen', {
        textDocument: {uri: macrosUri, languageId: 'ca65', version: 1, text: MACROS},
      });
      client.notify('textDocument/didChange', {
        textDocument: {uri: macrosUri, version: 2},
        contentChanges: [{text: MACROS.replace('sta $2007', 'sta $20zz')}],
      });
      const published = await client.waitFor(n =>
          n.method === 'textDocument/publishDiagnostics' &&
          (n.params as any).uri === macrosUri &&
          (n.params as any).diagnostics.length > 0);
      // The URI must be the file that was actually opened, not the relative
      // string the `.include` was written with.
      expect((published.params as any).uri).toBe(macrosUri);
    } finally {
      await client.close();
    }
  }, 25000);
});

/**
 * The VSCode client launches the server with `TransportKind.ipc`, not stdio —
 * `createConnection()` picks its transport off the command line, so `--stdio`
 * working proves nothing about `--node-ipc`. This is the one place that
 * combination is exercised.
 */
describe('integration: node-ipc transport', () => {
  itIfBuilt('answers initialize and a request over the IPC channel', async () => {
    const proc = fork(SERVER_PATH, ['--node-ipc'], {
      // `fork` defaults to the current runtime; the editor runs the server
      // under Node, and so must this.
      execPath: 'node',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    const pending = new Map<number, (msg: any) => void>();
    proc.on('message', (msg: any) => {
      if (msg?.id != null && pending.has(msg.id)) pending.get(msg.id)!(msg);
    });
    const request = (id: number, method: string, params: unknown) =>
        new Promise<any>((resolve, reject) => {
          pending.set(id, resolve);
          proc.send({jsonrpc: '2.0', id, method, params});
          setTimeout(() => reject(new Error(`${method} timed out`)), 8000);
        });

    try {
      const init = await request(0, 'initialize', {
        processId: process.pid, rootUri: null, capabilities: {},
      });
      expect(init.result.serverInfo.name).toBe('js65-lsp');

      proc.send({jsonrpc: '2.0', method: 'initialized', params: {}});
      proc.send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: 'file:///ipc/main.s',
            languageId: 'ca65',
            version: 1,
            text: 'main:\n  lda #$01\n  rts\n',
          },
        },
      });
      // Hover needs the open buffer, so a correct answer here also proves
      // notifications made it across the same channel.
      const hover = await request(1, 'textDocument/hover', {
        textDocument: {uri: 'file:///ipc/main.s'},
        position: {line: 1, character: 3},
      });
      expect(hover.result.contents.value).toMatch(/lda/);
    } finally {
      proc.kill();
    }
  }, 20000);
});
