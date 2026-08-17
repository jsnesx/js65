
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {type Expr} from '../src/expr.ts';
import {ErrorCollector} from '../src/error.ts';
import {FreeSpace, Linker} from '../src/linker.ts';
import {type Module, type Segment} from '../src/module.ts';
import {SourceError} from '../src/token.ts';
import * as util from '../src/util.ts';

const link = Linker.link;

/** Convert the chunks to plain number arrays for testing. */
function chunks(a: util.SparseByteArray): Array<[number, number[]]> {
  return [...a.chunks()].map(([start, data]) => [start, [...data]]);
}

function off(chunk: number, num: number): Expr {
  return {op: 'num', num, meta: {rel: true, chunk}};
}
function op(op: string, ...args: Expr[]): Expr {
  return {op, args};
}
function num(num: number): Expr {
  return {op: 'num', num};
}
function imp(sym: string): Expr {
  return {op: 'im', sym};
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
    expect(chunks(link(m))).toEqual([[50, [2, 4, 6, 8]]]);
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m))).toEqual([[50, [2, 4, 103, 8]]]);
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
    expect(chunks(link(m))).toEqual([[50, [0x78, 0x56, 0x34, 0x12]]]);
  });

  // `force_range` feature, which the assembler records on each
  // substitution it emits because the range check happens here in the linker.
  it('should reject a value too big for its substitution', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 1, expr: num(0x1234)}],
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect(() => link(m)).toThrow(/Not a byte/);
  });

  it('should truncate an oversized substitution marked forceRange', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 1, expr: num(0x1234), forceRange: true}],
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect(chunks(link(m))).toEqual([[50, [0x34, 0xff]]]);
  });

  it('should truncate an out-of-range branch marked forceRange', function() {
    const m = {
      chunks: [{
        segments: ['code'],
        org: 100,
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 1, size: 1,
                expr: {op: 'num', num: 200, meta: {branch: true}},
                forceRange: true}],
      }],
      segments: [{name: 'code', size: 400, offset: 30, memory: 80}],
    };
    expect(chunks(link(m))).toEqual([[50, [0xff, 200]]]);
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m))).toEqual([[50, [2, 4, 181, 8]]]);
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m)))
        .toEqual([[0x0210, [2, 4, 0x00, 0xc2, 1, 3, 0x02, 0xc2]]]);
  });

  it('should fail to relocate chunks that do not fit', function() {
    // The segment freed the whole of itself, so running out of space means
    // declaring a segment too small to hold them.
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
        size: 4, offset: 0x0010, memory: 0xc000,
        free: [[0xc000, 0xc004]],
      }],
    };
    expect(() => link(m)).toThrow(/Could not find space/);
  });

  it('should keep a segment with no free ranges of its own to itself',
     function() {
    // The segment may well be describing a ROM that already exists, so the
    // linker has nothing to hand out until something says otherwise.
    const m = {
      chunks: [{
        segments: ['code'],
        data: Uint8Array.of(2, 4, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 0)}],
      }],
      segments: [{
        name: 'code',
        size: 0x400, offset: 0x0010, memory: 0xc000,
      }],
    };
    expect(() => link(m)).toThrow(/Could not find space/);
  });

  it('should fill a segment that a :fill blanks out', function() {
    // A fill overwrites whatever was there, so the whole segment is free.
    const m = {
      chunks: [{
        segments: ['code'],
        data: Uint8Array.of(2, 4, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 0)}],
      }],
      segments: [{
        name: 'code',
        size: 0x400, offset: 0x0010, memory: 0xc000, fill: 0,
      }],
    };
    expect(chunks(link(m))[0]?.[1]?.slice(0, 4)).toEqual([2, 4, 0x00, 0xc0]);
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m))).toEqual([[0x110, [2, 4, 6, 8]]]);
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m)))
        .toEqual([[0, [1, 2, 3, 4, 9, 5, 6, 7, 8]]]);
  });

  it('should measure an unmapped segment and pack it into the mapped one', function() {
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(1, 1, 1, 1),
      }, {
        segments: ['DATA'],
        data: Uint8Array.of(2, 2, 2),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'CODE', load: 'PRG'},
        {name: 'DATA', load: 'PRG'},
      ],
    };
    // Neither unmapped segment declares a size, so each one is measured from its
    // contents and they pack tight against each other in the mapped one.
    expect(chunks(link(m))).toEqual([[0x10, [1, 1, 1, 1, 2, 2, 2]]]);
  });

  it('should measure an unmapped segment independently of the mapped one', function() {
    const m = (memory: number) => ({
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(1, 1, 1, 1),
      }, {
        segments: ['DATA'],
        data: Uint8Array.of(2, 2, 2),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory, out: '%O',
         free: [[memory, memory + 0x100]]},
        {name: 'CODE', load: 'PRG'},
        {name: 'DATA', load: 'PRG'},
      ],
    });
    // Sizing is segment-relative, so moving the mapped one does not change it.
    expect(chunks(link(m(0x8000)))).toEqual(chunks(link(m(0x9000))));
  });

  it('should align an unmapped segment within the mapped one', function() {
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(1, 1, 1),
      }, {
        segments: ['DATA'],
        data: Uint8Array.of(2, 2),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'CODE', load: 'PRG'},
        {name: 'DATA', load: 'PRG', align: 16},
      ],
    };
    // DATA's alignment bumps PRG's cursor from $8003 to $8010.
    expect(chunks(link(m)))
        .toEqual([[0x10, [1, 1, 1]], [0x20, [2, 2]]]);
  });

  it('should run an unmapped segment somewhere it does not load', function() {
    const m = {
      chunks: [{
        segments: ['BOOT'],
        data: Uint8Array.of(0xaa, 0xbb, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 0)}],
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(1, 2),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'RAM', size: 0x100, memory: 0x300},
        {name: 'BOOT', load: 'PRG', run: 'RAM'},
        {name: 'CODE', load: 'PRG'},
      ],
    };
    // BOOT's labels resolve against its run address in RAM ($300), but its
    // bytes are written into the file space PRG gave it - and PRG is charged
    // for them, so CODE starts after BOOT rather than on top of it.
    expect(chunks(link(m)))
        .toEqual([[0x10, [0xaa, 0xbb, 0x00, 0x03, 1, 2]]]);
  });

  it('should align an unmapped segment\'s load without moving its run address',
     function() {
    const m = {
      chunks: [{
        segments: ['A'],
        data: Uint8Array.of(0xff, 0xff, 7),
        subs: [{offset: 0, size: 2, expr: off(1, 0)}],
      }, {
        segments: ['B'],
        data: Uint8Array.of(2, 2),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'RAM', size: 0x100, memory: 0x300},
        {name: 'A', load: 'PRG', run: 'RAM'},
        {name: 'B', load: 'PRG', run: 'RAM', alignLoad: 16},
      ],
    };
    // B still runs tight against A at $303, but loads at the next multiple of
    // 16 in the file.
    expect(chunks(link(m)))
        .toEqual([[0x10, [0x03, 0x03, 7]], [0x20, [2, 2]]]);
  });

  it('should give a bss segment address space but no output', function() {
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(0xa5, 0xff, 0xa5, 0xff),
        subs: [
          {offset: 1, size: 1, expr: off(1, 0)},
          {offset: 3, size: 1, expr: off(2, 0)},
        ],
      }, {
        segments: ['VARS'],
        data: new Uint8Array(4),
      }, {
        segments: ['MORE'],
        data: new Uint8Array(2),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'ZP', size: 0x100, memory: 0x00},
        {name: 'CODE', load: 'PRG'},
        {name: 'VARS', run: 'ZP'},
        {name: 'MORE', run: 'ZP'},
      ],
    };
    // The two zero page segments stack up in address space and emit nothing.
    expect(chunks(link(m))).toEqual([[0x10, [0xa5, 0x00, 0xa5, 0x04]]]);
  });

  it('should throw when an unmapped segment overflows the mapped one', function() {
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(1, 1, 1, 1),
      }, {
        segments: ['DATA'],
        data: Uint8Array.of(2, 2),
      }],
      segments: [
        {name: 'PRG', size: 4, offset: 0x10, memory: 0x8000, out: '%O'},
        {name: 'CODE', load: 'PRG'},
        {name: 'DATA', load: 'PRG'},
      ],
    };
    expect(() => link(m)).toThrow(/Segment DATA .* does not fit in PRG/);
  });

  it('should throw when an unmapped segment holds a .org chunk with no address',
     function() {
    const m = {
      chunks: [{
        segments: ['CODE'],
        org: 0x8000,
        data: Uint8Array.of(1, 1),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'CODE', load: 'PRG'},
      ],
    };
    expect(() => link(m)).toThrow(/no address of its own/);
  });

  it('should throw when a .org chunk runs off the end of its segment',
     function() {
    const m = {
      chunks: [{
        segments: ['PRG'],
        org: 0x8002,
        data: Uint8Array.of(1, 1, 1, 1),
      }],
      segments: [
        {name: 'PRG', size: 4, offset: 0x10, memory: 0x8000, out: '%O'},
      ],
    };
    // The org itself is in range, so only an end check catches this.
    expect(() => link(m))
        .toThrow(/Chunk \(\$4 bytes at \$8002\) does not fit in segment PRG/);
  });

  it('should size an unmapped segment around a .org chunk', function() {
    const m = {
      chunks: [{
        segments: ['CODE'],
        org: 0x8004,
        data: Uint8Array.of(1, 1),
      }, {
        segments: ['DATA'],
        data: Uint8Array.of(2, 2),
      }],
      segments: [
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'CODE', load: 'PRG', memory: 0x8000},
        {name: 'DATA', load: 'PRG'},
      ],
    };
    // CODE is measured out to the end of its .org chunk, so DATA starts after
    // it rather than on top of it.
    expect(chunks(link(m))).toEqual([[0x14, [1, 1, 2, 2]]]);
  });

  it('should hand out file offsets in declaration order', function() {
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(1, 1, 1, 1),
      }, {
        segments: ['FTR'],
        data: Uint8Array.of(9, 9),
      }],
      segments: [
        {name: 'HDR', size: 0x10, offset: 0, memory: 0, out: '%O',
         free: [[0, 0x10]]},
        {name: 'PRG', size: 0x100, memory: 0x8000, out: '%O',
         free: [[0x8000, 0x8100]]},
        {name: 'FTR', size: 0x20, memory: 0, out: '%O', free: [[0, 0x20]]},
        {name: 'CODE', load: 'PRG'},
      ],
    };
    // PRG takes the cursor left by the header, and since it has no fill it
    // only advances the cursor by the four bytes CODE actually needed - so
    // FTR starts at $14 rather than at the end of PRG's declared size.
    expect(chunks(link(m))).toEqual([[0x10, [1, 1, 1, 1, 9, 9]]]);
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m())))
        .toEqual([[0, [1, 3, 5, 7, 9, 3, 5, 7, 5, 0]]]);
    // With it, it aliases onto the copy inside the 5-byte chunk at $01.
    const shared = m();
    shared.segments[0].dedupe = true;
    expect(chunks(link(shared)))
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
    expect(chunks(patch)).toEqual([[5, [21, 0x80]]]);
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
    expect(chunks(patch)).toEqual([[150, [5, 7, 9, 1, 1, 3, 3]]]);
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
    expect(chunks(patch)).toEqual([[150, [5, 7, 9, 1, 1, 3, 3]]]);
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
    expect(chunks(link(m))).toEqual([
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
    expect(chunks(link(m1, m2)))
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
    expect(chunks(link(m))).toEqual([[100, [2, 4, 6, 8]]]);
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
    expect(chunks(link(m)))
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
    expect(chunks(link(m))).toEqual([[0x10, [0xa9, 0x00]]]);
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
    expect(chunks(link(m))).toEqual([[0x10, [0xa5, 0x00]]]);
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
    expect(chunks(link(m))).toEqual([[0x10, [0xa5, 0x42]]]);
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
    expect(chunks(link(m))).toEqual([[0x10, [0xa5, 0x10]]]);
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
    const result = chunks(link(m));
    expect(result.length).toBe(1);  // Only ROM chunk in output
    // The addresses should be different (allocated sequentially)
    const [_offset, data] = result[0];
    expect(data[1]).not.toBe(data[3]);  // Different addresses
  });

  it('should reject an unknown target', function() {
    // Real build systems pass ld65's platform names; without this the link
    // would go ahead with no layout at all and fail somewhere much less useful.
    const m = {
      chunks: [{segments: ['code'], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [{name: 'code', size: 0x8000, offset: 0x10, memory: 0x8000}],
    };
    const linker = new Linker({target: 'nes'});
    expect(() => linker.read(m).link())
        .toThrow(/Unknown target: nes.*sim, nes-nrom/);
  });

  it('should place the ca65 predeclared segments in a built-in target', function() {
    // `.code` and friends are shorthand for the uppercase ca65 names, so a
    // target spelling them any other way leaves those chunks with nowhere to go.
    const m = {
      chunks: [
        {segments: ['CODE'], data: Uint8Array.of(0x60)},
        {segments: ['RODATA'], data: Uint8Array.of(1, 2, 3)},
        {segments: ['DATA'], data: Uint8Array.of(0xaa)},
        {segments: ['ZEROPAGE'], data: Uint8Array.of()},
      ],
      segments: [],
    };
    const linker = new Linker({target: 'nes-nrom'});
    // Header at $00, then PRG: the three ROM segments share one window, so
    // they hand out consecutive space rather than colliding.
    expect([...linker.read(m).link().slice(0x10, 0x15)])
        .toEqual([0x60, 1, 2, 3, 0xaa]);
  });

  it('should report a chunk whose segment nobody declared', function() {
    // Nothing downstream can place this, and before it was reported the chunk
    // fell out of both placement passes and only turned up as an `Absent:`
    // failure from the output writer, well after the cause was forgettable.
    const m = {
      chunks: [{segments: ['NOWHERE'], data: Uint8Array.of(1, 2)}],
      segments: [{name: 'code', size: 0x8000, offset: 0x10, memory: 0x8000}],
    };
    expect(() => link(m)).toThrow(/Unknown segment: NOWHERE/);
  });
  describe('mirror placement', function() {
    it('should write an .org mirror at the same org in every segment', function() {
      const vectors = [0x10, 0x90, 0x00, 0x80, 0x20, 0x90];
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['PRG0', 'PRG1', 'PRG2', 'PRG3'],
          org: 0xfffa,
          data: Uint8Array.of(...vectors),
        }, {
          // A reference to a mirror label resolves to the single shared org.
          segments: ['PRG0'],
          data: Uint8Array.of(0xff, 0xff),
          subs: [{offset: 0, size: 2, expr: off(0, 0)}],
        }],
        segments: [{
          name: 'PRG0', size: 0x8000, memory: 0x8000, offset: 0x00000,
          free: [[0x8000, 0x10000]],
        }, {
          name: 'PRG1', size: 0x8000, memory: 0x8000, offset: 0x08000,
          free: [[0x8000, 0x10000]],
        }, {
          name: 'PRG2', size: 0x8000, memory: 0x8000, offset: 0x10000,
          free: [[0x8000, 0x10000]],
        }, {
          name: 'PRG3', size: 0x8000, memory: 0x8000, offset: 0x18000,
          free: [[0x8000, 0x10000]],
        }],
      };
      // The word in PRG0 sees $fffa; each bank's file offset holds the same
      // six bytes (org $fffa + each segment's own delta).
      expect(chunks(link(m))).toEqual([
        [0x00000, [0xfa, 0xff]],
        [0x07ffa, vectors],
        [0x0fffa, vectors],
        [0x17ffa, vectors],
        [0x1fffa, vectors],
      ]);
    });

    it('should place a reloc mirror at one org and consume space in every ' +
       'segment', function() {
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          data: Uint8Array.of(0xa9, 0x42, 0x60, 0xff, 0xff),
          // A word back into the mirror itself, resolved to the shared org.
          subs: [{offset: 3, size: 2, expr: off(0, 0)}],
        }, {
          segments: ['A'],
          data: Uint8Array.of(0x0b),
        }, {
          segments: ['B'],
          data: Uint8Array.of(0x16),
        }],
        segments: [{
          name: 'A', size: 0x100, offset: 0x000, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          name: 'B', size: 0x100, offset: 0x100, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }],
      };
      // The mirror holds org $8000 in both banks, with identical reference
      // bytes, and each bank's own next chunk packs right after its copy.
      expect(chunks(link(m))).toEqual([
        [0x000, [0xa9, 0x42, 0x60, 0x00, 0x80, 0x0b]],
        [0x100, [0xa9, 0x42, 0x60, 0x00, 0x80, 0x16]],
      ]);
    });

    it('should align a reloc mirror inside the intersected free space',
       function() {
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          align: 4,
          data: Uint8Array.of(1, 2),
        }],
        segments: [{
          name: 'A', size: 0x100, offset: 0x000, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          // B's usable range starts mid-flow, so the shared org has to skip
          // ahead to the next 4-aligned address inside the intersection.
          name: 'B', size: 0x100, offset: 0x100, memory: 0x8000,
          free: [[0x8003, 0x8100]],
        }],
      };
      expect(chunks(link(m))).toEqual([[0x004, [1, 2]], [0x104, [1, 2]]]);
    });

    it('should fail a reloc mirror that does not fit every segment',
       function() {
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          data: new Uint8Array(16).fill(1),
        }],
        segments: [{
          name: 'A', size: 0x100, offset: 0x000, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          // B only freed 8 bytes, so the intersection cannot hold 16.
          name: 'B', size: 0x100, offset: 0x100, memory: 0x8000,
          free: [[0x8000, 0x8008]],
        }],
      };
      expect(() => link(m)).toThrow(/mirrored across A & B/);
    });

    it('should reject an .org mirror whose org is outside a listed segment',
       function() {
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          org: 0x9100,
          data: Uint8Array.of(1, 2, 3, 4),
        }],
        segments: [{
          name: 'A', size: 0x1000, offset: 0x0000, memory: 0x8000,
          free: [[0x8000, 0x9000]],
        }, {
          name: 'B', size: 0x1000, offset: 0x1000, memory: 0x9000,
          free: [[0x9000, 0xa000]],
        }],
      };
      // $9100 is inside B only; the error must name A as the offender.
      expect(() => link(m)).toThrow(/A/);
    });

    it('should reject an .org mirror that runs off a listed segment',
       function() {
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          org: 0x8700,
          data: new Uint8Array(0x200).fill(1),
        }],
        segments: [{
          name: 'A', size: 0x1000, offset: 0x0000, memory: 0x8000,
          free: [[0x8000, 0x9000]],
        }, {
          // B ends at $8800, so the chunk fits in A but not in B.
          name: 'B', size: 0x800, offset: 0x1000, memory: 0x8000,
          free: [[0x8000, 0x8800]],
        }],
      };
      expect(() => link(m)).toThrow(/B/);
    });

    it('should resolve ^ on a mirror label to bank 0 with one warning',
       function() {
      const ec = new ErrorCollector();
      const linker = new Linker({errorCollector: ec});
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          data: Uint8Array.of(0x60),
        }, {
          segments: ['CODE'],
          data: Uint8Array.of(0xff),
          subs: [{offset: 0, size: 1, expr: op('^', off(0, 0))}],
        }],
        segments: [{
          name: 'A', bank: 3, size: 0x100, offset: 0x000, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          name: 'B', bank: 5, size: 0x100, offset: 0x100, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          name: 'CODE', bank: 7, size: 0x100, offset: 0x200, memory: 0xa000,
          free: [[0xa000, 0xa100]],
        }],
      };
      // Not bank 3 (the primary segment's bank): mirrors have no single bank.
      expect(chunks(linker.read(m).link())).toEqual(
          [[0x000, [0x60]], [0x100, [0x60]], [0x200, [0x00]]]);
      expect(ec.hasErrors()).toBe(false);
      const warnings = ec.getMessages().filter(msg => msg.level === 'warning');
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toMatch(/bank/i);
    });

    it('should export a mirror label with bank 0 and a warning', function() {
      const ec = new ErrorCollector();
      const linker = new Linker({errorCollector: ec});
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          data: Uint8Array.of(0x60),
        }],
        symbols: [{export: 'Tramp', expr: off(0, 0)}],
        segments: [{
          name: 'A', bank: 3, size: 0x100, offset: 0x000, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          name: 'B', bank: 5, size: 0x100, offset: 0x100, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }],
      };
      linker.read(m).link();
      expect(linker.exports().get('Tramp'))
          .toMatchObject({value: 0x8000, bank: 0});
      expect(ec.getMessages().filter(m => m.level === 'warning').length)
          .toBe(1);
    });

    it('should not dedupe a mirror chunk even when the bytes already exist',
       function() {
      const m = {
        chunks: [{
          segments: ['A'],
          org: 0x8000,
          data: Uint8Array.of(1, 2, 3),
        }, {
          placement: 'all' as const,
          segments: ['A', 'B'],
          data: Uint8Array.of(1, 2, 3),
        }],
        segments: [{
          name: 'A', size: 0x100, offset: 0x000, memory: 0x8000,
          free: [[0x8000, 0x8100]], dedupe: true,
        }, {
          name: 'B', size: 0x100, offset: 0x100, memory: 0x8000,
          free: [[0x8000, 0x8100]], dedupe: true,
        }],
      };
      // Duplicating the bytes is the point, so the mirror is written again in
      // both segments rather than matching the copy already in A.
      expect(chunks(link(m))).toEqual([
        [0x000, [1, 2, 3, 1, 2, 3]],
        [0x103, [1, 2, 3]],
      ]);
    });

    it('should park an empty mirror chunk like a bare label', function() {
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['A', 'B'],
          data: Uint8Array.of(),
        }, {
          segments: ['CODE'],
          data: Uint8Array.of(0xff, 0xff),
          subs: [{offset: 0, size: 2, expr: off(0, 0)}],
        }],
        segments: [{
          name: 'A', size: 0x100, offset: 0x000, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          name: 'B', size: 0x100, offset: 0x100, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }, {
          name: 'CODE', size: 0x100, offset: 0x200, memory: 0xa000,
          free: [[0xa000, 0xa100]],
        }],
      };
      expect(chunks(link(m))).toEqual([[0x200, [0x00, 0x80]]]);
    });

    it('should mirror across RAM segments without writing image bytes',
       function() {
      const m = {
        chunks: [{
          placement: 'all' as const,
          segments: ['RAM0', 'RAM1'],
          data: Uint8Array.of(0, 0, 0, 0),
        }, {
          segments: ['RAM0'],
          data: Uint8Array.of(0, 0),
        }, {
          segments: ['RAM1'],
          data: Uint8Array.of(0, 0),
        }, {
          segments: ['CODE'],
          data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
          subs: [
            {offset: 0, size: 2, expr: off(0, 0)},
            {offset: 2, size: 2, expr: off(1, 0)},
            {offset: 4, size: 2, expr: off(2, 0)},
          ],
        }],
        segments: [{
          name: 'RAM0', memory: 0x300, size: 0x100, bss: true,
        }, {
          name: 'RAM1', memory: 0x300, size: 0x100, bss: true,
        }, {
          name: 'CODE', size: 0x100, offset: 0, memory: 0x8000,
          free: [[0x8000, 0x8100]],
        }],
      };
      // Both RAM areas give up the mirrored range at org $300, so each area's
      // own next chunk lands after it and all three labels share their orgs.
      expect(chunks(link(m)))
          .toEqual([[0, [0x00, 0x03, 0x04, 0x03, 0x04, 0x03]]]);
    });
  });

  // A `:mirror`/`:pool` declaration names a list of segments. The assembler
  // expands the ones it can see, so what reaches the linker is either an
  // already-expanded chunk or a bare name it has to resolve here.
  describe('composite segments', function() {
    const AREAS: Segment[] = [{
      name: 'A', size: 0x8, offset: 0x0, memory: 0x8000, fill: 0,
      free: [[0x8000, 0x8008]],
    }, {
      name: 'B', size: 0x8, offset: 0x8, memory: 0x8000, fill: 0,
      free: [[0x8000, 0x8008]],
    }];

    it('should mirror a chunk that names a mirror composite', function() {
      const m = {
        chunks: [{segments: ['COMMON'], data: Uint8Array.of(0xa9, 0x42, 0x60)}],
        segments: [...AREAS, {name: 'COMMON', mirror: ['A', 'B']}],
      };
      expect(chunks(link(m))).toEqual([
        [0, [0xa9, 0x42, 0x60, 0, 0, 0, 0, 0,
             0xa9, 0x42, 0x60, 0, 0, 0, 0, 0]],
      ]);
    });

    it('should spread chunks that name a pool composite', function() {
      const m = {
        chunks: [
          {segments: ['MUSIC'], data: Uint8Array.of(1, 2, 3, 4, 5)},
          {segments: ['MUSIC'], data: Uint8Array.of(6, 7, 8, 9)},
        ],
        segments: [...AREAS, {name: 'MUSIC', pool: ['A', 'B']}],
      };
      // The first chunk leaves A too full for the second, which spills into B
      // rather than being mirrored.
      expect(chunks(link(m))).toEqual([
        [0, [1, 2, 3, 4, 5, 0, 0, 0,
             6, 7, 8, 9, 0, 0, 0, 0]],
      ]);
    });

    // A pool name and the comma list it stands for have to place identically -
    // the alias adds a name, not a placement mode.
    it('should place a pool composite exactly like the comma list', function() {
      const data = [Uint8Array.of(1, 2, 3, 4, 5), Uint8Array.of(6, 7, 8, 9)];
      const viaName = {
        chunks: data.map(d => ({segments: ['MUSIC'], data: d})),
        segments: [...AREAS, {name: 'MUSIC', pool: ['A', 'B']}],
      };
      const viaList = {
        chunks: data.map(d => ({segments: ['A', 'B'], data: d})),
        segments: [...AREAS],
      };
      expect(chunks(link(viaName))).toEqual(chunks(link(viaList)));
    });

    // Likewise a mirror name against the `&` shorthand's expansion.
    it('should place a mirror composite exactly like the explicit list',
       function() {
      const data = Uint8Array.of(0xa9, 0x42, 0x60);
      const viaName = {
        chunks: [{segments: ['COMMON'], data}],
        segments: [...AREAS, {name: 'COMMON', mirror: ['A', 'B']}],
      };
      const viaList = {
        chunks: [{segments: ['A', 'B'], placement: 'all' as const, data}],
        segments: [...AREAS],
      };
      expect(chunks(link(viaName))).toEqual(chunks(link(viaList)));
    });

    // The reason expansion belongs here and not in the assembler: the module
    // that uses the name never saw the declaration.
    it('should resolve an composite declared in another module', function() {
      const declaring = {segments: [...AREAS, {name: 'COMMON', mirror: ['A', 'B']}]};
      const using = {
        chunks: [{segments: ['COMMON'], data: Uint8Array.of(0x60)}],
      };
      expect(chunks(link(using, declaring))).toEqual([
        [0, [0x60, 0, 0, 0, 0, 0, 0, 0,
             0x60, 0, 0, 0, 0, 0, 0, 0]],
      ]);
    });

    it('should resolve a label in a mirror composite to the shared org',
       function() {
      const m = {
        chunks: [{
          segments: ['COMMON'],
          data: Uint8Array.of(0x60, 0xff, 0xff),
          subs: [{offset: 1, size: 2, expr: off(0, 0)}],
        }],
        segments: [...AREAS, {name: 'COMMON', mirror: ['A', 'B']}],
      };
      expect(chunks(link(m))).toEqual([
        [0, [0x60, 0x00, 0x80, 0, 0, 0, 0, 0,
             0x60, 0x00, 0x80, 0, 0, 0, 0, 0]],
      ]);
    });

    it('should reject an composite listing an unknown segment', function() {
      const m = {
        chunks: [{segments: ['COMMON'], data: Uint8Array.of(1)}],
        segments: [...AREAS, {name: 'COMMON', mirror: ['A', 'NOPE']}],
      };
      expect(() => link(m)).toThrow(/NOPE/);
    });

    it('should reject a nested composite', function() {
      const m = {
        chunks: [{segments: ['OUTER'], data: Uint8Array.of(1)}],
        segments: [...AREAS, {name: 'INNER', mirror: ['A', 'B']},
                   {name: 'OUTER', mirror: ['A', 'INNER']}],
      };
      expect(() => link(m)).toThrow(/Nesting/i);
    });

    it('should reject an composite name mixed with other segments', function() {
      const m = {
        chunks: [{segments: ['COMMON', 'A'], data: Uint8Array.of(1)}],
        segments: [...AREAS, {name: 'COMMON', mirror: ['A', 'B']}],
      };
      expect(() => link(m)).toThrow(/cannot be combined/i);
    });

    it('should drop an unreferenced optional composite', function() {
      const m = {
        chunks: [{segments: ['A'], data: Uint8Array.of(1)}],
        // Members don't even have to exist when the alias goes unused.
        segments: [...AREAS,
                   {name: 'UNUSED', mirror: ['NOPE1', 'NOPE2'], optional: true}],
      };
      expect(chunks(link(m))).toEqual([
        [0, [1, 0, 0, 0, 0, 0, 0, 0,
             0, 0, 0, 0, 0, 0, 0, 0]],
      ]);
    });
  });
});

