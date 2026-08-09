// SPDX-License-Identifier: MPL-2.0

/**
 * Shared setup for the end-to-end tests.
 *
 * These run inside a real VS Code instance with `testFixture/` as the workspace
 * folder, so the language server discovers `testFixture/js65.json` exactly as it
 * would for a user's project. Every assertion goes through VS Code's own
 * `vscode.execute*Provider` commands, which means each one is a genuine round
 * trip: request over JSON-RPC, real assemble in the server, response mapped back
 * into VS Code types.
 */

import * as path from 'path';
import * as vscode from 'vscode';

export let doc: vscode.TextDocument;
export let editor: vscode.TextEditor;

/** `publisher.name` from package.json. */
const EXTENSION_ID = 'jsnesx.js65-vscode';

/**
 * Activate the extension and open a fixture document.
 *
 * Rather than sleeping a fixed amount, this waits for the server to publish
 * diagnostics for the document — including the empty publish a clean file gets,
 * which is the server's way of saying "I analyzed this and found nothing".
 */
export async function activate(docUri: vscode.Uri): Promise<void> {
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	if (!ext) throw new Error(`extension ${EXTENSION_ID} not found`);
	await ext.activate();
	doc = await vscode.workspace.openTextDocument(docUri);
	editor = await vscode.window.showTextDocument(doc);
	await waitForAnalysis(docUri);
}

/**
 * Wait until the server has analyzed a document.
 *
 * `vscode.languages.getDiagnostics` can't distinguish "clean" from "not yet
 * analyzed" — both are an empty array — so this polls a provider request that
 * only answers once the analyzer has a result, then gives diagnostics a moment
 * to land.
 */
export async function waitForAnalysis(uri: vscode.Uri, timeoutMs = 30000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider', uri);
		if (symbols && symbols.length) return;
		if (vscode.languages.getDiagnostics(uri).length) return;
		await sleep(200);
	}
	throw new Error(`timed out waiting for the js65 server to analyze ${uri.fsPath}`);
}

/** Poll `getDiagnostics` until `predicate` holds, or fail with what was seen. */
export async function waitForDiagnostics(
	uri: vscode.Uri,
	predicate: (diags: readonly vscode.Diagnostic[]) => boolean,
	timeoutMs = 30000,
): Promise<readonly vscode.Diagnostic[]> {
	const deadline = Date.now() + timeoutMs;
	let last: readonly vscode.Diagnostic[] = [];
	while (Date.now() < deadline) {
		last = vscode.languages.getDiagnostics(uri);
		if (predicate(last)) return last;
		await sleep(200);
	}
	throw new Error(
		`timed out waiting for diagnostics on ${uri.fsPath}; last saw: ` +
		JSON.stringify(last.map(d => d.message)));
}

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export const getDocPath = (p: string): string =>
	path.resolve(__dirname, '../../testFixture', p);

export const getDocUri = (p: string): vscode.Uri => vscode.Uri.file(getDocPath(p));
