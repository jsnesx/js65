// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import * as vscode from 'vscode';
import { blockAt, renderInputDeclarations, renderJsMirror, scanJsBlocks } from '../src/jsBlocks';
import { activate, getDocUri, sleep } from './helper';

suite('Scanning .jsbegin blocks', () => {
	test('finds a block body without its delimiters', () => {
		const {blocks} = scanJsBlocks('.segment "CODE"\n.jsbegin\na.byte(1);\n.jsend\nrts\n');
		assert.deepStrictEqual(blocks, [{startLine: 2, endLine: 3}]);
	});

	test('finds several blocks in one file', () => {
		const {blocks} = scanJsBlocks('.jsbegin\nx\n.jsend\n.jsbegin\ny\nz\n.jsend\n');
		assert.deepStrictEqual(blocks, [{startLine: 1, endLine: 2}, {startLine: 4, endLine: 6}]);
	});

	// A block is unterminated for as long as it takes to type the closing line,
	// so the body still has to resolve while that is true.
	test('runs an unterminated block to the end of the file', () => {
		const {blocks} = scanJsBlocks('.jsbegin\na.byte(1);\n');
		assert.deepStrictEqual(blocks, [{startLine: 1, endLine: 3}]);
	});

	test('accepts indentation, trailing comments and any case', () => {
		const {blocks} = scanJsBlocks('  .JSBEGIN  ; build tables\nx\n  .JsEnd\n');
		assert.deepStrictEqual(blocks, [{startLine: 1, endLine: 2}]);
	});

	test('ignores a directive that merely starts with .jsbegin', () => {
		const {blocks} = scanJsBlocks('.jsbeginish\nx\n');
		assert.deepStrictEqual(blocks, []);
	});

	test('locates the block a line falls in', () => {
		const {blocks} = scanJsBlocks('.jsbegin\nx\n.jsend\n.jsbegin\ny\n.jsend\n');
		assert.strictEqual(blockAt(blocks, 1), blocks[0]);
		assert.strictEqual(blockAt(blocks, 4), blocks[1]);
		assert.strictEqual(blockAt(blocks, 0), undefined, '.jsbegin itself is not the body');
		assert.strictEqual(blockAt(blocks, 2), undefined, '.jsend itself is not the body');
	});
});

suite('Scanning .jsinput declarations', () => {
	test('binds a plain filename to a single file', () => {
		const {inputs} = scanJsBlocks('.jsinput logo, "art/logo.chr"\n');
		assert.deepStrictEqual(inputs, [{name: 'logo', pattern: 'art/logo.chr', isGlob: false}]);
	});

	test('binds a glob to an array', () => {
		const {inputs} = scanJsBlocks('.jsinput tiles, "art/*.chr"\n');
		assert.deepStrictEqual(inputs, [{name: 'tiles', pattern: 'art/*.chr', isGlob: true}]);
	});

	test('accepts single quotes', () => {
		const {inputs} = scanJsBlocks(".jsinput logo, 'a.chr'\n");
		assert.strictEqual(inputs[0].pattern, 'a.chr');
	});

	test('declares a name only once', () => {
		const {inputs} = scanJsBlocks('.jsinput a, "x.chr"\n.jsinput a, "y.chr"\n');
		assert.strictEqual(inputs.length, 1);
	});

	// The declarations are what the editor offers as completions, so the type
	// has to follow the glob the same way the preprocessor's binding does.
	test('renders one typed declaration per binding', () => {
		const text = renderInputDeclarations([
			{name: 'logo', pattern: 'logo.chr', isGlob: false},
			{name: 'tiles', pattern: '*.chr', isGlob: true},
		]);
		assert.ok(text.includes('declare const logo: JsInputFile;'));
		assert.ok(text.includes('declare const tiles: JsInputFile[];'));
	});

	test('renders nothing when a file declares no inputs', () => {
		assert.strictEqual(renderInputDeclarations([]), '');
	});
});

