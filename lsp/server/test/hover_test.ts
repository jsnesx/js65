// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import {Cpu} from '../../../src/cpu.ts';
import {Analyzer} from '../analyzer.ts';
import {computeHover, expandMacroAt} from '../features/hover.ts';
import {pathToUri} from '../convert.ts';
import {MemFs} from './memfs.ts';

/** Open a doc in a fresh analyzer and wait for the first analysis to land. */
async function analyzerWith(docs: Array<{path: string, text: string}>,
                            project?: {rootDir: string, json: string}):
    Promise<Analyzer> {
  const fs = new MemFs();
  const analyzer = new Analyzer({
    workspaceRoot: project?.rootDir ?? '/proj',
    debounceMs: 0,
    fsImpl: fs.sync as any,
  });
  analyzer.onDiagnostics = () => {};
  if (project) {
    fs.add(`${project.rootDir}/js65.json`, project.json);
    for (const d of docs) fs.add(d.path, d.text);
    const p = analyzer.discoverProject(`${project.rootDir}/js65.json`);
    if (p) analyzer.setProject(p);
  }
  for (const d of docs) analyzer.open(pathToUri(d.path), d.text, 1);
  // Opening several docs coalesces into one debounced pass; wait for it to
  // finish rather than for the first callback, so every project is present.
  await new Promise(r => setTimeout(r, 100));
  return analyzer;
}

const hoverAt = (uri: string, line: number, character: number) =>
    ({textDocument: {uri}, position: {line, character}});

describe('hover', () => {
  it('exposes the addressing modes the CPU table knows', () => {
    expect(Object.keys(Cpu.P02.table.lda)).toContain('imm');
    expect(Object.keys(Cpu.P02.table.lda)).toContain('abs');
  });

  // Finding #4: hover used readFileSync, so it reflected the last *saved* text
  // and returned nothing at all for a buffer never written to disk.
  it('hovers a mnemonic in a document that was never written to disk', async () => {
    const text = 'main:\n  lda #$01\n  rts\n';
    // Note the doc is only ever opened in the analyzer — never added to MemFs.
    const analyzer = await analyzerWith([{path: '/proj/unsaved.s', text}]);
    const uri = pathToUri('/proj/unsaved.s');
    const hover = computeHover(analyzer, hoverAt(uri, 1, 3) as any);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as {value: string}).value;
    expect(value).toContain('lda');
    expect(value).toContain('6502 mnemonic');
  });

  it('reflects the live buffer rather than stale text', async () => {
    const analyzer = await analyzerWith([{path: '/proj/m.s', text: 'main:\n  rts\n'}]);
    const uri = pathToUri('/proj/m.s');
    // Change the buffer: line 1 is now `sta`, not `rts`.
    analyzer.change(uri, 'main:\n  sta $10\n', 2);
    const hover = computeHover(analyzer, hoverAt(uri, 1, 3) as any);
    const value = (hover!.contents as {value: string}).value;
    expect(value).toContain('sta');
    expect(value).not.toContain('rts');
  });

  // Finding #4: the mnemonic guard used `in`, which walks the prototype chain.
  it('does not treat Object.prototype members as mnemonics', async () => {
    for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const text = `main:\n  ${word}\n`;
      const analyzer = await analyzerWith([{path: '/proj/p.s', text}]);
      const uri = pathToUri('/proj/p.s');
      const hover = computeHover(analyzer, hoverAt(uri, 1, 3) as any);
      if (hover) {
        const value = (hover.contents as {value: string}).value;
        expect(value).not.toContain('6502 mnemonic');
      }
    }
  });

  it('returns nothing for a document that is not open', async () => {
    const analyzer = await analyzerWith([{path: '/proj/m.s', text: 'main:\n  rts\n'}]);
    const hover = computeHover(
        analyzer, hoverAt(pathToUri('/proj/other.s'), 0, 0) as any);
    expect(hover).toBeNull();
  });

  // Finding #4: hover took the *first* project rather than the one owning the doc.
  // `a.s` deliberately sorts first, so answering from the first project would miss
  // a macro that only project b defines.
  it('picks the project that owns the document in a multi-project workspace', async () => {
    const analyzer = await analyzerWith([
      {path: '/proj/a.s', text: '.macro only_in_a\n  nop\n.endmacro\n  only_in_a\n'},
      {path: '/proj/b.s', text: '.macro only_in_b arg\n  nop\n.endmacro\n  only_in_b 1\n'},
    ], {
      rootDir: '/proj',
      json: JSON.stringify({
        projects: [
          {name: 'a', sources: ['a.s']},
          {name: 'b', sources: ['b.s']},
        ],
      }),
    });
    // Hovering `only_in_b` in b.s must resolve against project b's macro table.
    const hover = computeHover(
        analyzer, hoverAt(pathToUri('/proj/b.s'), 3, 4) as any);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as {value: string}).value;
    expect(value).toContain('only_in_b');
    expect(value).toContain('arg');
  });
});

describe('js65/expandMacro', () => {
  // Finding #7: this was a `{found: false}` stub, leaving Macro.definition with
  // no consumer anywhere in lsp/.
  it('expands a macro invocation under the cursor', async () => {
    const text = [
      '.macro inc_twice addr',
      '  inc addr',
      '  inc addr',
      '.endmacro',
      '  inc_twice $10',
    ].join('\n') + '\n';
    const analyzer = await analyzerWith([{path: '/proj/m.s', text}]);
    const uri = pathToUri('/proj/m.s');
    const result = expandMacroAt(analyzer, {uri, position: {line: 4, character: 4}});
    expect(result.found).toBe(true);
    // Two `inc` lines come back out of the expansion.
    expect(result.text.split('\n').filter(l => l.includes('inc')).length).toBe(2);
  });

  it('reports not-found off a macro invocation', async () => {
    const analyzer = await analyzerWith([{path: '/proj/m.s', text: 'main:\n  rts\n'}]);
    const uri = pathToUri('/proj/m.s');
    const result = expandMacroAt(analyzer, {uri, position: {line: 1, character: 3}});
    expect(result.found).toBe(false);
  });

  it('hovers a macro invocation with its signature', async () => {
    const text = [
      '.macro shift_by amount, reg',
      '  nop',
      '.endmacro',
      '  shift_by 2, x',
    ].join('\n') + '\n';
    const analyzer = await analyzerWith([{path: '/proj/m.s', text}]);
    const uri = pathToUri('/proj/m.s');
    const hover = computeHover(analyzer, hoverAt(uri, 3, 4) as any);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as {value: string}).value;
    expect(value).toContain('shift_by');
    expect(value).toContain('.macro');
    expect(value).toContain('amount');
  });
});
