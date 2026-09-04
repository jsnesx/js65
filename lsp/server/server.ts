// SPDX-License-Identifier: MPL-2.0

import {createConnection, TextDocuments, TextDocumentSyncKind} from 'vscode-languageserver/node';
import {TextDocument} from 'vscode-languageserver-textdocument';
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
  WorkspaceFolder,
  ClientCapabilities,
} from 'vscode-languageserver-protocol';
import {
  CodeActionKind,
  DidChangeWatchedFilesNotification,
} from 'vscode-languageserver-protocol';
import {URI} from 'vscode-uri';

import {findProjectFile, loadProject} from './project.ts';
import {LspWorkerClient, type AnalyzerDiagnostics,
        type InactiveRegionsForUri} from './workerclient.ts';
import {spawnAnalyzerWorker} from './spawnworker.ts';
import {FileSync} from './filesync.ts';
import {watchedFilesGlob} from './filecachebuilder.ts';
import {jsModuleSourceOf, uriToPath} from './convert.ts';
import {jsModuleMap} from '../../src/jsmodule/index.ts';
import {sourceContent} from '../../src/jsmodule/sourcemap.ts';
import {registerNavigationFeatures} from './features/navigation.ts';
import {registerHoverFeatures} from './features/hover.ts';
import {registerCompletionFeatures} from './features/completion.ts';
import {registerStructureFeatures, SEMANTIC_TOKEN_LEGEND} from './features/structure.ts';
import {registerCodeActionFeatures} from './features/codeactions.ts';

export interface ServerOptions {
  /** Debounce window passed to the analyzer. */
  debounceMs?: number;
  client?: LspWorkerClient;
}