suite('Mirroring .jsbegin blocks for the JS language service', () => {
	test('keeps block bodies in place and blanks everything else', () => {
		const text = '.segment "CODE"\n.jsbegin\na.byte(1);\n.jsend\n  rts\n';
		const {blocks} = scanJsBlocks(text);
		assert.deepStrictEqual(renderJsMirror(text, blocks).split('\n'), [
			'',
			'',
			'a.byte(1);',
			'',
			'',
			'',
			// Makes the mirror a module so two documents cannot collide.
			'export {};',
			'',
		]);
	});

	test('positions are identical in both documents', () => {
		const text = '.jsbegin\n  a.byte(1);\n.jsend\n';
		const mirror = renderJsMirror(text, scanJsBlocks(text).blocks);
		assert.strictEqual(mirror.split('\n')[1], text.split('\n')[1]);
	});

	test('leaves the assembly out even when a block is unterminated', () => {
		const text = 'lda #$01\n.jsbegin\na.byte(1);\n';
		const mirror = renderJsMirror(text, scanJsBlocks(text).blocks);
		assert.ok(!mirror.includes('lda'));
		assert.ok(mirror.includes('a.byte(1);'));
	});
});

/**
 * The JavaScript in a `.jsbegin` block is answered by the editor's JavaScript
 * language service, not the assembler. These go through the same
 * `vscode.execute*Provider` commands the editor itself uses, which is the only
 * way to catch the request being routed to the wrong server.
 */
suite('JavaScript inside .jsbegin blocks', () => {
	const docUri = getDocUri('jsblock.s');

	// Inside `pattern` on line 3.
	const inPattern = new vscode.Position(3, 8);
	// Just inside the parentheses of `a.byte(` on line 4.
	const inCall = new vscode.Position(4, 7);
	// After the dot of the bare `a.` on line 5.
	const afterDot = new vscode.Position(5, 2);

	test('completes the builder bound as `a`', async () => {
		await activate(docUri);
		const labels = await completionLabelsEventually(docUri, afterDot, '.', ['byte', 'word']);
		assert.ok(labels.includes('byte') && labels.includes('word'),
			`expected the AsmModule members, saw ${labels.join(',')}`);
	});

	test('completes `defines` and the block locals, not assembly', async () => {
		await activate(docUri);
		const labels = await completionLabelsEventually(
			docUri, new vscode.Position(5, 1), undefined, ['defines', 'pattern']);
		assert.ok(labels.includes('defines'), `expected \`defines\`, saw ${labels.join(',')}`);
		assert.ok(labels.includes('pattern'), 'expected the block local');
		assert.ok(!labels.includes('lda'), 'mnemonics do not belong inside a block');
	});

	test('hovers a JavaScript name with its JavaScript type', async () => {
		await activate(docUri);
		const text = await hoverText(docUri, inPattern);
		assert.ok(text.includes('number[]'), `expected an inferred type, got: ${text}`);
		assert.ok(!text.includes('loading...'),
			`hover came from the syntax server, not the semantic one: ${text}`);
	});

	test('offers signature help for a builder call', async () => {
		await activate(docUri);
		const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
			'vscode.executeSignatureHelpProvider', docUri, inCall, '(');
		const labels = (help?.signatures ?? []).map(sig => sig.label);
		assert.ok(labels.some(l => l.includes('bytes')),
			`expected the byte() parameters, saw ${JSON.stringify(labels)}`);
	});
});

async function completionLabels(
	uri: vscode.Uri,
	position: vscode.Position,
	triggerCharacter?: string,
): Promise<string[]> {
	const list = await vscode.commands.executeCommand<vscode.CompletionList>(
		'vscode.executeCompletionItemProvider', uri, position, triggerCharacter);
	return (list?.items ?? []).map(i => typeof i.label === 'string' ? i.label : i.label.label);
}

/**
 * The JavaScript project backing a block is built on demand, and until it has
 * loaded VS Code answers from a syntax-only server. Poll rather than assert on
 * the first response, which would make this a race.
 */
async function completionLabelsEventually(
	uri: vscode.Uri,
	position: vscode.Position,
	triggerCharacter: string | undefined,
	wanted: readonly string[],
	timeoutMs = 30000,
): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	let labels: string[] = [];
	while (Date.now() < deadline) {
		labels = await completionLabels(uri, position, triggerCharacter);
		if (wanted.every(w => labels.includes(w))) return labels;
		await sleep(250);
	}
	return labels;
}

async function hoverText(uri: vscode.Uri, position: vscode.Position): Promise<string> {
	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
		'vscode.executeHoverProvider', uri, position);
	return (hovers ?? []).flatMap(h => h.contents)
		.map(c => typeof c === 'string' ? c : c.value).join('\n');
}
