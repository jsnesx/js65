// SPDX-License-Identifier: MPL-2.0


import type {WorkerPort} from '../../../src/worker/port.ts';
import type {Symbol} from '../../../src/assembler.ts';
import {Analyzer} from './analyzer.ts';
import {computeDefinition, computeDocumentSymbols, computeReferences,
        computeWorkspaceSymbols, projectForDoc} from './features/navigation.ts';
import {computeHover, expandMacroAt, type ExpandMacroParams} from './features/hover.ts';
import {computeCompletion} from './features/completion.ts';
import {computeFolding, computeSemanticTokens, type SymbolResolver}
    from './features/structure.ts';
import {LSP_PROTOCOL_VERSION, toLspError, type DiagnosticsNotification, type FeatureRequest,
        type LogNotification, type LspErrResponse, type LspOkResponse, type LspReq}
    from './protocol.ts';

export interface ServeOptions {
  debounceMs?: number;
  workspaceRoot?: string;
  errorLimit?: number;
}

function isRequest(message: unknown): message is LspReq {
  if (!message || typeof message !== 'object') return false;
  const {id, kind} = message as Partial<LspReq>;
  return typeof id === 'number' && typeof kind === 'string';
}

/** Serves LSP requests on `port` against a worker-resident analyzer. */
export function serveLspWorker(port: WorkerPort, opts: ServeOptions = {}): Analyzer {
  const analyzer = new Analyzer({
    workspaceRoot: opts.workspaceRoot ?? '/',
    debounceMs: opts.debounceMs ?? 200,
    errorLimit: opts.errorLimit,
    // No `fsImpl`: in a worker the pushed cache *is* the filesystem.
    onLog: (message) => {
      const note: LogNotification = {v: LSP_PROTOCOL_VERSION, kind: 'log', message};
      port.post(note);
    },
  });

  analyzer.onDiagnostics = (result) => {
    // `projects` holds live index objects that cannot be cloned, and the host has no use for
    // them: only the per-URI diagnostics and the touched set cross.
    const note: DiagnosticsNotification = {
      v: LSP_PROTOCOL_VERSION,
      kind: 'diagnostics',
      diagnostics: [...result.diagnostics].map(([uri, diags]) => [uri, [...diags]]),
      touchedUris: [...result.touchedUris],
    };
    port.post(note);
  };

  port.onMessage((message) => {
    if (!isRequest(message)) return;
    // The ping *is* the version check, so it answers whatever the host's version is
    if (message.v !== LSP_PROTOCOL_VERSION && message.kind !== 'ping') {
      respondErr(message.id, new Error(
          `Analyzer worker protocol version ${LSP_PROTOCOL_VERSION} does not match host ` +
          `${message.v}. The worker bundle is probably stale.`));
      return;
    }
    void handle(message);
  });

  async function handle(req: LspReq): Promise<void> {
    try {
      respondOk(req.id, await dispatch(req));
    } catch (err) {
      respondErr(req.id, err);
    }
  }

  async function dispatch(req: LspReq): Promise<unknown> {
    switch (req.kind) {
      case 'ping':
        return {v: LSP_PROTOCOL_VERSION};
      case 'project':
        analyzer.setWorkspaceRoot(req.workspaceRoot);
        analyzer.setProject(req.config);
        return null;
      case 'workspaceRoot':
        analyzer.setWorkspaceRoot(req.workspaceRoot);
        return null;
      case 'files':
        analyzer.setFiles(req.snapshot);
        return null;
      case 'fileDelta':
        analyzer.applyFileDelta(req.delta);
        return null;
      case 'doc':
        if (req.op === 'open') analyzer.open(req.uri, req.text ?? '', req.version);
        else if (req.op === 'change') analyzer.change(req.uri, req.text ?? '', req.version);
        else analyzer.close(req.uri);
        return null;
      case 'linkSaved': {
        const result = await analyzer.linkSaved(req.uri);
        // Same flattening as the unsolicited push: the live index cannot cross.
        return result
            ? {diagnostics: [...result.diagnostics].map(([uri, d]) => [uri, [...d]]),
               touchedUris: [...result.touchedUris]}
            : null;
      }
      case 'feature':
        return await feature(req);
      default:
        throw new Error(`Unknown request kind: ${(req as {kind: string}).kind}`);
    }
  }

  async function feature(req: FeatureRequest): Promise<unknown> {
    switch (req.method) {
      case 'textDocument/foldingRange': {
        const text = analyzer.peekDoc(uriOf(req.params));
        return text == null ? [] : computeFolding(text);
      }
      case 'textDocument/semanticTokens/full': {
        const uri = uriOf(req.params);
        const text = analyzer.peekDoc(uri);
        // Deliberately not awaiting `settled()` since highlighting has to repaint
        // on every keystroke, it reads whatever the last assemble left behind
        // and falls back to purely lexical classification until it finishes.
        return text == null
            ? {data: []}
            : computeSemanticTokens(text, symbolResolver(uri));
      }
      default:
        break;
    }

    await analyzer.settled();
    switch (req.method) {
      case 'textDocument/definition':
        return computeDefinition(analyzer, req.params as never);
      case 'textDocument/references':
        return computeReferences(analyzer, req.params as never);
      case 'textDocument/documentSymbol':
        return computeDocumentSymbols(analyzer, req.params as never);
      case 'workspace/symbol':
        return computeWorkspaceSymbols(analyzer, req.params as never);
      case 'textDocument/hover':
        return computeHover(analyzer, req.params as never) ?? undefined;
      case 'textDocument/completion':
        return computeCompletion(analyzer, req.params as never);
      case 'js65/expandMacro':
        return expandMacroAt(analyzer, req.params as ExpandMacroParams);
      default:
        throw new Error(`Unknown feature method: ${req.method}`);
    }
  }

  function symbolResolver(uri: string): SymbolResolver | undefined {
    const analysis = projectForDoc(analyzer, uri);
    if (!analysis) return undefined;
    const {index, macros, ramSegments} = analysis;
    const kinds = new Map<string, ReturnType<SymbolResolver['kindOf']>>();
    const scopes = new Set<string>();
    for (const scope of index.walk()) {
      if (scope.name) {
        scopes.add(scope.name);
        scopes.add(scope.qualifiedName);
      }
      for (const [name, sym] of scope.symbols) {
        // First writer wins so an outer scope doesn't mask an inner one's kind
        // for a name that exists in both.
        if (kinds.has(name)) continue;
        const kind = index.kindOf(sym);
        kinds.set(name, kind === 'label' && inRamSegment(sym) ? 'ramLabel' : kind);
      }
    }

    /** True if the symbol's chunk can only land in segments that emit no bytes. */
    function inRamSegment(sym: Symbol): boolean {
      if (!ramSegments.size) return false;
      const chunkIndex = sym.expr?.meta?.chunk;
      if (chunkIndex == null) return false;
      const moduleName = index.moduleOf(sym);
      if (moduleName == null) return false;
      const chunk = analysis!.modules.find(m => m.name === moduleName)
          ?.chunks?.[chunkIndex];
      // `segments` lists every segment the chunk *may* occupy, so it only names
      // RAM if every candidate does. A chunk free to land in ROM is code.
      return chunk != null && chunk.segments.length > 0 &&
          chunk.segments.every(s => ramSegments.has(s));
    }
    return {
      kindOf: (name) => kinds.get(name),
      isMacro: (name) => macros.get(name) != null,
      isScope: (name) => scopes.has(name),
    };
  }

  function uriOf(params: unknown): string {
    return (params as {textDocument: {uri: string}}).textDocument.uri;
  }

  function respondOk(id: number, value: unknown): void {
    const res: LspOkResponse = {v: LSP_PROTOCOL_VERSION, id, ok: true, value};
    port.post(res);
  }

  function respondErr(id: number, err: unknown): void {
    const res: LspErrResponse = {v: LSP_PROTOCOL_VERSION, id, ok: false, error: toLspError(err)};
    port.post(res);
  }

  return analyzer;
}