describe('Linker with an ld65 config', function() {

  function linkerCfg(cfg: string, ...modules: Module[]) {
    const linker = new Linker({linkerConfig: cfg, linkerConfigName: 'test.cfg'});
    for (const m of modules) linker.read(m);
    return linker;
  }

  function linkCfg(cfg: string, ...modules: Module[]) {
    return linkerCfg(cfg, ...modules).link();
  }

  it('should lay out its areas in declaration order', function() {
    const cfg = `
      MEMORY {
        ZP:  start = $00,   size = $100;
        RAM: start = $200,  size = $100;
        HDR: start = $0000, size = $4,  file = %O, fill = yes;
        PRG: start = $8000, size = $20, file = %O, fill = yes, fillval = $ff;
      }
      SEGMENTS {
        ZEROPAGE: load = ZP,  type = zp;
        BSS:      load = RAM, type = bss;
        HEADER:   load = HDR;
        CODE:     load = PRG;
        DATA:     load = PRG;
      }`;
    const m = {
      chunks: [
        {segments: ['HEADER'], data: Uint8Array.of(1, 2, 3)},
        {segments: ['CODE'], data: Uint8Array.of(10, 11)},
        {segments: ['DATA'], data: Uint8Array.of(20)},
        {segments: ['BSS'], data: Uint8Array.of(0, 0)},
      ],
    };
    // HDR takes the front of the file because it is declared first, and PRG
    // follows it at $4.  Both areas fill their whole declared size; the RAM
    // areas take no file space at all and the BSS chunk emits nothing.
    expect(chunks(linkCfg(cfg, m))).toEqual([
      [0, [1, 2, 3, 0, 10, 11, 20, ...new Array(29).fill(0xff)]],
    ]);
  });

  it('should collapse a segment into its same-named area', function() {
    const cfg = `
      MEMORY {
        ZEROPAGE: start = $00,   size = $100;
        PRG:      start = $8000, size = $8, file = %O;
      }
      SEGMENTS {
        ZEROPAGE: load = ZEROPAGE, type = zp;
        CODE:     load = PRG;
      }`;
    const m = {
      chunks: [{
        segments: ['ZEROPAGE'],
        data: Uint8Array.of(0, 0),
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(0xa5, 0xff),  // lda $xx
        subs: [{offset: 1, size: 1, expr: off(0, 0)}],
      }],
    };
    // The two namespaces are separate in ld65, and nrom.cfg really does reuse
    // ZEROPAGE for both.  js65 has one namespace, so the segment is the area.
    expect(chunks(linkCfg(cfg, m))).toEqual([[0, [0xa5, 0x00]]]);
  });

  it('should give each RAM area its own space', function() {
    // Banked RAM: two areas cover the same addresses on purpose, so filling
    // one must not take the other's room away. Segments sharing an area still
    // line up one after the other.
    const cfg = `
      MEMORY {
        WRAM:   start = $7000, size = $1000;
        EXWRAM: start = $6000, size = $2000;
        PRG:    start = $8000, size = $8, file = %O;
      }
      SEGMENTS {
        BSS:   load = WRAM,   type = bss;
        BSS2:  load = WRAM,   type = bss;
        EXBSS: load = EXWRAM, type = bss;
        CODE:  load = PRG;
      }`;
    const m = {
      chunks: [{
        // Runs from $6000 to $7200, over everything WRAM holds.
        segments: ['EXBSS'],
        data: new Uint8Array(0x1200),
      }, {
        segments: ['BSS'],
        data: new Uint8Array(0x10),
      }, {
        segments: ['BSS2'],
        data: new Uint8Array(0x10),
      }, {
        segments: ['CODE'],
        data: new Uint8Array(6).fill(0xff),
        subs: [
          {offset: 0, size: 2, expr: off(0, 0)},
          {offset: 2, size: 2, expr: off(1, 0)},
          {offset: 4, size: 2, expr: off(2, 0)},
        ],
      }],
    };
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [0x00, 0x60, 0x00, 0x70, 0x10, 0x70]]]);
  });

  it('should fill a merged area around the segments lowered into it', function() {
    const cfg = `
      MEMORY {
        RAM: start = $10,   size = $20;
        PRG: start = $8000, size = $8, file = %O;
      }
      SEGMENTS {
        BSS:  load = RAM, type = bss;
        RAM:  load = RAM, type = bss;
        CODE: load = PRG;
      }`;
    const m = {
      chunks: [{
        segments: ['BSS'],
        data: Uint8Array.of(0, 0, 0, 0),
      }, {
        segments: ['RAM'],
        data: Uint8Array.of(0, 0),
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(0xa5, 0xff, 0xa5, 0xff),
        subs: [
          {offset: 1, size: 1, expr: off(0, 0)},
          {offset: 3, size: 1, expr: off(1, 0)},
        ],
      }],
    };
    // RAM is both the area BSS lives in and a segment of its own, so its own
    // chunks go after the $4 bytes it handed to BSS rather than on top of them.
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [0xa5, 0x10, 0xa5, 0x14]]]);
  });

  it('should reserve a merged area\'s whole file space', function() {
    const cfg = `
      MEMORY {
        A: start = $8000, size = $8, file = %O;
        B: start = $9000, size = $4, file = %O;
      }
      SEGMENTS {
        CODE: load = A;
        A:    load = A;
        DATA: load = B;
      }`;
    const m = {
      chunks: [
        {segments: ['CODE'], data: Uint8Array.of(1, 1)},
        {segments: ['A'], data: Uint8Array.of(2, 2)},
        {segments: ['DATA'], data: Uint8Array.of(3, 3)},
      ],
    };
    // A's own chunks can land anywhere it has left, so B has to start past all
    // of A rather than just past the segments lowered into it.
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [1, 1, 2, 2]], [8, [3, 3]]]);
  });

  it('should allocate segments in the order the config declares them',
     function() {
    const cfg = `
      MEMORY { PRG: start = $8000, size = $10, file = %O; }
      SEGMENTS {
        DATA: load = PRG;
        CODE: load = PRG;
      }`;
    const m = {
      chunks: [
        {segments: ['CODE'], data: Uint8Array.of(1, 2, 3, 4)},
        {segments: ['DATA'], data: Uint8Array.of(9)},
      ],
    };
    // DATA is declared first, so it goes first even though CODE is bigger.
    expect(chunks(linkCfg(cfg, m))).toEqual([[0, [9, 1, 2, 3, 4]]]);
  });

  it('should pin a segment with an explicit start', function() {
    const cfg = `
      MEMORY { PRG: start = $8000, size = $10, file = %O, fill = yes,
                    fillval = $ff; }
      SEGMENTS {
        CODE:    load = PRG;
        VECTORS: load = PRG, start = $800e;
      }`;
    const m = {
      chunks: [
        {segments: ['CODE'], data: Uint8Array.of(1, 2)},
        {segments: ['VECTORS'], data: Uint8Array.of(0xaa, 0xbb)},
      ],
    };
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [1, 2, ...new Array(12).fill(0xff), 0xaa, 0xbb]]]);
  });

  it('should align a segment within its area', function() {
    const cfg = `
      MEMORY { PRG: start = $8000, size = $20, file = %O; }
      SEGMENTS {
        CODE: load = PRG;
        DATA: load = PRG, align = $10;
      }`;
    const m = {
      chunks: [
        {segments: ['CODE'], data: Uint8Array.of(1, 1, 1)},
        {segments: ['DATA'], data: Uint8Array.of(2, 2)},
      ],
    };
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [1, 1, 1]], [0x10, [2, 2]]]);
  });

  it('should run a segment somewhere it does not load', function() {
    const cfg = `
      MEMORY {
        RAM: start = $300,  size = $100;
        PRG: start = $8000, size = $8, file = %O;
      }
      SEGMENTS {
        BOOT: load = PRG, run = RAM;
        CODE: load = PRG;
      }`;
    const m = {
      chunks: [{
        segments: ['BOOT'],
        data: Uint8Array.of(0xaa, 0xbb, 0xff, 0xff),
        subs: [{offset: 2, size: 2, expr: off(0, 0)}],
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(1, 2),
      }],
    };
    // BOOT's label resolves against $300 where it runs, but its bytes are
    // written into - and charged to - the file space PRG handed it.
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [0xaa, 0xbb, 0x00, 0x03, 1, 2]]]);
  });

  it('should give a segment its area\'s bank', function() {
    const cfg = `
      MEMORY {
        PRG0: start = $8000, size = $4, file = %O, bank = 8;
        PRG1: start = $8000, size = $4, file = %O, bank = 9;
      }
      SEGMENTS {
        CODE: load = PRG0;
        DATA: load = PRG1;
      }`;
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [
          {offset: 0, size: 1, expr: op('^', off(0, 0))},
          {offset: 1, size: 1, expr: op('^', off(1, 0))},
        ],
      }, {
        segments: ['DATA'],
        data: Uint8Array.of(7),
      }],
    };
    expect(chunks(linkCfg(cfg, m))).toEqual([[0, [8, 9, 7]]]);
  });

  it('should resolve a config symbol in an area expression', function() {
    const cfg = `
      SYMBOLS { __PRGSTART__: type = weak, value = $8000; }
      MEMORY { PRG: start = __PRGSTART__, size = $4, file = %O; }
      SEGMENTS { CODE: load = PRG; }`;
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 2, expr: off(0, 0)}],
      }],
    };
    expect(chunks(linkCfg(cfg, m))).toEqual([[0, [0x00, 0x80]]]);
  });

  it('should throw when a segment overflows its area', function() {
    const cfg = `
      MEMORY { PRG: start = $8000, size = $2, file = %O; }
      SEGMENTS { CODE: load = PRG; }`;
    const m = {chunks: [{segments: ['CODE'], data: Uint8Array.of(1, 2, 3, 4)}]};
    expect(() => linkCfg(cfg, m))
        .toThrow(/Segment CODE .* does not fit in PRG/);
  });

  it('should give an area\'s own chunks their turn among the segments',
     function() {
    // The FDS disk header is written to the front of the same area the files
    // that follow it are lowered into, so it cannot be left the leftovers.
    const cfg = `
      MEMORY { SIDE1: start = $0000, size = $20, file = %O; }
      SEGMENTS {
        SIDE1:     load = SIDE1;
        FILE0_HDR: load = SIDE1;
        FILE0_DAT: load = SIDE1;
      }`;
    const m = {
      chunks: [
        {segments: ['FILE0_DAT'], data: Uint8Array.of(3, 3, 3, 3)},
        {segments: ['SIDE1'], data: Uint8Array.of(1, 1)},
        {segments: ['FILE0_HDR'], data: Uint8Array.of(2, 2, 2)},
      ],
    };
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [1, 1, 2, 2, 2, 3, 3, 3, 3]]]);
  });

  it('should fill an area from the SEGMENTS order, not the MEMORY order',
     function() {
    // The merged segment holds the area's place in the file, but takes its
    // turn to be filled where the SEGMENTS block puts it.
    const cfg = `
      MEMORY {
        RAM: start = $10,   size = $20;
        PRG: start = $8000, size = $8, file = %O;
      }
      SEGMENTS {
        BSS:  load = RAM;
        RAM:  load = RAM;
        CODE: load = PRG;
      }`;
    const m = {
      chunks: [{
        segments: ['BSS'],
        data: Uint8Array.of(0, 0, 0, 0),
      }, {
        segments: ['RAM'],
        data: Uint8Array.of(0, 0),
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(0xa5, 0xff, 0xa5, 0xff),
        subs: [
          {offset: 1, size: 1, expr: off(0, 0)},
          {offset: 3, size: 1, expr: off(1, 0)},
        ],
      }],
    };
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [0xa5, 0x10, 0xa5, 0x14]]]);
  });

  it('should write segments to more than one output file', function() {
    const cfg = `
      MEMORY {
        HDR: start = $0000, size = $4, file = "%O_header";
        PRG: start = $8000, size = $6, file = %O, fill = yes, fillval = $ff;
      }
      SEGMENTS {
        HEADER: load = HDR, define = yes;
        CODE:   load = PRG, define = yes;
      }`;
    const m = {
      chunks: [{
        segments: ['HEADER'],
        data: Uint8Array.of(1, 2, 3, 0xff),
        // Both files start their offsets at zero, so both segments are at 0.
        subs: [{offset: 3, size: 1, expr: imp('__CODE_FILEOFFS__')}],
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(10, 11),
      }],
    };
    const linker = linkerCfg(cfg, m);
    const main = linker.link();
    expect(chunks(main))
        .toEqual([[0, [10, 11, 0xff, 0xff, 0xff, 0xff]]]);
    const extra = linker.outputFiles();
    expect(extra.length).toBe(1);
    expect(extra[0].name).toBe('%O_header');
    expect([...extra[0].data]).toEqual([1, 2, 3, 0]);
  });

  it('should define the geometry of a segment', function() {
    const cfg = `
      MEMORY { PRG: start = $8000, size = $20, file = %O; }
      SEGMENTS {
        CODE: load = PRG, define = yes;
        DATA: load = PRG, define = yes;
      }`;
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(...new Array(10).fill(0xff)),
        subs: [
          {offset: 0, size: 2, expr: imp('__CODE_START__')},
          {offset: 2, size: 2, expr: imp('__CODE_SIZE__')},
          {offset: 4, size: 2, expr: imp('__CODE_LAST__')},
          {offset: 6, size: 2, expr: imp('__CODE_FILEOFFS__')},
          // A forward reference into a segment declared later, which is the
          // shape of the FDS `.word __FILE0_DAT_RUN__` header pattern.
          {offset: 8, size: 2, expr: imp('__DATA_RUN__')},
        ],
      }, {
        segments: ['DATA'],
        data: Uint8Array.of(1, 2),
      }],
    };
    expect(chunks(linkCfg(cfg, m))).toEqual([
      [0, [0x00, 0x80, 0x0a, 0x00, 0x0a, 0x80, 0x00, 0x00, 0x0a, 0x80, 1, 2]],
    ]);
  });

  it('should define separate load and run addresses', function() {
    const cfg = `
      MEMORY {
        RAM: start = $300,  size = $100;
        PRG: start = $8000, size = $10, file = %O;
      }
      SEGMENTS {
        BOOT: load = PRG, run = RAM, define = yes;
        CODE: load = PRG;
      }`;
    const m = {
      chunks: [{
        segments: ['BOOT'],
        data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
        subs: [
          // _LOAD__ is an address in PRG, not the file offset that _FILEOFFS__
          // gives, and _RUN__ is the address in RAM the bytes get copied to.
          {offset: 0, size: 2, expr: imp('__BOOT_LOAD__')},
          {offset: 2, size: 2, expr: imp('__BOOT_RUN__')},
          {offset: 4, size: 2, expr: imp('__BOOT_FILEOFFS__')},
        ],
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(7),
      }],
    };
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [0x00, 0x80, 0x00, 0x03, 0x00, 0x00, 7]]]);
  });

  it('should define an area\'s used extent as its _LAST__', function() {
    const cfg = `
      MEMORY { RAM: start = $200, size = $100, define = yes; }
      SEGMENTS { BSS: load = RAM, type = bss; }`;
    const m = {
      chunks: [{
        segments: ['BSS'],
        data: Uint8Array.of(0, 0, 0, 0),
      }, {
        // The chunk that reads the defines has to live somewhere that emits.
        segments: ['CODE'],
        data: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
        subs: [
          {offset: 0, size: 2, expr: imp('__RAM_START__')},
          {offset: 2, size: 2, expr: imp('__RAM_SIZE__')},
          {offset: 4, size: 2, expr: imp('__RAM_LAST__')},
        ],
      }],
      segments: [{name: 'CODE', size: 8, offset: 0, memory: 0x9000,
                  free: [[0x9000, 0x9008]]}],
    };
    expect(chunks(linkCfg(cfg, m)))
        .toEqual([[0, [0x00, 0x02, 0x00, 0x01, 0x04, 0x02]]]);
  });

  it('should export a config symbol', function() {
    const cfg = `
      SYMBOLS { __STACKSIZE__: type = export, value = $200; }
      MEMORY { PRG: start = $8000, size = $4, file = %O; }
      SEGMENTS { CODE: load = PRG; }`;
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 2, expr: imp('__STACKSIZE__')}],
      }],
    };
    expect(chunks(linkCfg(cfg, m))).toEqual([[0, [0x00, 0x02]]]);
  });

  it('should let an object file override a weak config symbol', function() {
    const cfg = `
      SYMBOLS { __STACKSIZE__: type = weak, value = $200; }
      MEMORY { PRG: start = $8000, size = $4, file = %O; }
      SEGMENTS { CODE: load = PRG; }`;
    const m = {
      chunks: [{
        segments: ['CODE'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 2, expr: imp('__STACKSIZE__')}],
      }],
      symbols: [{export: '__STACKSIZE__', expr: num(0x30)}],
    };
    expect(chunks(linkCfg(cfg, m))).toEqual([[0, [0x30, 0x00]]]);
  });

  it('should resolve a config symbol against a segment define', function() {
    const cfg = `
      MEMORY {
        RAM: start = $200, size = $100, define = yes;
        PRG: start = $8000, size = $4, file = %O;
      }
      SEGMENTS {
        BSS:  load = RAM, type = bss;
        CODE: load = PRG;
      }
      SYMBOLS { __HEAP__: type = export, value = __RAM_LAST__; }`;
    const m = {
      chunks: [{
        segments: ['BSS'],
        data: Uint8Array.of(0, 0, 0),
      }, {
        segments: ['CODE'],
        data: Uint8Array.of(0xff, 0xff),
        subs: [{offset: 0, size: 2, expr: imp('__HEAP__')}],
      }],
    };
    expect(chunks(linkCfg(cfg, m))).toEqual([[0, [0x03, 0x02]]]);
  });

  it('should require an imported config symbol to be exported', function() {
    const cfg = `
      SYMBOLS { __MAIN__: type = import; }
      MEMORY { PRG: start = $8000, size = $4, file = %O; }
      SEGMENTS { CODE: load = PRG; }`;
    const m = {chunks: [{segments: ['CODE'], data: Uint8Array.of(1)}]};
    expect(() => linkCfg(cfg, m)).toThrow(/__MAIN__ is imported .* never exported/);
  });

  it('should report a config parse error against the config file', function() {
    const cfg = `MEMORY {\n  PRG: start = $8000, size = $2\n}`;
    let err: unknown;
    try {
      linkCfg(cfg, {chunks: []});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).source).toMatchObject({file: 'test.cfg'});
  });

  describe('composite segments', function() {
    const AREAS = `MEMORY {
        PRG1: start = $8000, size = $8, file = %O, fill = yes, bank = 1;
        PRG2: start = $8000, size = $8, file = %O, fill = yes, bank = 2;
      }`;

    it('should mirror a chunk named by a cfg composite into every member',
       function() {
      const cfg = `${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}; }`;
      const m = {
        chunks: [{segments: ['COMMON'], data: Uint8Array.of(0xa9, 0x42, 0x60)}],
      };
      // One org shared by both areas, so the same three bytes land at each
      // area's own file offset and both areas fill the rest.
      expect(chunks(linkCfg(cfg, m))).toEqual([
        [0, [0xa9, 0x42, 0x60, 0, 0, 0, 0, 0,
             0xa9, 0x42, 0x60, 0, 0, 0, 0, 0]],
      ]);
    });

    it('should spread chunks named by a cfg pool composite across members',
       function() {
      const cfg = `${AREAS}
        SEGMENTS { MUSIC: pool = {PRG1, PRG2}; }`;
      const m = {
        chunks: [
          {segments: ['MUSIC'], data: Uint8Array.of(1, 2, 3, 4, 5)},
          {segments: ['MUSIC'], data: Uint8Array.of(6, 7, 8, 9)},
        ],
      };
      // The first chunk fills most of PRG1; the second no longer fits there
      // and spills into PRG2 rather than being mirrored.
      expect(chunks(linkCfg(cfg, m))).toEqual([
        [0, [1, 2, 3, 4, 5, 0, 0, 0,
             6, 7, 8, 9, 0, 0, 0, 0]],
      ]);
    });

    it('should resolve a label in a cfg mirror composite to the shared org',
       function() {
      const cfg = `${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}; }`;
      const m = {
        chunks: [{
          segments: ['COMMON'],
          data: Uint8Array.of(0x60, 0xff, 0xff),
          subs: [{offset: 1, size: 2, expr: off(0, 0)}],
        }],
      };
      expect(chunks(linkCfg(cfg, m))).toEqual([
        [0, [0x60, 0x00, 0x80, 0, 0, 0, 0, 0,
             0x60, 0x00, 0x80, 0, 0, 0, 0, 0]],
      ]);
    });

    it('should fail a cfg mirror that does not fit every member', function() {
      const cfg = `MEMORY {
          PRG1: start = $8000, size = $8, file = %O, fill = yes, bank = 1;
          PRG2: start = $8000, size = $2, file = %O, fill = yes, bank = 2;
        }
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}; }`;
      const m = {
        chunks: [{segments: ['COMMON'], data: Uint8Array.of(1, 2, 3, 4)}],
      };
      expect(() => linkCfg(cfg, m)).toThrow(/PRG1 & PRG2|mirrored across/);
    });
  });
});

