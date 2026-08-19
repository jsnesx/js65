// SPDX-License-Identifier: MPL-2.0

import * as assert from 'assert';
import { toRange } from '../src/inactiveRegions';

/**
 * The server sends 0-based, end-exclusive line spans, but the decoration sets
 * `isWholeLine`, which paints every line the range touches. A range ending at
 * `(endLine, 0)` touches `endLine`, which dimmed the `.endif` that closes the
 * block. These pin the conversion that keeps it lit.
 */
suite('Inactive region ranges', () => {
	test('stops before the exclusive end line', () => {
		// `.if` on 0, body on 1, `.else` on 2, dead body on 3-4, `.endif` on 5.
		const range = toRange({ startLine: 3, endLine: 5 });
		assert.strictEqual(range.start.line, 3);
		assert.strictEqual(range.end.line, 4, 'the .endif on line 5 must stay lit');
	});

	test('covers a single dead line without spilling onto the next', () => {
		const range = toRange({ startLine: 1, endLine: 2 });
		assert.strictEqual(range.start.line, 1);
		assert.strictEqual(range.end.line, 1);
	});

	test('reaches the end of the last dead line', () => {
		// Ending at column 0 would leave the line's text undimmed if the
		// decoration ever stopped being whole-line.
		const range = toRange({ startLine: 2, endLine: 4 });
		assert.strictEqual(range.start.character, 0);
		assert.ok(range.end.character > 0, 'must span the whole final line');
	});

	test('does not invert on a degenerate empty span', () => {
		// The server never sends one, but an inverted range throws in VS Code.
		const range = toRange({ startLine: 6, endLine: 6 });
		assert.ok(!range.isEmpty || range.start.line === range.end.line);
		assert.ok(range.start.isBeforeOrEqual(range.end));
	});
});
