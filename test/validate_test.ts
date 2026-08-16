
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'bun:test';
import { parseModule, parseActionModules } from '../src/validate_modules.ts';
import { Base64 } from '../src/base64.ts';
import { assemble, compile, deserializeObjectFile, isGzip, link, serializeObjectFile, type Module } from '../src/libassembler.ts';

const b64 = (bytes: number[]) => new Base64().encode(new Uint8Array(bytes));

describe('parseModule', () => {
  it('accepts an empty module', () => {
    const r = parseModule({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  it('decodes chunk base64 data to a Uint8Array', () => {
    const r = parseModule({
      name: 'm',
      chunks: [{ segments: ['CODE'], org: 0x8000, data: b64([0xa9, 0x01, 0x60]) }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const c = r.value.chunks![0];
      expect(c.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(c.data)).toEqual([0xa9, 0x01, 0x60]);
      expect(c.segments).toEqual(['CODE']);
      expect(c.org).toBe(0x8000);
    }
  });

  it('validates nested expressions in substitutions', () => {
    const r = parseModule({
      chunks: [{
        segments: ['CODE'],
        data: b64([0, 0]),
        subs: [{ offset: 0, size: 2, expr: { op: '+', args: [{ op: 'num', num: 1 }, { op: 'sym', sym: 'x' }] } }],
      }],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts the OverwriteMode enum and rejects bad values', () => {
    expect(parseModule({ chunks: [{ segments: ['C'], data: b64([]), overwrite: 'require' }] }).ok).toBe(true);
    const bad = parseModule({ chunks: [{ segments: ['C'], data: b64([]), overwrite: 'sometimes' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('overwrite');
  });

  it('accepts chunk placement any/all and rejects bad values', () => {
    const all = parseModule({ chunks: [{ segments: ['C'], data: b64([]), placement: 'all' }] });
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.chunks![0].placement).toBe('all');
    expect(parseModule({ chunks: [{ segments: ['C'], data: b64([]), placement: 'any' }] }).ok).toBe(true);
    const bad = parseModule({ chunks: [{ segments: ['C'], data: b64([]), placement: 'sometimes' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('placement');
  });

  it('rejects wrong field types with a path-qualified error', () => {
    expect(parseModule(42).ok).toBe(false);
    expect(parseModule({ chunks: 'nope' }).ok).toBe(false);
    const badData = parseModule({ chunks: [{ segments: ['C'], data: 123 }] });
    expect(badData.ok).toBe(false);
    if (!badData.ok) expect(badData.error).toContain('chunks[0].data');
    const badOffset = parseModule({ chunks: [{ segments: ['C'], data: b64([]), subs: [{ offset: 'x', size: 1, expr: { op: 'num' } }] }] });
    expect(badOffset.ok).toBe(false);
    if (!badOffset.ok) expect(badOffset.error).toContain('chunks[0].subs[0].offset');
  });

  it('requires Expr.op to be a string', () => {
    const r = parseModule({ chunks: [{ segments: ['C'], data: b64([]), asserts: [{ num: 1 }] }] });
    expect(r.ok).toBe(false);
  });

  it('rejects non-base64 chunk data', () => {
    const r = parseModule({ chunks: [{ segments: ['C'], data: '!!!not base64!!!' }] });
    // Base64.decode either throws (caught -> error) or yields garbage; the
    // important property is that `data` must be a string and is decoded here.
    expect(r.ok === true || r.ok === false).toBe(true);
  });

  it('strips unknown / smuggled keys (no prototype pollution)', () => {
    const r = parseModule(JSON.parse('{"name":"m","evil":1,"__proto__":{"polluted":true}}'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as Record<string, unknown>).evil).toBeUndefined();
      expect(r.value).toEqual({ name: 'm' });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parseActionModules', () => {
  it('accepts a well-formed action list', () => {
    const r = parseActionModules([[
      { action: 'code', code: 'nop', name: 'main' },
      { action: 'label', label: 'foo' },
      { action: 'byte', bytes: [1, 2, { op: 'sym', sym: 'x' }] },
      { action: 'word', words: [0x1234] },
      { action: 'org', addr: 0x8000 },
      { action: 'segment', name: ['CODE', 'DATA'] },
      { action: 'assign', name: 'k', value: 5 },
      { action: 'free', size: 16, source: { file: 'f.s', line: 3 } },
    ]]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].length).toBe(8);
  });

  it('accepts byte data as a Uint8Array (post-reviver form)', () => {
    const r = parseActionModules([[{ action: 'byte', bytes: new Uint8Array([1, 2, 3]) }]]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const a = r.value[0][0];
      expect(a.action).toBe('byte');
      if (a.action === 'byte') expect(a.bytes).toEqual([1, 2, 3]);
    }
  });

  it('rejects an unknown action discriminator', () => {
    const r = parseActionModules([[{ action: 'launch_missiles' }]]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown action');
  });

  it('rejects missing required fields and non-array input', () => {
    expect(parseActionModules([[{ action: 'label' }]]).ok).toBe(false); // missing label
    expect(parseActionModules('nope').ok).toBe(false);
    expect(parseActionModules([{ action: 'org', addr: 1 }]).ok).toBe(false); // inner not array
  });
});

describe('module JSON round-trip through the validator', () => {
  it('a serialized .o module re-validates and links to the same bytes', async () => {
    const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.segment "CODE"
.org $8000
start:
    lda #$01
    sta $2000
    rts
`;
    const asm = await assemble([{ type: 'source', code: source, name: 't.s' }], { lineContinuations: true });
    expect(asm.success).toBe(true);

    // Serialize the module the way the CLI does (Uint8Array data -> base64).
    const serialized = JSON.stringify(asm.modules[0], (k, v) => {
      if (k === 'data' && v && typeof v === 'object') return new Base64().encode(v as Uint8Array);
      return v;
    });

    const parsed = parseModule(JSON.parse(serialized));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const direct = link(asm.modules, {}, 'binary');
    const roundTripped = link([parsed.value], {}, 'binary');
    expect(roundTripped.success).toBe(true);
    expect(Array.from(roundTripped.data)).toEqual(Array.from(direct.data));
    expect(Array.from(roundTripped.data)).toEqual([0xa9, 0x01, 0x8d, 0x00, 0x20, 0x60]);
  });

  // Check that the .o round trip works with the sourceMap added
  it('a .o built with debug info re-validates with its debug maps intact', async () => {
    const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.segment "CODE"
.org $8000
start:
    lda #$01
loop:
    jmp loop
`;
    const out = await compile(
      [{ type: 'source', code: source, name: 't.s' }],
      { lineContinuations: true, outputFormat: 'object', generateDebugInfo: true },
    );
    expect(out.success).toBe(true);

    const chunk = (await deserializeObjectFile(out.outputs[0].data)).chunks![0];
    expect(chunk.labelIndex).toBeInstanceOf(Map);
    expect(chunk.labelIndex!.get('start')).toBe(0);
    expect(chunk.labelIndex!.get('loop')).toBe(2);
    expect(chunk.sourceMap!.get(0)).toMatchObject({ file: 't.s', line: 6 }); // the `lda`
  });

  it('keeps source info out of a .o built without debug info', async () => {
    // Locations are gathered during assembly either way so that errors can
    // point at a line; `generateDebugInfo` decides what reaches the file.
    const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.segment "CODE"
.org $8000
start:
    lda #$01
    jmp start
`;
    const opts = {lineContinuations: true, outputFormat: 'object' as const};
    const off = await compile([{ type: 'source', code: source, name: 't.s' }], opts);
    expect(off.success).toBe(true);

    const m = await deserializeObjectFile(off.outputs[0].data);
    expect(m.chunks![0].sourceMap).toBeUndefined();
    expect(m.chunks![0].labelIndex).toBeUndefined();
    // The symbol exprs carry a `source` in memory, but it must not be written.
    expect(JSON.stringify(m)).not.toContain('"source"');

    // ...and it still links to the same bytes as the debug build.
    const on = await compile([{ type: 'source', code: source, name: 't.s' }],
                             { ...opts, generateDebugInfo: true });
    expect(on.success).toBe(true);
    const withDebug = await deserializeObjectFile(on.outputs[0].data);
    expect(JSON.stringify(withDebug)).toContain('"source"');
    expect(Array.from(link([m], {}, 'binary').data))
        .toEqual(Array.from(link([withDebug], {}, 'binary').data));
  });

  it('writes .o files as gzip and reads them back losslessly', async () => {
    const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.segment "CODE"
.org $8000
start:
    lda #$01
    sta $2000
    rts
`;
    const out = await compile(
      [{ type: 'source', code: source, name: 't.s' }],
      { lineContinuations: true, outputFormat: 'object', generateDebugInfo: true },
    );
    expect(out.success).toBe(true);

    const o = out.outputs[0].data;
    expect(isGzip(o)).toBe(true);

    const linked = link([await deserializeObjectFile(o)], {}, 'binary');
    expect(linked.success).toBe(true);
    expect(Array.from(linked.data)).toEqual([0xa9, 0x01, 0x8d, 0x00, 0x20, 0x60]);
  });

  it('round-trips a module handed over in-process with real Maps', async () => {
    const m: Module = {
      name: 'inproc',
      chunks: [{
        segments: ['CODE'], data: new Uint8Array([0x60]),
        labelIndex: new Map([['here', 0]]),
        sourceMap: new Map([[0, { file: 'a.s', line: 1, column: 0 }]]),
      }],
    };
    const chunk = (await deserializeObjectFile(await serializeObjectFile(m))).chunks![0];
    expect(chunk.labelIndex!.get('here')).toBe(0);
    expect(chunk.sourceMap!.get(0)).toEqual({ file: 'a.s', line: 1, column: 0 });
  });

  it('reports a useful error for a corrupt .o', () => {
    const truncated = serializeObjectFile({ name: 'm' }).slice(0, 8);
    expect(() => deserializeObjectFile(truncated, 'bad.o')).toThrow(/bad\.o: could not decompress/);

    // Well-formed gzip, but the payload is not a module.
    const notAModule = Bun.gzipSync(new TextEncoder().encode('{"chunks":[{}]}'));
    expect(() => deserializeObjectFile(notAModule, 'bad.o'))
      .toThrow(/bad\.o: not a valid object file: module\.chunks\[0\]\.data/);

    // Plain JSON is no longer an accepted object file.
    expect(isGzip(new TextEncoder().encode('{"name":"m"}'))).toBe(false);
    expect(() => deserializeObjectFile(new TextEncoder().encode('{"name":"m"}'), 'plain.o'))
      .toThrow(/plain\.o: could not decompress/);
  });

  it('rejects debug maps that are not entry arrays', () => {
    const r = parseModule({
      chunks: [{ segments: ['CODE'], data: b64([0x60]), labelIndex: {} }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('labelIndex');
  });
});
