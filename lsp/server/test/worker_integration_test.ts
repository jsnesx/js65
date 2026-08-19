// SPDX-License-Identifier: MPL-2.0

/**
 * The analyzer-in-a-worker split, end to end.
 *
 * Most cases drive a real spawned worker over the same protocol the server uses, because
 * "the JSON-RPC thread stays free" is only true if a thread boundary is actually there. The
 * file-cache cases use an in-process sink, where what matters is which paths get pushed.
 */

import {describe, it, expect} from 'bun:test';
import {Worker} from 'node:worker_threads';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import * as path from 'node:path';

import {nodeHostPort, type HostPort, type WorkerPort} from '../../../src/worker/port.ts';
import {LspWorkerClient, type AnalyzerDiagnostics} from '../workerclient.ts';
import {FileSync, type FileSink} from '../filesync.ts';
import {buildSnapshot, deltaForPath, watchedFilesGlob,
        isCachablePath} from '../filecachebuilder.ts';
import {FileCache, type FileDelta, type FileSnapshot} from '../worker/filecache.ts';
import {serveLspWorker} from '../worker/handler.ts';
import {LSP_PROTOCOL_VERSION} from '../worker/protocol.ts';
import {loadProject, findProjectFile, toPosix} from '../project.ts';
import {pathToUri} from '../convert.ts';

const WORKER_BUNDLE = path.resolve('build/js65-lsp-worker.cjs');
const haveWorker = existsSync(WORKER_BUNDLE);
const itIfBuilt = haveWorker ? it : it.skip;

/** A real spawned analyzer worker plus a client driving it. */
function spawnAnalyzer(debounceMs = 0) {
  const worker = new Worker(WORKER_BUNDLE, {workerData: {debounceMs}});
  const client = new LspWorkerClient(nodeHostPort(worker));
  return {client, worker};
}

/**
 * A pair of ports wired to each other, delivering on a microtask. Lets the real handler and
 * the real client run in one process, for the cases where no thread boundary is needed.
 */
function fakePortPair() {
  let hostHandler: ((m: unknown) => void) | undefined;
  let workerHandler: ((m: unknown) => void) | undefined;
  const sent: unknown[] = [];
  const hostToWorker: unknown[] = [];
  const workerPort: WorkerPort = {
    post(message) { sent.push(message); queueMicrotask(() => hostHandler?.(message)); },
    onMessage(handler) { workerHandler = handler; },
  };
  const hostPort: HostPort = {
    post(message) { hostToWorker.push(message); queueMicrotask(() => workerHandler?.(message)); },
    onMessage(handler) { hostHandler = handler; },
    terminate() {},
  };
  return {hostPort, workerPort, sent, hostToWorker};
}

/** The real worker handler and the real client, joined in process. */
function inProcessAnalyzer() {
  const pair = fakePortPair();
  serveLspWorker(pair.workerPort, {debounceMs: 0});
  return {...pair, client: new LspWorkerClient(pair.hostPort)};
}

/** Lets every queued microtask and timer callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** A diagnostic's message is either plain text or markup depending on the LSP version. */
function messageText(message: string | {value: string}): string {
  return typeof message === 'string' ? message : message.value;
}

/** Resolves on the first diagnostics push, so a test can await one analysis pass. */
function nextDiagnostics(client: LspWorkerClient): Promise<AnalyzerDiagnostics> {
  return new Promise((resolve) => { client.onDiagnostics = resolve; });
}

/** Write a small project to a temp dir and return everything a test needs to open it. */
function makeProject(extra: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'js65-worker-'));
  mkdirSync(path.join(root, 'inc'));
  writeFileSync(path.join(root, 'js65.json'), JSON.stringify({
    projects: [{name: 'main', sources: ['main.s'], includePaths: ['inc']}],
  }));
  writeFileSync(path.join(root, 'inc', 'defs.inc'), 'DEFINED_VALUE = $42\n');
  writeFileSync(path.join(root, 'main.s'),
                '.include "defs.inc"\nmain:\n  lda #DEFINED_VALUE\n  rts\n');
  for (const [rel, text] of Object.entries(extra)) {
    writeFileSync(path.join(root, rel), text);
  }
  return {root, mainPath: path.join(root, 'main.s'), cleanup: () => rmSync(root, {recursive: true, force: true})};
}

