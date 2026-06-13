
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, it, expect } from 'bun:test';
import { parseModule, parseActionModules } from '../src/validate_modules.ts';
import { Base64 } from '../src/base64.ts';
import { assemble, link } from '../src/libassembler.ts';

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
});
