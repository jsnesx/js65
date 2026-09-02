// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import { blockAt, renderInputDeclarations, scanJsBlocks } from '../src/jsBlocks';

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