describe('anonymous segments', function() {
  function anon(hash: string, memory: number, size: number,
                extra: Partial<Segment> = {}): Segment {
    return {name: `@anon@bank.s:${LINES[hash] ?? 1}:${hash}`, memory, size, ...extra};
  }
  const LINES: Record<string, number> = {aaa: 1, bbb: 2, ccc: 3};
  const nameOf = (hash: string) => anon(hash, 0, 0).name;

  it('should hand out sequential file offsets within one module', function() {
    const m = {
      chunks: [
        {segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)},
        {segments: [nameOf('bbb')], org: 0x8000, data: Uint8Array.of(3, 4)},
      ],
      segments: [anon('aaa', 0x8000, 0x10), anon('bbb', 0x8000, 0x10)],
    };
    // Both segments keep memory $8000, but land at file offsets 0 and $10.
    expect(chunks(link(m))).toEqual([[0, [1, 2]], [0x10, [3, 4]]]);
  });

  it('should hand out offsets across modules in read order', function() {
    const a = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    const b = {
      chunks: [{segments: [nameOf('bbb')], org: 0x9000, data: Uint8Array.of(3, 4)}],
      segments: [anon('bbb', 0x9000, 0x10)],
    };
    expect(chunks(link(a, b))).toEqual([[0, [1, 2]], [0x10, [3, 4]]]);
  });

  it('should reverse the offsets when the module order reverses', function() {
    const a = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    const b = {
      chunks: [{segments: [nameOf('bbb')], org: 0x9000, data: Uint8Array.of(3, 4)}],
      segments: [anon('bbb', 0x9000, 0x10)],
    };
    // Link order is the single source of truth for layout.
    expect(chunks(link(b, a))).toEqual([[0, [3, 4]], [0x10, [1, 2]]]);
  });

  it('should keep declaration order when it disagrees with every other key', function() {
    // Validate that the declaration order for the segments matches the link order
    // if these got outta sync with a future change, it could cause headaches.
    const m = {
      chunks: [
        {segments: [nameOf('ccc')], org: 0xa000, data: Uint8Array.of(5, 6)},
        {segments: [nameOf('bbb')], org: 0x9000, data: Uint8Array.of(3, 4)},
        {segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)},
      ],
      segments: [anon('ccc', 0xa000, 0x10), anon('bbb', 0x9000, 0x10),
                 anon('aaa', 0x8000, 0x10)],
    };
    // Declared ccc, bbb, aaa -> that is the file order, addresses notwithstanding.
    expect(chunks(link(m)))
        .toEqual([[0, [5, 6]], [0x10, [3, 4]], [0x20, [1, 2]]]);
  });

  it('should reserve file space for an empty segment', function() {
    const m = {
      chunks: [
        {segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)},
        {segments: [nameOf('ccc')], org: 0xa000, data: Uint8Array.of(5, 6)},
      ],
      // The middle segment holds no chunks, but still owns its $10 of file.
      segments: [anon('aaa', 0x8000, 0x10), anon('bbb', 0x9000, 0x10),
                 anon('ccc', 0xa000, 0x10)],
    };
    expect(chunks(link(m))).toEqual([[0, [1, 2]], [0x20, [5, 6]]]);
  });

  it('should fill the whole range of a :fill segment', function() {
    const m = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8002, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x8,
                      {fill: 0xff, free: [[0x8000, 0x8008]]})],
    };
    expect(chunks(link(m)))
        .toEqual([[0, [0xff, 0xff, 1, 2, 0xff, 0xff, 0xff, 0xff]]]);
  });

  it('should reject mixing with a named segment', function() {
    const a = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    const b = {
      chunks: [{segments: ['code'], org: 0x9000, data: Uint8Array.of(3, 4)}],
      segments: [{name: 'code', memory: 0x9000, size: 0x10, offset: 0x10}],
    };
    expect(() => link(a, b))
        .toThrow(/Anonymous segments cannot be combined with named segments/);
  });

  it('should reject mixing with an ld65 config', function() {
    const m = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    const cfg = `
      MEMORY { PRG: start = $8000, size = $10, file = %O; }
      SEGMENTS { CODE: load = PRG; }`;
    const linker = new Linker({linkerConfig: cfg, linkerConfigName: 'test.cfg'});
    expect(() => linker.read(m).link())
        .toThrow(/A linker config cannot be combined with anonymous segments/);
  });

  it('should reject mixing with a --target', function() {
    const m = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    const linker = new Linker({target: 'nes-nrom'});
    expect(() => linker.read(m).link())
        .toThrow(/--target nes-nrom cannot be combined with anonymous segments/);
  });

  it('should reject a duplicate anonymous segment name', function() {
    // Two modules that somehow minted the same hash would otherwise be merged
    // last-wins, silently fusing two banks into one.
    const a = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    const b = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(3, 4)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    expect(() => link(a, b))
        .toThrow(/Duplicate anonymous segment @anon@bank\.s:1:aaa/);
  });

  it('should reject a chunk that named no segment', function() {
    const m = {
      chunks: [{segments: [], data: Uint8Array.of(1, 2)},
               {segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(3, 4)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    expect(() => link(m)).toThrow(/emitted before the first \.segment/);
  });

  it('should reject an .org outside its segment', function() {
    const m = {
      chunks: [{segments: [nameOf('aaa')], org: 0x9000, data: Uint8Array.of(1, 2)}],
      segments: [anon('aaa', 0x8000, 0x10)],
    };
    expect(() => link(m)).toThrow(
        /\.org \$9000 is outside the anonymous segment @bank\.s:1 \$8000/);
  });

  it('should reject a chunk that runs off the end of its segment', function() {
    // Every chunk in an anonymous segment carries the segment's address as an
    // implicit .org, so the free space allocator never sees these.
    const m = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000,
                data: Uint8Array.of(1, 2, 3, 4)}],
      segments: [anon('aaa', 0x8000, 2)],
    };
    expect(() => link(m)).toThrow(
        /Chunk \(\$4 bytes at \$8000\) does not fit in anonymous segment @bank\.s:1 \$8000 \(size \$2\)/);
  });

  it('should accept a chunk that exactly fills its segment', function() {
    const m = {
      chunks: [{segments: [nameOf('aaa')], org: 0x8000,
                data: Uint8Array.of(1, 2, 3, 4)}],
      segments: [anon('aaa', 0x8000, 4)],
    };
    expect(chunks(link(m))).toEqual([[0, [1, 2, 3, 4]]]);
  });

  it('should label anonymous segments by declaration site in the map',
     function() {
    const m = {
      chunks: [
        {segments: [nameOf('aaa')], org: 0x8000, data: Uint8Array.of(1, 2)},
        {segments: [nameOf('bbb')], org: 0x8000, data: Uint8Array.of(3, 4)},
      ],
      // Two banks at the same address: only the line tells them apart.
      segments: [anon('aaa', 0x8000, 0x10), anon('bbb', 0x8000, 0x10)],
    };
    const linker = new Linker();
    linker.read(m).link();
    const report = linker.report();
    expect(report).toContain('@bank.s:1 $8000');
    expect(report).toContain('@bank.s:2 $8000');
    // The hash never reaches the report.
    expect(report).not.toContain('@anon@');
  });

  it('should fall back to the raw name when it has no source', function() {
    // A hand-built module (or an older object file) whose name isn't in the
    // generated shape still links, and prints as-is rather than crashing.
    const m = {
      chunks: [{segments: ['@anon@bare'], org: 0x8000, data: Uint8Array.of(1, 2)}],
      segments: [{name: '@anon@bare', memory: 0x8000, size: 0x10}],
    };
    const linker = new Linker();
    expect(chunks(linker.read(m).link())).toEqual([[0, [1, 2]]]);
    expect(linker.report()).toContain('@anon@bare');
  });
});

