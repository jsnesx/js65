
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'bun:test';
import { AsmEngine, sym } from '../src/builder.ts';
import { deserializeObjectFile } from '../src/libassembler.ts';

describe('AsmEngine/AsmModule builder', () => {
  it('charmap scoping, string bytes, literal bypass, align, and res', async () => {
    const engine = new AsmEngine({ outputFormat: 'object' });
    const mod = engine.module('main');
    mod.segment('CODE');
    mod.org(0x8000);
    mod.charmap(0x41, 0x00); // 'A' -> 0x00
    mod.pushCharmap();
    mod.charmap(0x42, 0x01); // 'B' -> 0x01, only inside the pushed scope
    mod.byte('AB');
    mod.popCharmap();
    mod.byte('AB'); // 'B' is unmapped again -> raw code point
    mod.literal('AB'); // bypasses the charmap entirely -> raw code points
    mod.align(4);
    mod.res(3, 0xff);

    const result = await engine.compile();
    expect(result.success).toBe(true);

    const chunk = (await deserializeObjectFile(result.outputs[0].data)).chunks![0];
    expect(chunk.org).toBe(0x8000);
    expect(Array.from(chunk.data)).toEqual([
      0x00, 0x01, // byte('AB') inside the pushed charmap
      0x00, 0x42, // byte('AB') after popCharmap, 'B' unmapped
      0x41, 0x42, // literal('AB'), charmap bypassed entirely
      0x00, 0x00, // align(4) padding (pc was 0x8006, needs 2 bytes to reach 0x8008)
      0xff, 0xff, 0xff, // res(3, 0xff)
    ]);
  });

  it('hibytes/lobytes over constants and relocatable symbols, relocExportLabel, import/global', async () => {
    const engine = new AsmEngine({ outputFormat: 'object' });
    const mod = engine.module('main');
    mod.segment('CODE');
    mod.org(0x8000);
    mod.relocExportLabel('main_start', 'CODE');
    mod.word(sym('main_start'));
    mod.hibytes([0x1234, sym('main_start')]);
    mod.lobytes([0x1234]);
    mod.import('external_sym');
    mod.global('shared_sym');

    const result = await engine.compile();
    expect(result.success).toBe(true);

    const module = await deserializeObjectFile(result.outputs[0].data);
    // The leading `.org` alone never emits data, so no chunk is persisted for it -
    // `relocExportLabel`'s `.reloc` is what starts the (only) chunk.
    const relocChunk = module.chunks![0];
    expect(relocChunk.name).toBe('main_start');
    // Placeholder bytes for the not-yet-resolved relocatable references; the real
    // values are filled in by the linker from `subs`.
    expect(Array.from(relocChunk.data)).toEqual([0xff, 0xff, 0x12, 0xff, 0x34]);
    expect(relocChunk.subs).toEqual([
      { offset: 0, size: 2, expr: { op: 'num', num: 0, meta: { rel: true, chunk: 0 } } },
      { offset: 3, size: 1, expr: { op: '>', args: [{ op: 'num', num: 0, meta: { rel: true, chunk: 0 } } ] } },
    ]);

    expect(module.symbols).toEqual([
      { export: 'main_start', expr: { op: 'num', num: 0, meta: { rel: true, chunk: 0 } } },
    ]);
  });

  it('strmap: a multi-char key wins the greedy longest match over a single-char charmap entry', async () => {
    const engine = new AsmEngine({ outputFormat: 'object' });
    const mod = engine.module('main');
    mod.segment('CODE');
    mod.org(0x8000);
    mod.charmap(0x41, 0x00); // 'A' -> 0x00
    mod.strmap('AB', [0xfe]); // 'AB' as a unit -> 0xfe, beats the 'A' charmap entry
    mod.byte('ABA'); // 'AB' matches greedily, then trailing 'A' falls back to the charmap
    mod.strmap('C', 5); // single-value convenience overload

    const result = await engine.compile();
    expect(result.success).toBe(true);

    const chunk = (await deserializeObjectFile(result.outputs[0].data)).chunks![0];
    expect(Array.from(chunk.data)).toEqual([0xfe, 0x00]);
  });
});
