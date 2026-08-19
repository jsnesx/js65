// SPDX-License-Identifier: MPL-2.0

import type {Connection} from 'vscode-languageserver/node';
import type {
  Definition,
  DocumentSymbol,
  Location,
  SymbolInformation,
} from 'vscode-languageserver-protocol';

import type {LspWorkerClient} from '../workerclient.ts';

export function registerNavigationFeatures(connection: Connection,
                                           client: LspWorkerClient): void {
  // The worker awaits `settled()` before answering any of these: a half-built index reports
  // nothing for a symbol that resolves perfectly well, and clients cache that empty result
  // against the document version. Waiting happens over there, so this thread stays free.
  connection.onDefinition((p) =>
      client.request<Definition>('textDocument/definition', p));

  connection.onReferences((p) =>
      client.request<Location[]>('textDocument/references', p));

  connection.onDocumentSymbol((p) =>
      client.request<DocumentSymbol[]>('textDocument/documentSymbol', p));

  connection.onWorkspaceSymbol((p) =>
      client.request<SymbolInformation[]>('workspace/symbol', p));
}
