// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, getDocUri } from './helper';

suite('Completion', () => {
	const docUri = getDocUri('main.s');

	test('offers mnemonics, project symbols, and macros at instruction position', async () => {
		await activate(docUri);
		const labels = await completionLabels(docUri, new vscode.Position(7, 3));
		assert.ok(labels.includes('lda'), 'expected the mnemonic list');
		assert.ok(labels.includes('counter'), 'expected symbols from the assembled unit');
		assert.ok(labels.includes('setpal'), 'expected macros from the included file');
	});

	test('offers directives after a dot', async () => {
		await activate(docUri);
		// Column 1 of `.proc reset` — the trigger character has just been typed.
		const labels = await completionLabels(docUri, new vscode.Position(6, 1), '.');
		assert.ok(labels.some(l => l === '.proc'), 'expected .proc among the directives');
		assert.ok(!labels.includes('lda'), 'mnemonics do not belong in directive position');
	});
});

async function completionLabels(
	uri: vscode.Uri,
	position: vscode.Position,
	triggerCharacter?: string,
): Promise<string[]> {
	const list = await vscode.commands.executeCommand<vscode.CompletionList>(
		'vscode.executeCompletionItemProvider', uri, position, triggerCharacter);
	return list.items.map(i => typeof i.label === 'string' ? i.label : i.label.label);
}
