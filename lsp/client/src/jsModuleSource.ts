// SPDX-License-Identifier: MPL-2.0

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/** URI scheme for a jsmodule's original source, matching the server's. */
export const JSMODULE_SCHEME = 'js65-jsmodule';

/** Result of `js65/jsmoduleSource`. */
interface JsModuleSourceResult {
    text: string;
    found: boolean;
}

class JsModuleSourceProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly getClient: () => LanguageClient | undefined) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const client = this.getClient();
        if (!client) return '// js65: language server is not running.\n';
        let result: JsModuleSourceResult;
        try {
            result = await client.sendRequest<JsModuleSourceResult>(
                'js65/jsmoduleSource', { uri: uri.toString() });
        } catch (err) {
            return `// js65: ${err instanceof Error ? err.message : String(err)}\n`;
        }
        if (!result?.found) {
            return `// js65: no source map for ${uri.path.replace(/^\//, '')}.\n` +
                '// This build of js65 ships its jsmodules without source maps.\n';
        }
        return result.text;
    }
}

export function registerJsModuleSource(
    context: vscode.ExtensionContext,
    getClient: () => LanguageClient | undefined,
): void {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            JSMODULE_SCHEME, new JsModuleSourceProvider(getClient)),
    );
}
