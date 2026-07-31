
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {type Expr} from '../src/expr.ts';
import {Linker} from '../src/linker.ts';
import * as util from '../src/util.ts';

const [_] = [util];

const link = Linker.link;

function off(chunk: number, num: number): Expr {
  return {op: 'num', num, meta: {rel: true, chunk}};
}
function op(op: string, ...args: Expr[]): Expr {
  return {op, args};
}
function num(num: number): Expr {
  return {op: 'num', num};
}

describe('Linker', function() {
  it('should link a simple .org chunk', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(2, 4, 6, 8),
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect([...link(m).chunks()]).toEqual([[50, [2, 4, 6, 8]]]);
  });

  it('should link two simple .org chunks', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(2, 4, 6, 8),
      }, {
        segments: ['code'],
        org: 200,
        data: Uint8Array.of(3, 5, 7, 9),
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect([...link(m).chunks()])
        .toEqual([[50, [2, 4, 6, 8]], [150, [3, 5, 7, 9]]]);
  });

  it('should link .org chunks into the right segment', function() {
    const m = {
      chunks: [{
        segments: ['a', 'b'],
        org: 100,
        data: Uint8Array.of(2, 4, 6, 8),
      }, {
        segments: ['a', 'b'],
        org: 500,
        data: Uint8Array.of(1, 2, 3, 4),
      }],
      segments: [
        {name: 'a', size: 400, offset: 30, memory: 80},
        {name: 'b', size: 400, offset: 1030, memory: 480},
      ],
    };
    expect([...link(m).chunks()])
        .toEqual([[50, [2, 4, 6, 8]], [1050, [1, 2, 3, 4]]]);
  });

  it('should fill in a same-chunk offset expression', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(2, 4, 0xff, 8),
        subs: [{offset: 2, size: 1, expr: off(0, 3)}],
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect([...link(m).chunks()]).toEqual([[50, [2, 4, 103, 8]]]);
  });

  it('should fill in a 4-byte substitution', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(0xff, 0xff, 0xff, 0xff),
        subs: [{offset: 0, size: 4, expr: num(0x12345678)}],
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect([...link(m).chunks()]).toEqual([[50, [0x78, 0x56, 0x34, 0x12]]]);
  });

  it('should fill in an offset from a symbol', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(2, 4, 0xff, 8),
        subs: [{offset: 2, size: 1, expr: {op: 'sym', num: 0}}],
      }, {
        segments: ['code'],
        org: 200,
        data: Uint8Array.of(1, 3, 0xff, 7),
        subs: [{offset: 2, size: 1, expr: {op: 'sym', num: 1}}],
      }],
      symbols: [{
        expr: off(1, 1),
      }, {
        expr: off(0, 2),
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect([...link(m).chunks()])
        .toEqual([[50, [2, 4, 201, 8]], [150, [1, 3, 102, 7]]]);
  });

  it('should handle arithmetic expressions', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(2, 4, 0xff, 8),
        subs: [{offset: 2, size: 1, expr: {op: 'sym', num: 0}}],
      }],
      symbols: [{expr: op('+', num(80), off(0, 1))}],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect([...link(m).chunks()]).toEqual([[50, [2, 4, 181, 8]]]);
  });

  it('should support multiple segments', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 0x100,
        data: Uint8Array.of(2, 4, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: {op: 'sym', num: 0}}],
      }, {
        segments: ['data'],
        org: 0x8123,
        data: Uint8Array.of(1, 1, 2, 3, 5),
      }],
      symbols: [{
        expr: off(1, 3),
      }],
      segments: [{name: 'code', size: 0x400, offset: 0x0010, memory: 0x0000},
                 {name: 'data', size: 0x400, offset: 0x0410, memory: 0x8000}],
    };
    expect([...link(m).chunks()])
        .toEqual([[0x0110, [2, 4, 0x26, 0x81]], [0x0533, [1, 1, 2, 3, 5]]]);
  });

  it('should relocate chunks', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        data: Uint8Array.of(2, 4, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 0)}],
      }, {
        segments: ['code'],
        data: Uint8Array.of(1, 3, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 2)}],
      }],
      segments: [{
        name: 'code',
        size: 0x400, offset: 0x0010, memory: 0xc000,
        free: [[0xc200, 0xc300]],
      }],
    };
    expect([...link(m).chunks()])
        .toEqual([[0x0210, [2, 4, 0x00, 0xc2, 1, 3, 0x02, 0xc2]]]);
  });

  it('should fail to relocate chunks with no free allocations', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        data: Uint8Array.of(2, 4, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 0)}],
      }, {
        segments: ['code'],
        data: Uint8Array.of(1, 3, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 2)}],
      }],
      segments: [{
        name: 'code',
        size: 0x400, offset: 0x0010, memory: 0xc000,
      }],
    };
    expect(() => link(m)).toThrow(/Could not find space/);
  });

  it('should honor a chunk alignment and leave the skipped bytes free',
     function() {
    const m = {
      chunks: [{
        segments: ['a'],
        data: new Uint8Array(13).fill(1),
      }, {
        segments: ['a'],
        align: 16,
        data: Uint8Array.of(2, 2, 2, 2),
      }, {
        segments: ['a'],
        data: Uint8Array.of(3, 3, 3),
      }],
      segments: [{
        name: 'a', size: 128, offset: 0, memory: 0,
        free: [[0, 128]],
      }],
    };
    // Chunks are packed largest-first, so the 13-byte chunk lands at 0 and the
    // aligned one skips to 16 rather than 13 - and the three bytes it skipped
    // stay free for the 3-byte chunk that comes after it.
    expect([...link(m).chunks()])
        .toEqual([[0, [...new Array(13).fill(1), 3, 3, 3, 2, 2, 2, 2]]]);
  });

  it('should align a chunk on its org, not its offset', function() {
    const m = {
      chunks: [{
        segments: ['a'],
        align: 0x100,
        data: Uint8Array.of(2, 4, 6, 8),
      }],
      segments: [{
        name: 'a', size: 0x400, offset: 0x10, memory: 0xc000,
        free: [[0xc001, 0xc400]],
      }],
    };
    // $c100, i.e. file offset $110 - the offset itself is not a multiple of
    // $100, so aligning in offset space would land somewhere else entirely.
    expect([...link(m).chunks()]).toEqual([[0x110, [2, 4, 6, 8]]]);
  });

  it('should pack the biggest chunks in a segment first', function() {
    const m = {
      chunks: [{
        segments: ['a'],
        data: Uint8Array.of(1, 1),
      }, {
        segments: ['a'],
        data: Uint8Array.of(2, 2, 2, 2),
      }, {
        segments: ['a'],
        data: Uint8Array.of(3, 3, 3),
      }],
      segments: [{
        name: 'a', size: 10, offset: 0, memory: 0,
        free: [[0, 10]],
      }],
    };
    // Size order, not the order the chunks were read.
    expect([...link(m).chunks()])
        .toEqual([[0, [2, 2, 2, 2, 3, 3, 3, 1, 1]]]);
  });

  it('should defer to a later segment when the first one is full', function() {
    const m = {
      chunks: [{
        segments: ['a', 'b'],
        data: Uint8Array.of(1, 2, 3, 4),
      }, {
        segments: ['b', 'a'],
        data: Uint8Array.of(5, 6, 7, 8),
      }, {
        segments: ['b', 'a'],
        data: Uint8Array.of(9),
      }],
      segments: [{
        name: 'a', size: 5, offset: 0, memory: 0,
        free: [[0, 5]],
      }, {
        name: 'b', size: 5, offset: 5, memory: 5,
        free: [[5, 10]],
      }],
    };
    // All three prefer 'a', since eligibility is ordered by segment
    // declaration rather than by the order the chunk lists them.  'a' only
    // fits two of them, so the 4-byte chunk that loses the race moves to 'b'.
    expect([...link(m).chunks()])
        .toEqual([[0, [1, 2, 3, 4, 9, 5, 6, 7, 8]]]);
  });

  it('should choose an eligible segment for .reloc chunks', function() {
    const m = {
      chunks: [{
        segments: ['a', 'b'],
        data: Uint8Array.of(1, 3, 5, 7),
      }, {
        segments: ['a'],
        org: 0x80,
        data: Uint8Array.of(2, 4, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 2)}],
      }],
      segments: [{
        name: 'a', size: 6, offset: 0, memory: 0x80,
        free: [[0x80, 0x84]],
      }, {
        name: 'b', size: 100, offset: 100, memory: 0x100,
        free: [[0x100, 0x164]],
      }],
    };
    expect([...link(m).chunks()])
        .toEqual([[0, [2, 4, 0x02, 0x01]], [100, [1, 3, 5, 7]]]);
  });

  it('should overlap segments with common bytes', function() {
    // Sharing bytes only sees data that is already placed, and segments are
    // filled in declaration order, so 'b' has to be declared before 'a' for
    // the shared chunk to find the copy inside the 5-byte chunk.
    const m = {
      chunks: [{
        segments: ['a', 'b'],
        data: Uint8Array.of(3, 5, 7),
      }, {
        segments: ['b'],
        data: Uint8Array.of(1, 3, 5, 7, 9),
      }, {
        segments: ['a'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 2, expr: off(0, 0)}],
      }],
      segments: [{
        name: 'b', size: 100, offset: 100, memory: 100,
        free: [[100, 200]], dedupe: true,
      }, {
        name: 'a', size: 100, offset: 0, memory: 0,
        free: [[0, 100]], dedupe: true,
      }],
    };
    expect([...link(m).chunks()])
        .toEqual([[0, [101, 0]], [100, [1, 3, 5, 7, 9]]]);
  });

  it('should only share bytes in segments that opt in', function() {
    const m = () => ({
      chunks: [{
        segments: ['a'],
        data: Uint8Array.of(1, 3, 5, 7, 9),
      }, {
        segments: ['a'],
        data: Uint8Array.of(3, 5, 7),
      }, {
        segments: ['a'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 2, expr: off(1, 0)}],
      }],
      segments: [{
        name: 'a', size: 100, offset: 0, memory: 0,
        free: [[0, 100]], dedupe: false,
      }],
    });
    // Without :dedupe the 3-byte chunk gets its own space after the 5-byte one.
    expect([...link(m()).chunks()])
        .toEqual([[0, [1, 3, 5, 7, 9, 3, 5, 7, 5, 0]]]);
    // With it, it aliases onto the copy inside the 5-byte chunk at $01.
    const shared = m();
    shared.segments[0].dedupe = true;
    expect([...link(shared).chunks()])
        .toEqual([[0, [1, 3, 5, 7, 9, 1, 0]]]);
  });

  it('should share with existing data', function() {
    const base = Uint8Array.of(
      // starts at 10
      0, 2, 4, 6, 8, 0, 2, 4, 6, 8,
      1, 3, 5, 7, 9, 1, 1, 3, 3, 5, // 21 is the spot: 3 5 7
      5, 7, 7, 9, 9, 0, 0, 0, 2, 2,
      2, 4, 4, 4, 6, 6, 6, 8, 8, 8);
    const m = {
      chunks: [{
        segments: ['a'],
        data: Uint8Array.of(3, 5, 7),
      }, {
        segments: ['a'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 2, expr: off(0, 0)}],
      }],
      segments: [{
        name: 'a', size: 100, offset: 0, memory: 0x8000,
        free: [[0x8005, 0x800a]], dedupe: true,
      }],
    };
    const patch = new Linker().base(base, 10).read(m).link();
    expect([...patch.chunks()]).toEqual([[5, [21, 0x80]]]);
  });

  it('should .move existing data', function() {
    const base = Uint8Array.of(
      // starts at 10
      0, 2, 4, 6, 8, 0, 2, 4, 6, 8,
      1, 3, 5, 7, 9, 1, 1, 3, 3, 5,
      5, 7, 7, 9, 9, 0, 0, 0, 2, 2,
      2, 4, 4, 4, 6, 6, 6, 8, 8, 8);
    const m = {
      chunks: [{
        segments: ['b'],
        data: Uint8Array.of(),
      }, {
        segments: ['a'],
        data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
        subs: [{offset: 0, size: 7, expr: {op: '.move', args: [off(0, 22)]}}],
      }],
      segments: [{
        name: 'a', size: 100, offset: 100, memory: 0,
        free: [[50, 100]],
      }, {name: 'b', size: 40, offset: 0, memory: 0}],
    };
    const patch = new Linker().base(base, 10).read(m).link();
    expect([...patch.chunks()]).toEqual([[150, [5, 7, 9, 1, 1, 3, 3]]]);
  });

  it('should .move existing data from an absolute offset', function() {
    const base = Uint8Array.of(
      // starts at 10
      0, 2, 4, 6, 8, 0, 2, 4, 6, 8,
      1, 3, 5, 7, 9, 1, 1, 3, 3, 5,
      5, 7, 7, 9, 9, 0, 0, 0, 2, 2,
      2, 4, 4, 4, 6, 6, 6, 8, 8, 8);
    const m = {
      chunks: [{
        segments: ['b'],
        data: Uint8Array.of(),
      }, {
        segments: ['a'],
        data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
        subs: [{offset: 0, size: 7, expr: {op: '.move', args: [
          {op: 'num', num: 12, meta: {org: 10, offset: 20}},
        ]}}],
      }],
      segments: [{
        name: 'a', size: 100, offset: 100, memory: 0,
        free: [[50, 100]],
      }, {name: 'b', size: 40, offset: 0, memory: 0}],
    };
    const patch = new Linker().base(base, 10).read(m).link();
    expect([...patch.chunks()]).toEqual([[150, [5, 7, 9, 1, 1, 3, 3]]]);
  });

  it('should resolve bank bytes', function() {
    const m = {
      chunks: [{
        segments: ['a'],
        data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
        subs: [
          {offset: 0, size: 1, expr: op('^', off(1, 0))},
          {offset: 1, size: 2, expr: off(1, 0)},
          {offset: 3, size: 1, expr: op('^', off(2, 0))},
          {offset: 4, size: 2, expr: off(2, 0)},
        ],
      }, {
        segments: ['b'],
        data: Uint8Array.of(1, 3, 5, 7, 9),
      }, {
        segments: ['a'],
        data: Uint8Array.of(2, 4),
      }],
      segments: [{
        name: 'a', size: 100, offset: 0, memory: 0x8000, bank: 8,
        free: [[0x8000, 0x8064]],
      }, {
        name: 'b', size: 100, offset: 100, memory: 0x8000, bank: 9,
        free: [[0x8000, 0x8064]],
      }],
    };
    // Chunks are placed segment by segment, largest first, so the 6-byte chunk
    // takes the front of segment 'a' and the 2-byte one follows it at $8006.
    expect([...link(m).chunks()]).toEqual([
      [0, [9, 0, 0x80, 8, 6, 0x80, 2, 4]],
      [100, [1, 3, 5, 7, 9]],
    ]);
  });

  it('should support imports and exports', function() {
    const m1 = {
      chunks: [{
        segments: ['a'],
        data: Uint8Array.of(3, 5, 0xff),
        subs: [{offset: 2, size: 1, expr: {op: 'im', sym: 'foo'}}],
      }],
      segments: [{
        name: 'a', size: 100, offset: 0, memory: 0,
        free: [[0, 100]],
      }],
    };
    const m2 = {
      chunks: [{
        segments: ['b'],
        data: Uint8Array.of(1, 2, 3),
      }],
      symbols: [{export: 'foo', expr: off(0, 1)}],
      segments: [{
        name: 'b', size: 100, offset: 100, memory: 100,
        free: [[100, 200]],
      }],
    };
    expect([...link(m1, m2).chunks()])
        .toEqual([[0, [3, 5, 101]], [100, [1, 2, 3]]]);
  });

  it('should check a passing assert', function() {
    const m = {
      chunks: [{
        segments: ['a'],
        org: 100,
        data: Uint8Array.of(2, 4, 6, 8),
        asserts: [op('=', off(0, 4), num(104))],
      }],
      segments: [{name: 'a', size: 100, offset: 100, memory: 100}],
    };
    expect([...link(m).chunks()]).toEqual([[100, [2, 4, 6, 8]]]);
  });

  it('should check a failing assert', function() {
    const m = {
      chunks: [{
        segments: ['a'],
        org: 100,
        data: Uint8Array.of(2, 4, 6, 8),
        asserts: [op('=', off(0, 4), num(105))],
      }],
      segments: [{name: 'a', size: 100, offset: 100, memory: 100}],
    };
    expect(() => link(m)).toThrow(/Assertion failed/);
  });

  it('should support circular references', function() {
    const m = {
      chunks: [{
        segments: ['a'],
        data: Uint8Array.of(3, 5, 0xff, 0xff, 7, 9),
        subs: [{offset: 2, size: 2, expr: off(1, 0)}],
      }, {
        segments: ['a'],
        data: Uint8Array.of(2, 0xff, 0xff, 4),
        subs: [{offset: 1, size: 2, expr: off(0, 0)}],
      }],
      segments: [{
        name: 'a', size: 0x2000, offset: 0, memory: 0x8000,
        free: [[0x8000, 0xa000]],
      }],
    };
    // Placement order is fixed (largest first) rather than following the
    // dependency graph, so the cycle is broken by placing the 6-byte chunk
    // first and letting the 4-byte one resolve against it afterwards.
    expect([...link(m).chunks()])
        .toEqual([[0, [3, 5, 0x06, 0x80, 7, 9, 2, 0x00, 0x80, 4]]]);
  });

  // RAM segment tests
  it('should not output chunks from RAM segments', function() {
    const m = {
      chunks: [{
        segments: ['ram'],
        org: 0,
        data: Uint8Array.of(0, 0, 0, 0),
      }, {
        segments: ['code'],
        org: 0x8000,
        data: Uint8Array.of(0xa9, 0x00),
      }],
      segments: [
        {name: 'ram', size: 256, memory: 0, free: [[0x10, 0x20]]},
        {name: 'code', size: 0x8000, offset: 0x10, memory: 0x8000}
      ],
    };
    expect([...link(m).chunks()]).toEqual([[0x10, [0xa9, 0x00]]]);
  });

  it('should treat segments without offset as RAM', function() {
    const m = {
      chunks: [{
        segments: ['zp'],
        org: 0,
        data: Uint8Array.of(0, 0),
      }, {
        segments: ['code'],
        org: 0x8000,
        data: Uint8Array.of(0xa5, 0x00),
      }],
      segments: [
        {name: 'zp', size: 256, memory: 0, free: [[0x10, 0x20]]},
        {name: 'code', size: 0x8000, offset: 0x10, memory: 0x8000}
      ],
    };
    expect([...link(m).chunks()]).toEqual([[0x10, [0xa5, 0x00]]]);
  });

  it('should resolve RAM symbols in ROM code', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 0x8000,
        data: Uint8Array.of(0xa5, 0xff),
        subs: [{offset: 1, size: 1, expr: {op: 'sym', num: 0}}],
      }],
      symbols: [{
        expr: {op: 'num', num: 0x42, meta: {size: 1}},
      }],
      segments: [
        {name: 'zp', size: 256, memory: 0},
        {name: 'code', size: 0x8000, offset: 0x10, memory: 0x8000}
      ],
    };
    expect([...link(m).chunks()]).toEqual([[0x10, [0xa5, 0x42]]]);
  });

  it('should allocate relocatable chunks in RAM free space', function() {
    const m = {
      chunks: [{
        segments: ['zp'],
        // No org = relocatable, will be allocated from free space
        data: Uint8Array.of(0, 0, 0, 0),  // 4 bytes
      }, {
        segments: ['code'],
        org: 0x8000,
        data: Uint8Array.of(0xa5, 0xff),  // lda $xx
        subs: [{offset: 1, size: 1, expr: off(0, 0)}],  // Reference start of chunk 0
      }],
      segments: [
        {name: 'zp', size: 256, memory: 0, free: [[0x10, 0x20]]},
        {name: 'code', size: 0x8000, offset: 0x10, memory: 0x8000}
      ],
    };
    // RAM chunk allocated at $10 (start of free space), ROM references it
    expect([...link(m).chunks()]).toEqual([[0x10, [0xa5, 0x10]]]);
  });

  it('should allocate multiple RAM chunks without overlap', function() {
    const m = {
      chunks: [{
        segments: ['zp'],
        data: Uint8Array.of(0, 0, 0, 0),  // 4 bytes
      }, {
        segments: ['zp'],
        data: Uint8Array.of(0, 0),  // 2 bytes
      }, {
        segments: ['code'],
        org: 0x8000,
        data: Uint8Array.of(0xa5, 0xff, 0xa5, 0xff),
        subs: [
          {offset: 1, size: 1, expr: off(0, 0)},  // Reference chunk 0
          {offset: 3, size: 1, expr: off(1, 0)},  // Reference chunk 1
        ],
      }],
      segments: [
        {name: 'zp', size: 256, memory: 0, free: [[0x10, 0x20]]},
        {name: 'code', size: 0x8000, offset: 0x10, memory: 0x8000}
      ],
    };
    // Both RAM chunks allocated, no overlap
    const result = [...link(m).chunks()];
    expect(result.length).toBe(1);  // Only ROM chunk in output
    // The addresses should be different (allocated sequentially)
    const [_offset, data] = result[0];
    expect(data[1]).not.toBe(data[3]);  // Different addresses
  });
});
