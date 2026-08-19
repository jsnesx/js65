// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {assemble} from '../../../src/libassembler.ts';
import {InactiveRegionIndex} from '../../../src/lspindex.ts';

/**
 * Assemble `code` with region tracking on and return the spans for the input
 * file as `[startLine, endLine]` pairs, 1-based and inclusive.
 */
function regions(code: string): Array<[number, number]> {
  const index = new InactiveRegionIndex();
  const result = assemble([{type: 'source', name: 'input.s', code}],
                          {generateDebugInfo: true, inactiveRegionIndex: index});
  const errors = result.messages.filter(m => m.level === 'error');
  expect(errors.map(e => e.message)).toEqual([]);
  return index.forFile('input.s').map(r => [r.startLine, r.endLine]);
}

describe('InactiveRegionIndex', function() {
  it('records the untaken branch of an .if', function() {
    // 1:blank 2:.if 3:lda 4:.else 5:lda 6:nop 7:.endif
    expect(regions([
      '',
      '.if 1',
      '  lda #1',
      '.else',
      '  lda #2',
      '  nop',
      '.endif',
    ].join('\n'))).toEqual([[5, 6]]);
  });

  it('records the untaken branch when the condition is false', function() {
    expect(regions([
      '',
      '.if 0',
      '  lda #1',
      '  nop',
      '.else',
      '  lda #2',
      '.endif',
    ].join('\n'))).toEqual([[3, 4]]);
  });

  it('leaves the .if/.else/.endif lines themselves active', function() {
    // Only line 4 is dead: the directives that delimit it stay lit, the way a
    // C editor leaves `#else` readable.
    expect(regions([
      '',
      '.if 1',
      '.else',
      '  lda #2',
      '.endif',
    ].join('\n'))).toEqual([[4, 4]]);
  });

  it('records every dead arm of an .elseif chain', function() {
    expect(regions([
      '',
      '.if 0',
      '  lda #1',
      '.elseif 0',
      '  lda #2',
      '.elseif 1',
      '  lda #3',
      '.else',
      '  lda #4',
      '.endif',
    ].join('\n'))).toEqual([[3, 3], [5, 5], [9, 9]]);
  });

  it('swallows a nested conditional inside a dead branch whole', function() {
    // Nothing inside a dead `.if` is ever evaluated, so the inner `.if 1` is
    // just as dead as the rest of the block.
    expect(regions([
      '',
      '.if 0',
      '  .if 1',
      '    lda #1',
      '  .else',
      '    lda #2',
      '  .endif',
      '.endif',
      '  rts',
    ].join('\n'))).toEqual([[3, 7]]);
  });

  it('records a dead branch nested inside a live one', function() {
    expect(regions([
      '',
      '.if 1',
      '  lda #1',
      '  .if 0',
      '    lda #2',
      '    lda #3',
      '  .endif',
      '  lda #4',
      '.endif',
    ].join('\n'))).toEqual([[5, 6]]);
  });

  it('handles .ifdef against a name that was never defined', function() {
    expect(regions([
      '',
      '.ifdef NOPE',
      '  lda #1',
      '  lda #2',
      '.endif',
      '  rts',
    ].join('\n'))).toEqual([[3, 4]]);
  });

  it('leaves a macro body lit when some call site takes each branch', function() {
    // The same lines assemble twice, once down each arm. A line that any
    // expansion kept is live, so nothing here is dimmed.
    expect(regions([
      '.macro M v',
      '  .if v',
      '    lda #1',
      '  .else',
      '    lda #2',
      '  .endif',
      '.endmacro',
      '  M 1',
      '  M 0',
    ].join('\n'))).toEqual([]);
  });

  it('dims a macro branch no call site ever takes', function() {
    expect(regions([
      '.macro M v',
      '  .if v',
      '    lda #1',
      '  .else',
      '    lda #2',
      '  .endif',
      '.endmacro',
      '  M 1',
      '  M 1',
    ].join('\n'))).toEqual([[5, 5]]);
  });

  it('leaves both arms lit when a .repeat takes each in turn', function() {
    expect(regions([
      '.repeat 3, i',
      '  .if i = 1',
      '    lda #1',
      '  .else',
      '    lda #2',
      '  .endif',
      '.endrepeat',
    ].join('\n'))).toEqual([]);
  });

  it('records nothing when there are no conditionals at all', function() {
    expect(regions('  lda #1\n  rts\n')).toEqual([]);
  });
});
