// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, getDocUri } from './helper';

suite('Hover', () => {
	const docUri = getDocUri('main.s');

	test('hovering a mnemonic shows its addressing modes', async () => {
		await activate(docUri);
		const text = await hoverText(docUri, new vscode.Position(7, 3)); // `lda`
		assert.ok(/lda/i.test(text), `unexpected hover: ${text}`);
		assert.ok(/addressing modes/i.test(text), `unexpected hover: ${text}`);
	});

	test('hovering a macro invocation names it and its parameters', async () => {
		await activate(docUri);
		const text = await hoverText(docUri, new vscode.Position(9, 4)); // `setpal`
		assert.ok(/setpal/.test(text), `unexpected hover: ${text}`);
		assert.ok(/macro/.test(text), `unexpected hover: ${text}`);
	});

	test('hovering a constant shows its resolved value', async () => {
		await activate(docUri);
		const text = await hoverText(docUri, new vscode.Position(8, 8)); // `counter`
		assert.ok(/\$10|16/.test(text), `unexpected hover: ${text}`);
	});
});

async function hoverText(uri: vscode.Uri, position: vscode.Position): Promise<string> {
	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
		'vscode.executeHoverProvider', uri, position);
	return hovers
		.flatMap(h => h.contents)
		.map(c => typeof c === 'string' ? c : c.value)
		.join('\n');
}
