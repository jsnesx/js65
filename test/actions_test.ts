// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {assemble, JsActionTable,
        type AssemblyAction, type AssemblyInput} from '../src/libassembler.ts';

function assembleWith(code: string, table?: JsActionTable) {
  const input: AssemblyInput = {type: 'source', code, name: 'test.s'};
  return assemble([input], {jsActions: table});
}

/** Compile one source file with the table and return its single chunk. */
function chunkOf(code: string, table: JsActionTable) {
  const result = assembleWith(code, table);
  const errors = result.messages.filter(m => m.level === 'error');
  expect(errors.map(m => m.message)).toEqual([]);
  expect(result.success).toBe(true);
  return result.modules[0].chunks![0];
}

describe('runActions via .jsactions', () => {
  it('replays an action list mid-file, interleaved with surrounding assembly', () => {
    const table = new JsActionTable();
    const index = table.add([
      {action: 'byte', bytes: [0x11, 0x22]},
      {action: 'word', words: [0x3344]},
    ]);
    const chunk = chunkOf(`
.segment "CODE"
.org $8000
  .byte $01
  .jsactions ${index}
  .byte $02
`, table);
    expect(chunk.org).toBe(0x8000);
    expect(Array.from(chunk.data)).toEqual([0x01, 0x11, 0x22, 0x44, 0x33, 0x02]);
  });

  it('lands in the segment live at the marker', () => {
    const table = new JsActionTable();
    const index = table.add([{action: 'byte', bytes: [0xaa]}]);
    const result = assembleWith(`
.segment "ONE"
  .byte $01
.segment "TWO"
  .jsactions ${index}
`, table);
    expect(result.success).toBe(true);
    const chunks = result.modules[0].chunks!;
    const two = chunks.find(c => c.segments.includes('TWO'));
    expect(two).toBeDefined();
    expect(Array.from(two!.data)).toEqual([0xaa]);
  });

  it('defines a label the surrounding assembly can reference', () => {
    const table = new JsActionTable();
    const index = table.add([
      {action: 'label', label: 'generated'},
      {action: 'byte', bytes: [0x99]},
    ]);
    const chunk = chunkOf(`
.segment "CODE"
.org $8000
  .jsactions ${index}
  .word generated
`, table);
    expect(Array.from(chunk.data)).toEqual([0x99, 0x00, 0x80]);
  });

  it('emits into the scope live at the marker', () => {
    const table = new JsActionTable();
    const index = table.add([{action: 'label', label: 'inner'}]);
    const result = assembleWith(`
.segment "CODE"
.org $8000
.scope Outer
  .jsactions ${index}
.endscope
  .word Outer::inner
`, table);
    expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('runs a code action through the full pipeline', () => {
    const actions: AssemblyAction[] = [
      {action: 'segment', name: 'CODE'},
      {action: 'org', addr: 0x9000},
      {action: 'code', code: '  .byte $de, $ad\n'},
      {action: 'byte', bytes: [0xbe]},
    ];
    const result = assemble([{type: 'actions', actions, name: 'main'}]);
    expect(result.success).toBe(true);
    expect(Array.from(result.modules[0].chunks![0].data)).toEqual([0xde, 0xad, 0xbe]);
  });

  it('rejects a code action replayed from a .jsactions marker', () => {
    const table = new JsActionTable();
    const index = table.add([{action: 'code', code: '.byte $00'}]);
    const result = assembleWith(`.jsactions ${index}\n`, table);
    expect(result.success).toBe(false);
    expect(result.messages.map(m => m.message).join('\n'))
        .toContain('code actions are not supported here');
  });

  it('errors on an index with no parked action list', () => {
    const result = assembleWith('.jsactions 7\n', new JsActionTable());
    expect(result.success).toBe(false);
    expect(result.messages.map(m => m.message).join('\n'))
        .toContain('No JS action list at index 7');
  });

  it('errors when no table was provided at all', () => {
    const result = assembleWith('.jsactions 0\n');
    expect(result.success).toBe(false);
    expect(result.messages.map(m => m.message).join('\n'))
        .toContain('No JS action list at index 0');
  });

  it('restores the file position after the marker', () => {
    const table = new JsActionTable();
    const index = table.add([
      {action: 'label', label: 'fromblock', source: {file: 'gen.js', line: 12}},
    ]);
    const result = assembleWith(`
.segment "CODE"
.org $8000
  .jsactions ${index}
  .endscope
`, table);
    expect(result.success).toBe(false);
    // The failure after the marker reports test.s, not the action's gen.js.
    const err = result.messages.find(m => m.level === 'error');
    expect(err!.source?.file).toBe('test.s');
    expect(err!.source?.line).toBe(5);
  });
});

describe('JsActionTable', () => {
  it('hands out sequential indices and reads them back', () => {
    const table = new JsActionTable();
    const a: AssemblyAction[] = [{action: 'byte', bytes: [1]}];
    const b: AssemblyAction[] = [{action: 'byte', bytes: [2]}];
    expect(table.add(a)).toBe(0);
    expect(table.add(b)).toBe(1);
    expect(table.get(0)).toBe(a);
    expect(table.get(1)).toBe(b);
    expect(table.get(2)).toBeUndefined();
  });
});
