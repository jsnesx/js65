// SPDX-License-Identifier: MPL-2.0

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/** URI scheme for rendered expansions. */
export const EXPANSION_SCHEME = 'js65-expansion';

/** Params for `js65/expandMacro`, matching the server's `ExpandMacroParams`. */
interface ExpandMacroParams {
	uri: string;
	position: { line: number; character: number };
}

/** Result of `js65/expandMacro`, matching the server's `ExpandMacroResult`. */
interface ExpandMacroResult {
	text: string;
	found: boolean;
}

class ExpansionProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '; (no expansion)';
	}

	set(uri: vscode.Uri, text: string): void {
		this.contents.set(uri.toString(), text);
		this.emitter.fire(uri);
	}

	dispose(): void {
		this.emitter.dispose();
		this.contents.clear();
	}
}

export function registerMacroExpansion(
	context: vscode.ExtensionContext,
	getClient: () => LanguageClient | undefined,
): void {
	const provider = new ExpansionProvider();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(EXPANSION_SCHEME, provider),
		provider,
		vscode.commands.registerCommand('js65.expandMacro', async () => {
			const client = getClient();
			if (!client) {
				void vscode.window.showWarningMessage('js65: language server is not running.');
				return;
			}
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'js65') {
				void vscode.window.showWarningMessage('js65: open a js65 file and put the cursor on a macro.');
				return;
			}

			const position = editor.selection.active;
			const params: ExpandMacroParams = {
				uri: editor.document.uri.toString(),
				position: { line: position.line, character: position.character },
			};

			let result: ExpandMacroResult;
			try {
				result = await client.sendRequest<ExpandMacroResult>('js65/expandMacro', params);
			} catch (err) {
				void vscode.window.showErrorMessage(
					`js65: macro expansion failed: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}

			if (!result?.found) {
				void vscode.window.showInformationMessage(
					'js65: no macro or define at the cursor.');
				return;
			}

			// Name the virtual document after the word under the cursor so the
			// tab title says which macro is being shown.
			const wordRange = editor.document.getWordRangeAtPosition(position, /[A-Za-z0-9_.]+/);
			const name = wordRange ? editor.document.getText(wordRange) : 'expansion';
			const uri = vscode.Uri.parse(`${EXPANSION_SCHEME}:${name}.s`);
			provider.set(uri, header(name, editor.document.uri, position) + result.text + '\n');

			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.languages.setTextDocumentLanguage(doc, 'js65');
			await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.Beside,
				preview: true,
				preserveFocus: true,
			});
		}),
	);
}

/** Provenance banner, as ca65 comments so the document still lexes. */
function header(name: string, source: vscode.Uri, position: vscode.Position): string {
	const where = `${source.path.split('/').pop()}:${position.line + 1}`;
	return `; js65 expansion of \`${name}\` invoked at ${where}\n` +
		`; This is a generated view; edits are not saved.\n\n`;
}