describe('FreeSpace', function() {
  // The size index has to agree with what a plain left-to-right scan of every
  // free range would have chosen, including which range wins a tie, or chunks
  // land at different addresses and the linked output shifts.
  function scanBestFit(free: FreeSpace, s0: number, s1: number, size: number,
                       align: number, delta: number): number|undefined {
    let found: number|undefined;
    let smallest = Infinity;
    for (const [f0, f1] of free.tail(s0)) {
      if (f0 >= s1) break;
      const end = Math.min(f1, s1);
      const start =
          align > 1 ? Math.ceil((f0 - delta) / align) * align + delta : f0;
      if (start + size > end) continue;
      const df = end - f0;
      if (df < smallest) {
        found = start;
        smallest = df;
      }
    }
    return found;
  }

  it('should match a full scan under random pools and queries', function() {
    let seed = 987654321;
    const rnd = (n: number) => {  // xorshift; fixed seed keeps this repeatable
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed % n;
    };
    const SPAN = 400;
    for (let trial = 0; trial < 300; trial++) {
      const free = new FreeSpace();
      // Carve a pool up with a random mix of adds and deletes.
      for (let i = 0; i < 25; i++) {
        const a = rnd(SPAN);
        const b = a + 1 + rnd(40);
        if (rnd(3)) free.add(a, b); else free.delete(a, b);
      }
      for (let q = 0; q < 25; q++) {
        const s0 = rnd(SPAN);
        const s1 = s0 + rnd(SPAN - s0 + 1);
        const size = 1 + rnd(12);
        const align = [1, 1, 1, 2, 4, 8][rnd(6)];
        const delta = rnd(3) - 1;
        const at = `trial ${trial} query ${q}: [${s0},${s1}) size=${size} ${
            ''}align=${align} delta=${delta} pool=${JSON.stringify([...free])}`;
        // -1 rather than undefined, so a miss on one side reads clearly.
        expect(free.bestFit(s0, s1, size, align, delta) ?? -1, at)
            .toBe(scanBestFit(free, s0, s1, size, align, delta) ?? -1);
      }
    }
  });

  it('should prefer the smallest range that fits', function() {
    const free = new FreeSpace();
    free.add(0, 20);    // big
    free.add(30, 34);   // exact fit
    free.add(40, 50);   // medium
    expect(free.bestFit(0, 100, 4, 1, 0)).toBe(30);
    expect(free.bestFit(0, 100, 5, 1, 0)).toBe(40);
    expect(free.bestFit(0, 100, 11, 1, 0)).toBe(0);
    expect(free.bestFit(0, 100, 21, 1, 0)).toBeUndefined();
  });

  it('should break ties toward the lowest address', function() {
    const free = new FreeSpace();
    free.add(50, 54);
    free.add(10, 14);
    free.add(30, 34);
    expect(free.bestFit(0, 100, 4, 1, 0)).toBe(10);
  });

  it('should only count the part of a range inside the window', function() {
    const free = new FreeSpace();
    free.add(0, 100);   // straddles both ends of the window below
    free.add(120, 132);
    // Clipped to [90, 110) the first range is only 10 bytes, beating the 12
    // byte range that sits wholly outside the window.
    expect(free.bestFit(90, 110, 8, 1, 0)).toBe(90);
    // ...but a range hanging off the high end is measured from where it starts.
    const other = new FreeSpace();
    other.add(0, 4);
    other.add(10, 100);
    expect(other.bestFit(0, 20, 4, 1, 0)).toBe(0);
    expect(other.bestFit(0, 20, 5, 1, 0)).toBe(10);
  });

  it('should place at the low edge of a range running off the low end',
     function() {
    // Free ranges merge across segment boundaries, so a range hanging off the
    // low end of the window is normally the previous segment's leftovers fused
    // onto this one's. Packing against the high edge would keep that merged
    // range in one piece, but the piece below `s0` is not this segment's to
    // allocate from - so the split is free, and packing high would only fill
    // the segment back to front.
    const free = new FreeSpace();
    free.add(0x8000, 0x80c0);   // the previous segment's leftovers...
    free.add(0x80c0, 0x8100);   // ...fused onto this segment's free space
    expect([...free]).toEqual([[0x8000, 0x8100]]);
    const at = free.bestFit(0x80c0, 0x8100, 0x20, 1, 0);
    expect(at).toBe(0x80c0);
    free.delete(at!, at! + 0x20);
    // Both segments still have every byte they started with available.
    expect([...free]).toEqual([[0x8000, 0x80c0], [0x80e0, 0x8100]]);
  });

  it('should respect alignment when choosing a range', function() {
    const free = new FreeSpace();
    free.add(9, 15);    // 6 bytes, but 4-aligned only leaves [12, 15)
    free.add(40, 48);   // 8 bytes, 4-aligned from the start
    expect(free.bestFit(0, 100, 4, 4, 0)).toBe(40);
    expect(free.bestFit(0, 100, 3, 4, 0)).toBe(12);
  });
});
