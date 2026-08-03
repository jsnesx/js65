
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {type Expr} from '../src/expr.ts';
import {Linker} from '../src/linker.ts';
import {type Module} from '../src/module.ts';
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
    // A segment with no free ranges of its own is free in its entirety, so
    // running out of space means declaring a segment too small to hold them.
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
      }],
    };
    expect(() => link(m)).toThrow(/Could not find space/);
  });

  it('should fill a segment with no free ranges of its own', function() {
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
    expect(chunks(link(m))).toEqual([[0x10, [2, 4, 0x00, 0xc0]]]);
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O'},
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory, out: '%O'},
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O'},
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O'},
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O'},
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O'},
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O'},
        {name: 'CODE', load: 'PRG'},
      ],
    };
    expect(() => link(m)).toThrow(/no address of its own/);
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
        {name: 'PRG', size: 0x100, offset: 0x10, memory: 0x8000, out: '%O'},
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
        {name: 'HDR', size: 0x10, offset: 0, memory: 0, out: '%O'},
        {name: 'PRG', size: 0x100, memory: 0x8000, out: '%O'},
        {name: 'FTR', size: 0x20, memory: 0, out: '%O'},
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
      segments: [{name: 'CODE', size: 8, offset: 0, memory: 0x9000}],
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
});