describe('analyzer worker', () => {
  itIfBuilt('publishes diagnostics matching an in-process analysis', async () => {
    const {root, mainPath, cleanup} = makeProject();
    const {client} = spawnAnalyzer();
    try {
      const config = loadProject(findProjectFile(mainPath)!);
      const sync = new FileSync(client);
      sync.loadProject(config, root);
      client.setProject(config, root);
      const pending = nextDiagnostics(client);
      // A deliberate error in the open buffer, so there is something to publish.
      client.open(pathToUri(mainPath), '.include "defs.inc"\nmain:\n  lda #$zz\n', 1);
      const result = await pending;
      const forMain = result.diagnostics.get(pathToUri(mainPath));
      expect(forMain?.length).toBeGreaterThan(0);
      expect(messageText(forMain![0].message)).toMatch(/hex/i);
    } finally {
      await client.terminate();
      cleanup();
    }
  }, 15000);

  itIfBuilt('answers a hover from the analyzer index across the boundary', async () => {
    const {root, mainPath, cleanup} = makeProject();
    const {client} = spawnAnalyzer();
    try {
      const config = loadProject(findProjectFile(mainPath)!);
      new FileSync(client).loadProject(config, root);
      client.setProject(config, root);
      const pending = nextDiagnostics(client);
      client.open(pathToUri(mainPath), '.include "defs.inc"\nmain:\n  lda #DEFINED_VALUE\n  rts\n', 1);
      await pending;
      // `main` on its definition line: the index has to have survived the trip.
      const hover = await client.request<{contents: {value: string}} | undefined>(
          'textDocument/hover',
          {textDocument: {uri: pathToUri(mainPath)}, position: {line: 1, character: 1}});
      expect(hover).toBeDefined();
      expect(hover!.contents.value).toContain('**segment:** (none)');
      expect(hover!.contents.value).toContain('**reloc:** offset');
    } finally {
      await client.terminate();
      cleanup();
    }
  }, 15000);

  itIfBuilt('lets an open buffer win over the copy on disk', async () => {
    // The disk copy defines the symbol; the mirrored buffer removes it. If the analysis used
    // the buffer, the reference goes undefined and something gets reported.
    const {root, mainPath, cleanup} = makeProject();
    const {client} = spawnAnalyzer();
    try {
      const config = loadProject(findProjectFile(mainPath)!);
      new FileSync(client).loadProject(config, root);
      client.setProject(config, root);
      const pending = nextDiagnostics(client);
      client.open(pathToUri(mainPath), 'main:\n  lda #DEFINED_VALUE\n  rts\n', 1);
      const result = await pending;
      const forMain = result.diagnostics.get(pathToUri(mainPath)) ?? [];
      expect(forMain.some(d => /DEFINED_VALUE/.test(messageText(d.message)))).toBe(true);
    } finally {
      await client.terminate();
      cleanup();
    }
  }, 15000);

  // The behavior this whole effort exists for: while the worker is inside a synchronous
  // assemble, the host thread is free, so a request that does not need the index comes back
  // before the assemble does.
  itIfBuilt('answers folding while a long assemble is in flight', async () => {
    const {root, mainPath, cleanup} = makeProject();
    const {client} = spawnAnalyzer();
    try {
      const config = loadProject(findProjectFile(mainPath)!);
      new FileSync(client).loadProject(config, root);
      client.setProject(config, root);
      // Big enough that the assemble is unambiguously still running when folding answers.
      const huge = 'main:\n' + '  lda #$01\n'.repeat(120000) + '.proc Foo\n  rts\n.endproc\n';
      let assembleDone = false;
      const analysis = nextDiagnostics(client).then((r) => { assembleDone = true; return r; });
      client.open(pathToUri(mainPath), huge, 1);
      const folding = await client.request<unknown[]>(
          'textDocument/foldingRange', {textDocument: {uri: pathToUri(mainPath)}});
      expect(Array.isArray(folding)).toBe(true);
      expect(assembleDone).toBe(false);
      await analysis;
    } finally {
      await client.terminate();
      cleanup();
    }
  }, 30000);

  itIfBuilt('collapses a burst of rapid edits into one analysis pass', async () => {
    const {root, mainPath, cleanup} = makeProject();
    const {client} = spawnAnalyzer(80);
    try {
      const config = loadProject(findProjectFile(mainPath)!);
      new FileSync(client).loadProject(config, root);
      client.setProject(config, root);
      let passes = 0;
      client.onDiagnostics = () => { passes++; };
      client.open(pathToUri(mainPath), 'main:\n  rts\n', 1);
      for (let i = 0; i < 8; i++) {
        client.change(pathToUri(mainPath), `main:\n  lda #$0${i}\n  rts\n`, i + 2);
      }
      await new Promise((r) => setTimeout(r, 1200));
      // The open starts one pass; the burst behind it debounces into a single second one.
      expect(passes).toBeLessThanOrEqual(2);
      expect(passes).toBeGreaterThan(0);
    } finally {
      await client.terminate();
      cleanup();
    }
  }, 15000);

  itIfBuilt('rejects in-flight requests when the worker is terminated', async () => {
    const {client} = spawnAnalyzer();
    await client.ready();
    const pending = client.request('textDocument/hover', {
      textDocument: {uri: 'file:///nope.s'}, position: {line: 0, character: 0},
    });
    await client.terminate();
    await expect(pending).rejects.toThrow(/terminated/);
  }, 15000);
});

