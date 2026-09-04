// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import {computeCompletion, classifyPosition} from '../worker/features/completion.ts';
import {Analyzer} from '../worker/analyzer.ts';
import {MemFs} from './memfs.ts';
import {pathToUri} from '../convert.ts';

async function analyzerWith(path: string, text: string): Promise<Analyzer> {
  const fs = new MemFs();
  const analyzer = new Analyzer({
    workspaceRoot: '/proj', debounceMs: 0,
    fsImpl: fs.sync as any,
  });
  analyzer.onDiagnostics = () => {};
  analyzer.open(pathToUri(path), text, 1);
  await analyzer.settled();
  return analyzer;
}

const at = (uri: string, line: number, character: number, trigger?: string) => ({
  textDocument: {uri},
  position: {line, character},
  context: trigger
      ? {triggerCharacter: trigger, triggerKind: 2}
      : {triggerKind: 1},
});

describe('completion', () => {
  // Finding #10: the plan's context rules were entirely absent — every request
  // dumped all symbols in all scopes plus every mnemonic.
  describe('classifyPosition', () => {
    it('treats the `.` trigger as directive position', () => {
      expect(classifyPosition('  .', 3, '.')).toBe('directive');
    });

    it('treats a partially typed directive as directive position', () => {
      expect(classifyPosition('  .inc', 6, undefined)).toBe('directive');
    });

    it('treats column 0 as label position', () => {
      expect(classifyPosition('main', 4, undefined)).toBe('label');
    });

    it('treats the first word on an indented line as the mnemonic slot', () => {
      expect(classifyPosition('  ld', 4, undefined)).toBe('mnemonic');
    });

    it('treats what follows a mnemonic as operand position', () => {
      expect(classifyPosition('  lda ', 6, undefined)).toBe('operand');
      expect(classifyPosition('  lda fo', 8, undefined)).toBe('operand');
    });
  });

  it('offers directives after the `.` trigger, and no mnemonics', async () => {
    const analyzer = await analyzerWith('/proj/m.s', 'main:\n  rts\n');
    const items = computeCompletion(analyzer, at(pathToUri('/proj/m.s'), 1, 3, '.') as any);
    // `DIRECTIVES` covers the preprocessor's own set; `TOKENFUNCS` the builtins.
    expect(items.some(i => i.label === '.proc')).toBe(true);
    expect(items.some(i => i.label === '.include')).toBe(true);
    expect(items.some(i => i.label === 'lda')).toBe(false);
  });

  it('offers nothing at label position', async () => {
    const analyzer = await analyzerWith('/proj/m.s', 'ma\n  rts\n');
    const items = computeCompletion(analyzer, at(pathToUri('/proj/m.s'), 0, 2) as any);
    expect(items).toHaveLength(0);
  });

  it('offers mnemonics in the instruction slot', async () => {
    const analyzer = await analyzerWith('/proj/m.s', 'main:\n  ld\n');
    const items = computeCompletion(analyzer, at(pathToUri('/proj/m.s'), 1, 4) as any);
    expect(items.some(i => i.label === 'lda')).toBe(true);
  });

  it('omits mnemonics in operand position', async () => {
    const analyzer = await analyzerWith('/proj/m.s', 'main:\n  lda \n');
    const items = computeCompletion(analyzer, at(pathToUri('/proj/m.s'), 1, 6) as any);
    expect(items.some(i => i.label === 'lda')).toBe(false);
  });

  it('scopes symbol results to the cursor position', async () => {
    const text = [
      'outer_sym = 1',        // 0
      '.proc MyProc',          // 1
      'inner_label:',          // 2
      '  lda inner_label',     // 3
      '.endproc',              // 4
      '  lda ',                // 5 — outside the proc
    ].join('\n') + '\n';
    const analyzer = await analyzerWith('/proj/m.s', text);
    const uri = pathToUri('/proj/m.s');
    // Inside the proc, the local is visible.
    const inside = computeCompletion(analyzer, at(uri, 3, 6) as any);
    expect(inside.some(i => i.label === 'inner_label')).toBe(true);
    // Outside it, the proc's local must not leak into the root scope's results.
    const outside = computeCompletion(analyzer, at(uri, 5, 6) as any);
    expect(outside.some(i => i.label === 'inner_label')).toBe(false);
  });

  it('offers macros at instruction position', async () => {
    const text = '.macro my_macro\n  nop\n.endmacro\n  my\n';
    const analyzer = await analyzerWith('/proj/m.s', text);
    const items = computeCompletion(analyzer, at(pathToUri('/proj/m.s'), 3, 4) as any);
    expect(items.some(i => i.label === 'my_macro')).toBe(true);
  });
});
