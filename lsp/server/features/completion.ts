// SPDX-License-Identifier: MPL-2.0


import type {Connection} from 'vscode-languageserver/node';
import type {CompletionItem} from 'vscode-languageserver-protocol';

import type {LspWorkerClient} from '../workerclient.ts';

export function registerCompletionFeatures(connection: Connection,
                                           client: LspWorkerClient): void {
  connection.onCompletion((p) =>
      client.request<CompletionItem[]>('textDocument/completion', p));
}
