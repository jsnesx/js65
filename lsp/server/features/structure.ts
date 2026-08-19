// SPDX-License-Identifier: MPL-2.0

import type {Connection} from 'vscode-languageserver/node';
import type {FoldingRange, SemanticTokens} from 'vscode-languageserver-protocol';

import type {LspWorkerClient} from '../workerclient.ts';

export {SEMANTIC_TOKEN_LEGEND} from '../worker/features/structure.ts';

export function registerStructureFeatures(connection: Connection,
                                          client: LspWorkerClient): void {
  connection.onFoldingRanges((p) =>
      client.request<FoldingRange[]>('textDocument/foldingRange', p));

  connection.languages.semanticTokens.on((p) =>
      client.request<SemanticTokens>('textDocument/semanticTokens/full', p));
}
