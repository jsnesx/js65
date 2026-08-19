// SPDX-License-Identifier: MPL-2.0


import type {Connection} from 'vscode-languageserver/node';
import type {Hover} from 'vscode-languageserver-protocol';

import type {LspWorkerClient} from '../workerclient.ts';
import type {ExpandMacroParams, ExpandMacroResult} from '../worker/features/hover.ts';

export type {ExpandMacroParams, ExpandMacroResult};

export function registerHoverFeatures(connection: Connection, client: LspWorkerClient): void {
  connection.onHover((p) =>
      client.request<Hover | undefined>('textDocument/hover', p));

  // Custom request: full recursive macro expansion as text. The LSP
  // `connection.onRequest` strap accepts a string method name for non-standard
  // requests, hence the cast through `any`.
  (connection as any).onRequest('js65/expandMacro',
      (p: ExpandMacroParams): Promise<ExpandMacroResult> =>
          client.request<ExpandMacroResult>('js65/expandMacro', p));
}