export async function main(opts: ServerOptions = {}): Promise<void> {
  const connection = createConnection();
  const documents = new TextDocuments(TextDocument);
  documents.listen(connection);

  // Workspace root fallback: first workspace folder if any, else CWD.
  let workspaceRoot = process.cwd();
  let workspaceFolders: WorkspaceFolder[] = [];
  let clientCapabilities: ClientCapabilities | undefined;

  // The analyzer runs in a worker and the sync core blocks whatever thread it is on
  // This thread has to keep answering JSON-RPC while a large project assembles.
  const analyzer = opts.client ??
      new LspWorkerClient(spawnAnalyzerWorker({
        debounceMs: opts.debounceMs ?? 200,
        // Replaced by the real root at `initialize`; until then match this thread's guess.
        workspaceRoot,
      }));
  // All analyzer logging goes through the connection's console, which frames
  // output as `window/logMessage`. Writing to stdout directly would corrupt
  // the JSON-RPC stream this server speaks.
  analyzer.onLog = (msg) => connection.console.error(msg);

  const files = new FileSync(analyzer);
  /** Whether a `js65.json` has been located and pushed, so we only discover once. */
  let projectLoaded = false;

  // Track the URIs we last published diagnostics for, so files that no longer
  // have errors get an explicit empty publish (LSP requires this to clear
  // squiggles left over from a previous run).
  let lastPublishedUris = new Set<string>();
  // Open documents we have already told the client are clean.
  const declaredClean = new Set<string>();

  // URIs we last sent dimming for, so a file whose `.if` went live gets an
  // explicit empty push instead of keeping stale grey text.
  let lastDimmedUris = new Set<string>();

  analyzer.onInactiveRegions = (regions: InactiveRegionsForUri[]) => {
    const nextUris = new Set<string>();
    for (const {uri, spans} of regions) {
      if (spans.length) nextUris.add(uri);
      connection.sendNotification('js65/inactiveRegions', {uri, regions: spans});
    }
    for (const uri of lastDimmedUris) {
      if (nextUris.has(uri)) continue;
      connection.sendNotification('js65/inactiveRegions', {uri, regions: []});
    }
    lastDimmedUris = nextUris;
  };

  analyzer.onDiagnostics = (result: AnalyzerDiagnostics) => {
    const nextUris = new Set<string>();
    for (const [uri, diags] of result.diagnostics) {
      if (!diags.length) continue; // handled by the clean pass below
      nextUris.add(uri);
      declaredClean.delete(uri);
      connection.sendDiagnostics({uri, diagnostics: diags});
    }
    // Anything that had diagnostics last time but didn't this time gets an
    // explicit clear. Also clear any "touched" URIs (still in the project,
    // just no diagnostics anymore).
    for (const uri of lastPublishedUris) {
      if (!nextUris.has(uri)) {
        connection.sendDiagnostics({uri, diagnostics: []});
        declaredClean.add(uri);
      }
    }
    // Every open document that came out of this pass with nothing to report
    // gets one explicit empty publish.
    for (const doc of documents.all()) {
      if (nextUris.has(doc.uri) || declaredClean.has(doc.uri)) continue;
      connection.sendDiagnostics({uri: doc.uri, diagnostics: []});
      declaredClean.add(doc.uri);
    }
    lastPublishedUris = nextUris;
  };

  connection.onInitialize((params: InitializeParams) => {
    workspaceFolders = params.workspaceFolders ?? [];
    clientCapabilities = params.capabilities;
    if (workspaceFolders.length) {
      workspaceRoot = URI.parse(workspaceFolders[0].uri).fsPath;
    } else if (params.rootUri) {
      workspaceRoot = URI.parse(params.rootUri).fsPath;
    } else if (params.rootPath) {
      workspaceRoot = params.rootPath;
    }
    // The project only reaches the worker when a `js65.json` turns up, but standalone files
    // resolve includes against the root too, so it has to go over on its own.
    analyzer.setWorkspaceRoot(workspaceRoot);

    const capabilities: ServerCapabilities = {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: {includeText: false},
      },
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      hoverProvider: true,
      completionProvider: {triggerCharacters: ['.', ':']},
      codeActionProvider: {codeActionKinds: [CodeActionKind.QuickFix]},
      foldingRangeProvider: true,
      semanticTokensProvider: {
        legend: SEMANTIC_TOKEN_LEGEND,
        full: true,
      },
    };

    const result: InitializeResult = {
      capabilities,
      serverInfo: {name: 'js65-lsp', version: '0.1.0'},
    };
    return result;
  });

  connection.onInitialized(() => {
    // Discover the project from the first workspace folder, if any.
    if (workspaceFolders.length) {
      const root = URI.parse(workspaceFolders[0].uri).fsPath;
      const pf = findProjectFile(root);
      if (pf) {
        try {
          const config = loadProject(pf);
          // Populate the cache before the project lands, or the analysis pass `setProject`
          // schedules would run against an empty map.
          files.loadProject(config, workspaceRoot);
          analyzer.setProject(config, workspaceRoot);
          projectLoaded = true;
        } catch (err) {
          connection.window.showErrorMessage(
              `js65-lsp: failed to load ${pf}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Watch the project file so a config edit re-loads the project.
    if (clientCapabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
      // Also watch the source and include extensions: a file changed outside the editor has
      // to invalidate its cache entry, or the eager scan goes stale and the worker keeps
      // assembling the old text.
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{globPattern: '**/js65.json'}, {globPattern: watchedFilesGlob()}],
      });
    }
  });

  // Serves the original source behind a `js65-jsmodule:` link in a diagnostic.
  // The text is the `sourcesContent` of the module's own map, so a build that
  // ships no maps answers `found: false` rather than an empty document.
  connection.onRequest('js65/jsmoduleSource', (params: {uri: string}) => {
    const target = jsModuleSourceOf(params.uri);
    const text = target && sourceContent(jsModuleMap(target.module), target.source);
    return text == null ? {text: '', found: false} : {text, found: true};
  });

  connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
      const p = uriToPath(change.uri);
      if (!p.endsWith('js65.json')) {
        // An ordinary file edited outside the editor. Re-read just that entry; an open
        // buffer for it still wins, so this only affects files nobody has open.
        files.push(p);
        continue;
      }
      const pf = findProjectFile(p);
      if (!pf) continue;
      try {
        const config = loadProject(pf);
        files.loadProject(config, workspaceRoot);
        analyzer.setProject(config, workspaceRoot);
        projectLoaded = true;
        connection.window.showInformationMessage('js65-lsp: reloaded js65.json');
      } catch (err) {
        connection.window.showErrorMessage(
            `js65-lsp: failed to reload ${pf}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  documents.onDidOpen((event) => {
    const opened = uriToPath(event.document.uri);
    // Discovery is host-side, so a document that belongs to a `js65.json` we have not loaded
    // yet gets its project (and its files) here rather than through the analyzer's own lazy
    // lookup, which would find the project but not the cache entries it needs.
    if (!projectLoaded) {
      const pf = findProjectFile(opened);
      if (pf) {
        try {
          const config = loadProject(pf);
          files.loadProject(config, workspaceRoot);
          analyzer.setProject(config, workspaceRoot);
          projectLoaded = true;
        } catch (err) {
          connection.console.error(
              `js65-lsp: failed to load ${pf}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // A file outside any `js65.json` still resolves includes against its own directory and
    // the workspace root, so make sure those are in the cache before the pass runs.
    files.ensureStandalone(opened, workspaceRoot);
    analyzer.open(event.document.uri, event.document.getText(), event.document.version);
  });
  documents.onDidChangeContent((event) => {
    analyzer.change(event.document.uri, event.document.getText(), event.document.version);
  });
  documents.onDidClose((event) => {
    analyzer.close(event.document.uri);
    declaredClean.delete(event.document.uri);
  });
  documents.onDidSave((event) => {
    void analyzer.linkSaved(event.document.uri).catch(err => {
      connection.console.error(
          `js65-lsp: link failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // Register feature handlers (navigation, hover, etc). Each gets the connection and the
  // worker client, and forwards its requests over the port.
  registerNavigationFeatures(connection, analyzer);
  registerHoverFeatures(connection, analyzer);
  registerCompletionFeatures(connection, analyzer);
  registerStructureFeatures(connection, analyzer);
  // Code actions are computed from the diagnostic the client hands back, so they need no
  // analyzer at all and stay on this thread.
  registerCodeActionFeatures(connection);

  connection.listen();
  // Process runs until the editor disconnects and the process is killed.
}
