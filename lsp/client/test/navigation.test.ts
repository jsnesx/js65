// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, getDocUri } from './helper';

suite('Navigation', () => {
	const docUri = getDocUri('main.s');
	const incUri = getDocUri('inc/macros.inc');

	test('go-to-definition on a constant lands on its assignment', async () => {
		await activate(docUri);
		// `sta counter` — the cursor inside `counter`.
		const locations = await definitions(docUri, new vscode.Position(8, 8));
		assert.strictEqual(locations.length, 1);
		assert.strictEqual(locations[0].uri.fsPath, docUri.fsPath);
		assert.strictEqual(locations[0].range.start.line, 4);
	});

	test('go-to-definition on an .include string opens the included file', async () => {
		await activate(docUri);
		const locations = await definitions(docUri, new vscode.Position(2, 12));
		assert.strictEqual(locations.length, 1);
		assert.strictEqual(locations[0].uri.fsPath, incUri.fsPath);
	});

	test('find-references lists the declaration and every use', async () => {
		await activate(docUri);
		const refs = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeReferenceProvider', docUri, new vscode.Position(8, 8));
		const lines = refs.map(r => r.range.start.line).sort((a, b) => a - b);
		assert.deepStrictEqual(lines, [4, 8]);
	});

	test('document symbols include the .proc', async () => {
		await activate(docUri);
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider', docUri);
		const proc = symbols.find(s => s.name === 'reset');
		assert.ok(proc, `expected a 'reset' symbol, got ${symbols.map(s => s.name).join(', ')}`);
		assert.strictEqual(proc.kind, vscode.SymbolKind.Function);
	});

	test('workspace symbols find a symbol by substring', async () => {
		await activate(docUri);
		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
			'vscode.executeWorkspaceSymbolProvider', 'count');
		assert.ok(symbols.some(s => s.name === 'counter'),
			`expected 'counter', got ${symbols.map(s => s.name).join(', ')}`);
	});

	test('folding covers the .proc block', async () => {
		await activate(docUri);
		const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
			'vscode.executeFoldingRangeProvider', docUri);
		assert.ok(ranges.some(r => r.start === 6 && r.end === 11),
			`expected a 6..11 fold, got ${JSON.stringify(ranges)}`);
	});
});

async function definitions(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
	const result = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
		'vscode.executeDefinitionProvider', uri, position);
	// VS Code hands back either shape depending on what the server returned.
	return (result as Array<vscode.Location | vscode.LocationLink>).map(r =>
		'targetUri' in r
			? new vscode.Location(r.targetUri, r.targetRange)
			: r);
}
