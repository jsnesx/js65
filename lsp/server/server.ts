// SPDX-License-Identifier: MPL-2.0

/**
 * LSP connection wiring. Intentionally thin: the analyzer + feature modules
 * do the real work so they can be tested without spinning up a JSON-RPC
 * connection. This file owns capability negotiation, document sync, project
 * discovery, and routing requests/responses to feature handlers.
 */

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

import {Analyzer, type AnalysisResult} from './analyzer.ts';
import {findProjectFile, loadProject} from './project.ts';
import {uriToPath} from './convert.ts';
import {registerNavigationFeatures} from './features/navigation.ts';
import {registerHoverFeatures} from './features/hover.ts';
import {registerCompletionFeatures} from './features/completion.ts';
import {registerStructureFeatures, SEMANTIC_TOKEN_LEGEND} from './features/structure.ts';
import {registerCodeActionFeatures} from './features/codeactions.ts';

export interface ServerOptions {
  /** Debounce window passed to the analyzer. */
  debounceMs?: number;
}

export async function main(opts: ServerOptions = {}): Promise<void> {
  const connection = createConnection();
  const documents = new TextDocuments(TextDocument);
  documents.listen(connection);

  // Workspace root fallback: first workspace folder if any, else CWD.
  let workspaceRoot = process.cwd();
  let workspaceFolders: WorkspaceFolder[] = [];
  let clientCapabilities: ClientCapabilities | undefined;

  const analyzer = new Analyzer({
    workspaceRoot,
    debounceMs: opts.debounceMs ?? 200,
    // All analyzer logging goes through the connection's console, which frames
    // output as `window/logMessage`. Writing to stdout directly would corrupt
    // the JSON-RPC stream this server speaks.
    onLog: (msg) => connection.console.error(msg),
  });

  // Track the URIs we last published diagnostics for, so files that no longer
  // have errors get an explicit empty publish (LSP requires this to clear
  // squiggles left over from a previous run).
  let lastPublishedUris = new Set<string>();
  // Open documents we have already told the client are clean.
  const declaredClean = new Set<string>();

  analyzer.onDiagnostics = (result: AnalysisResult) => {
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
          analyzer.setProject(loadProject(pf));
        } catch (err) {
          connection.window.showErrorMessage(
              `js65-lsp: failed to load ${pf}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Watch the project file so a config edit re-loads the project.
    if (clientCapabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [{globPattern: '**/js65.json'}],
      });
    }
  });

  connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
      const p = uriToPath(change.uri);
      if (p.endsWith('js65.json')) {
        const pf = findProjectFile(p);
        if (pf) {
          try {
            analyzer.setProject(loadProject(pf));
            connection.window.showInformationMessage('js65-lsp: reloaded js65.json');
          } catch (err) {
            connection.window.showErrorMessage(
                `js65-lsp: failed to reload ${pf}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  });

  documents.onDidOpen((event) => {
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

  // Register feature handlers (navigation, hover, etc). Each gets the analyzer
  // and the connection, and returns an unsubscribe for tests.
  registerNavigationFeatures(connection, analyzer);
  registerHoverFeatures(connection, analyzer);
  registerCompletionFeatures(connection, analyzer);
  registerStructureFeatures(connection, analyzer);
  registerCodeActionFeatures(connection);

  connection.listen();
  // Process runs until the editor disconnects and the process is killed.
}