describe('analyzer worker client', () => {
  // A workspace with no `js65.json` never sends a project, and the project message used to
  // be the only thing carrying the root. Standalone include paths are the file's own
  // directory plus the workspace root, so without the root the second one was `/`.
  it('resolves a standalone include through the workspace root when no project is sent', async () => {
    const {client} = inProcessAnalyzer();
    const uri = pathToUri('/proj/src/main.s');
    try {
      client.setWorkspaceRoot('/proj');
      client.setFiles(new Map([['/proj/shared.inc', 'SHARED = $42\n']]));
      const pending = nextDiagnostics(client);
      client.open(uri, '.include "shared.inc"\nmain:\n  lda #SHARED\n  rts\n', 1);
      const result = await pending;
      const diags = result.diagnostics.get(uri) ?? [];
      expect(diags.map(d => messageText(d.message)).filter(m => /could not find/i.test(m)))
          .toEqual([]);
    } finally {
      await client.terminate();
    }
  });

  it('cannot find that include when the host never sends a root', async () => {
    // The other half of the case above: the include only resolves because of the root, so
    // the test above would pass for the wrong reason if this one did not fail.
    const {client} = inProcessAnalyzer();
    const uri = pathToUri('/proj/src/main.s');
    try {
      client.setFiles(new Map([['/proj/shared.inc', 'SHARED = $42\n']]));
      const pending = nextDiagnostics(client);
      client.open(uri, '.include "shared.inc"\nmain:\n  lda #SHARED\n  rts\n', 1);
      const result = await pending;
      const diags = result.diagnostics.get(uri) ?? [];
      expect(diags.some(d => /could not find/i.test(messageText(d.message)))).toBe(true);
    } finally {
      await client.terminate();
    }
  });

  it('errors a request from a host on another protocol version rather than hanging', async () => {
    // A stale worker bundle. The version gate used to drop the message silently, so the
    // request sat unanswered forever instead of surfacing the mismatch.
    const pair = fakePortPair();
    serveLspWorker(pair.workerPort, {debounceMs: 0});
    const skewed: HostPort = {
      post: (m) => pair.hostPort.post({...(m as object), v: LSP_PROTOCOL_VERSION + 1}),
      onMessage: (h) => pair.hostPort.onMessage(h),
      terminate: () => pair.hostPort.terminate(),
    };
    const client = new LspWorkerClient(skewed);
    const request = client.request('textDocument/hover', {
      textDocument: {uri: pathToUri('/proj/main.s')}, position: {line: 0, character: 0},
    });
    await expect(request).rejects.toThrow(/does not match host/);
  });

  it('still answers a ping from a host on another protocol version', async () => {
    // The ping is the version check itself, so it has to get through the gate that the
    // check exists to trip.
    const pair = fakePortPair();
    serveLspWorker(pair.workerPort, {debounceMs: 0});
    pair.hostPort.post({v: LSP_PROTOCOL_VERSION + 1, id: 1, kind: 'ping'});
    await settle();
    const res = pair.sent.find((m) => (m as {id?: number}).id === 1) as
        {ok: boolean, value: {v: number}} | undefined;
    expect(res).toMatchObject({ok: true});
    expect(res!.value.v).toBe(LSP_PROTOCOL_VERSION);
  });

  it('logs a dropped doc sync after the worker failed instead of rejecting unhandled', async () => {
    // `open`/`change`/`setFiles` are fire and forget. Once the handshake has failed every
    // one of them rejects, and an unhandled rejection takes the whole server process down.
    const pair = fakePortPair();
    pair.workerPort.onMessage((message) => {
      const req = message as {id: number, kind: string};
      if (req.kind !== 'ping') return;
      // A worker built against an older protocol still answers, just with the wrong v.
      pair.workerPort.post({v: LSP_PROTOCOL_VERSION, id: req.id, ok: true, value: {v: 99}});
    });
    const client = new LspWorkerClient(pair.hostPort);
    const logs: string[] = [];
    client.onLog = (m) => logs.push(m);
    await expect(client.ready()).rejects.toThrow(/does not match host/);

    const unhandled: unknown[] = [];
    const record = (err: unknown) => { unhandled.push(err); };
    process.on('unhandledRejection', record);
    try {
      client.open(pathToUri('/proj/main.s'), 'main:\n  rts\n', 1);
      client.setFiles(new Map());
      await settle();
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
    expect(logs.some(l => /dropped doc/.test(l))).toBe(true);
    expect(logs.some(l => /dropped files/.test(l))).toBe(true);
  });
});

describe('lsp file cache', () => {
  /** Records what the host pushed, standing in for the worker. */
  function recordingSink() {
    const cache = new FileCache();
    const snapshots: FileSnapshot[] = [];
    const deltas: FileDelta[] = [];
    const sink: FileSink = {
      setFiles: (s) => { snapshots.push(s); cache.reset(s); },
      applyFileDelta: (d) => { deltas.push(d); cache.apply(d); },
    };
    return {sink, cache, snapshots, deltas};
  }

  it('snapshots the sources, the include directory and the project file', () => {
    const {root, cleanup} = makeProject();
    try {
      const config = loadProject(findProjectFile(path.join(root, 'main.s'))!);
      const snapshot = buildSnapshot(config);
      expect(snapshot.has(toPosix(path.join(root, 'main.s')))).toBe(true);
      expect(snapshot.has(toPosix(path.join(root, 'inc', 'defs.inc')))).toBe(true);
      expect(snapshot.has(toPosix(path.join(root, 'js65.json')))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('pushes only the edited entry, not the whole project', () => {
    const {root, cleanup} = makeProject({
      'extra1.inc': 'A = 1\n', 'extra2.inc': 'B = 2\n', 'extra3.inc': 'C = 3\n',
    });
    try {
      const {sink, snapshots, deltas} = recordingSink();
      const config = loadProject(findProjectFile(path.join(root, 'main.s'))!);
      const sync = new FileSync(sink);
      sync.loadProject(config, root);
      expect(snapshots.length).toBe(1);
      expect(deltas.length).toBe(0);

      const edited = path.join(root, 'inc', 'defs.inc');
      writeFileSync(edited, 'DEFINED_VALUE = $99\n');
      sync.push(edited);
      expect(deltas.length).toBe(1);
      expect([...deltas[0].upserts.keys()]).toEqual([toPosix(edited)]);
    } finally {
      cleanup();
    }
  });

  it('turns a deleted file into a delete rather than a stale entry', () => {
    const {root, cleanup} = makeProject();
    try {
      const gone = path.join(root, 'inc', 'never-existed.inc');
      const delta = deltaForPath(gone);
      expect(delta.upserts.size).toBe(0);
      expect(delta.deletes).toEqual([toPosix(gone)]);
    } finally {
      cleanup();
    }
  });

  it('lets a mirrored buffer shadow the disk entry, and reverts when it closes', () => {
    const cache = new FileCache();
    cache.reset(new Map([['/proj/a.s', 'on disk\n']]));
    expect(cache.get('/proj/a.s')).toBe('on disk\n');
    cache.openBuffer('/proj/a.s', 'in editor\n');
    expect(cache.get('/proj/a.s')).toBe('in editor\n');
    cache.closeBuffer('/proj/a.s');
    expect(cache.get('/proj/a.s')).toBe('on disk\n');
  });

  it('resolves includes out of the cache and records what it touched', () => {
    const cache = new FileCache();
    cache.reset(new Map<string, string | Uint8Array>([
      ['/proj/inc/defs.inc', 'X = 1\n'],
      ['/proj/data/blob.bin', new Uint8Array([7, 8])],
    ]));
    const touched = new Set<string>();
    const cb = cache.callbacks(touched);
    expect(cb.resolveText(['/proj/other', '/proj/inc'], 'defs.inc'))
        .toEqual({baseIndex: 1, content: 'X = 1\n'});
    expect(cb.resolveText(['/proj/inc'], 'missing.inc')).toBeUndefined();
    const bin = cb.resolveBinary(['/proj/data'], 'blob.bin');
    expect(Array.from(bin!.content as Uint8Array)).toEqual([7, 8]);
    // Only successful reads are recorded: that set is what drives include-graph invalidation.
    expect([...touched].sort()).toEqual(['/proj/data/blob.bin', '/proj/inc/defs.inc']);
  });

  it('watches every file, since an extension does not say what a source is', () => {
    expect(watchedFilesGlob()).toBe('**/*');
  });

  it('snapshots files with any extension and none at all, skipping dot entries', () => {
    const {root, cleanup} = makeProject({
      'inc/noext': 'A = 1\n',
      'inc/weird.6502': 'B = 2\n',
      'inc/.hidden.inc': 'C = 3\n',
    });
    try {
      mkdirSync(path.join(root, 'inc', '.git'));
      writeFileSync(path.join(root, 'inc', '.git', 'config.inc'), 'D = 4\n');
      const config = loadProject(findProjectFile(path.join(root, 'main.s'))!);
      const snapshot = buildSnapshot(config);
      expect(snapshot.has(toPosix(path.join(root, 'inc', 'noext')))).toBe(true);
      expect(snapshot.has(toPosix(path.join(root, 'inc', 'weird.6502')))).toBe(true);
      expect(snapshot.has(toPosix(path.join(root, 'inc', '.hidden.inc')))).toBe(false);
      expect(snapshot.has(toPosix(path.join(root, 'inc', '.git', 'config.inc')))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('leaves dependency and output trees out of the scan and the watcher', () => {
    const {root, cleanup} = makeProject();
    try {
      mkdirSync(path.join(root, 'inc', 'node_modules'));
      writeFileSync(path.join(root, 'inc', 'node_modules', 'dep.inc'), 'E = 5\n');
      const config = loadProject(findProjectFile(path.join(root, 'main.s'))!);
      const snapshot = buildSnapshot(config);
      expect(snapshot.has(toPosix(path.join(root, 'inc', 'node_modules', 'dep.inc')))).toBe(false);

      expect(isCachablePath('/proj/inc/defs.inc')).toBe(true);
      expect(isCachablePath('/proj/inc/noext')).toBe(true);
      expect(isCachablePath('/proj/node_modules/x/y.inc')).toBe(false);
      expect(isCachablePath('/proj/.git/config')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('ignores a watched change under a skipped tree, but can still evict a tracked one', () => {
    const {root, cleanup} = makeProject();
    try {
      const {sink, deltas} = recordingSink();
      const config = loadProject(findProjectFile(path.join(root, 'main.s'))!);
      const sync = new FileSync(sink);
      sync.loadProject(config, root);

      mkdirSync(path.join(root, 'node_modules'));
      const dep = path.join(root, 'node_modules', 'dep.inc');
      writeFileSync(dep, 'E = 5\n');
      sync.push(dep);
      expect(deltas.length).toBe(0);

      // A file that did make it into the cache still evicts when it disappears.
      const tracked = path.join(root, 'inc', 'defs.inc');
      rmSync(tracked);
      sync.push(tracked);
      expect(deltas.at(-1)?.deletes).toEqual([toPosix(tracked)]);
    } finally {
      cleanup();
    }
  });

  it('reads every entry as bytes and decodes only when text is asked for', () => {
    const {root, cleanup} = makeProject();
    try {
      const source = path.join(root, 'inc', 'defs.inc');
      const snapshot = buildSnapshot(undefined, [source]);
      expect(snapshot.get(toPosix(source))).toBeInstanceOf(Uint8Array);

      const cache = new FileCache();
      cache.reset(snapshot);
      expect(cache.callbacks(new Set()).resolveText([path.posix.join(toPosix(root), 'inc')],
                                                    'defs.inc')?.content)
          .toBe('DEFINED_VALUE = $42\n');
    } finally {
      cleanup();
    }
  });
});
