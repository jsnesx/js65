// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, editor, getDocUri, sleep } from './helper';

suite('Expand macro command', () => {
	const docUri = getDocUri('main.s');

	test('renders the expansion of the invocation under the cursor', async () => {
		await activate(docUri);
		// Put the cursor inside `setpal $12`.
		editor.selection = new vscode.Selection(9, 4, 9, 4);

		await vscode.commands.executeCommand('js65.expandMacro');
		const expansion = await waitForExpansionDocument();

		const text = expansion.getText();
		assert.ok(/setpal/.test(text), `expected the header to name the macro: ${text}`);
		assert.ok(/lda/.test(text), `expected the macro body: ${text}`);
		// The argument must have been substituted for the parameter.
		assert.ok(!/\bcolor\b/.test(text), `parameter was not substituted: ${text}`);
	});

	test('says so when there is no macro at the cursor', async () => {
		await activate(docUri);
		editor.selection = new vscode.Selection(7, 3, 7, 3); // `lda`, not a macro
		// The command reports through a notification, which tests can't read;
		// what is checked here is that it neither throws nor opens a document.
		const before = vscode.workspace.textDocuments.length;
		await vscode.commands.executeCommand('js65.expandMacro');
		await sleep(500);
		assert.strictEqual(vscode.workspace.textDocuments.length, before);
	});
});

/** Wait for the virtual expansion document the command opens. */
async function waitForExpansionDocument(timeoutMs = 10000): Promise<vscode.TextDocument> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'js65-expansion');
		if (found) return found;
		await sleep(100);
	}
	throw new Error('no js65-expansion document was opened');
}
