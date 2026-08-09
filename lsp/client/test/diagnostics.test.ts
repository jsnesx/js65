// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, doc, editor, getDocUri, waitForDiagnostics } from './helper';

suite('Diagnostics', () => {
	test('reports an assembler error in a file outside the project', async () => {
		const uri = getDocUri('broken.s');
		await activate(uri);
		const diags = await waitForDiagnostics(uri, d => d.length > 0);
		assert.ok(/hex/i.test(diags[0].message), `unexpected message: ${diags[0].message}`);
		assert.strictEqual(diags[0].source, 'js65');
		assert.strictEqual(diags[0].range.start.line, 3);
	});

	test('reports nothing for a file that assembles cleanly', async () => {
		const uri = getDocUri('main.s');
		await activate(uri);
		const diags = vscode.languages.getDiagnostics(uri);
		assert.deepStrictEqual(diags.map(d => d.message), []);
	});

	test('updates as the buffer changes and clears when fixed', async () => {
		const uri = getDocUri('main.s');
		await activate(uri);

		// Break it in the editor only — never written to disk, so this also
		// proves the server analyzes the live buffer rather than the file.
		const badLine = new vscode.Range(new vscode.Position(7, 0), new vscode.Position(7, 10));
		const original = doc.getText(badLine);
		await editor.edit(eb => eb.replace(badLine, '  lda #$xx'));
		const broken = await waitForDiagnostics(uri, d => d.length > 0);
		assert.ok(/hex/i.test(broken[0].message));

		await editor.edit(eb => eb.replace(badLine, original));
		const fixed = await waitForDiagnostics(uri, d => d.length === 0);
		assert.deepStrictEqual(fixed.map(d => d.message), []);
	});
});
