
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {BitSet, IntervalSet, SparseByteArray,
        binaryInsert, binarySearch, toHexString, fromHexString, fromByteString} from '../src/util.ts';
import * as util from '../src/util.ts';

const [_] = [util];

/** Convert the chunks to plain number arrays for testing. */
function chunks(a: SparseByteArray): Array<[number, number[]]> {
  return [...a.chunks()].map(([start, data]) => [start, [...data]]);
}

describe('binarySearch', function() {
  const arr = [3, 6, 8, 10, 12, 16, 18, 22, 27, 35];
  function find(target: number) {
    return binarySearch(arr.length, (i: number) => target - arr[i]);
  }
  
  it('should return index of a present element', function() {
    for (let i = 0; i < arr.length; i++) {
      expect(find(arr[i])).toBe(i);
    }
  });
  it('should return ~0 for before first element', function() {
    expect(find(-Infinity)).toBe(~0)
  });
  it('should return ~n for after last element', function() {
    expect(find(Infinity)).toBe(~arr.length)
  });
  it('should return ~i for just before element i', function() {
    for (let i = 1; i < arr.length; i++) {
      expect(find((arr[i - 1] + arr[i]) / 2)).toBe(~i);
    }
  });
});

describe('binaryInsert', function() {
  it('should insert at the beginning', function() {
    const arr = ['x', 'xx', 'xxx'];
    binaryInsert(arr, x => x.length, '');
    expect(arr).toEqual(['', 'x', 'xx', 'xxx']);
  });

  it('should insert at the end', function() {
    const arr = ['x', 'xx', 'xxx'];
    binaryInsert(arr, x => x.length, 'xxxx');
    expect(arr).toEqual(['x', 'xx', 'xxx', 'xxxx']);
  });

  it('should insert in the middle', function() {
    const arr = ['x', 'xxx'];
    binaryInsert(arr, x => x.length, 'xx');
    expect(arr).toEqual(['x', 'xx', 'xxx']);
  });

  it('should insert an element with the same result', function() {
    const arr = ['x', 'xx', 'xxx'];
    binaryInsert(arr, x => x.length, 'yy');
    expect(arr).toEqual(['x', 'xx', 'yy', 'xxx']);
  });
});

describe('BitSet', function() {
  it('should support adding a new element', function() {
    const s = new BitSet();
    expect(s.has(1234)).toBe(false);
    s.add(1234);
    expect(s.has(1233)).toBe(false);
    expect(s.has(1234)).toBe(true);
    expect(s.has(1235)).toBe(false);
  });

  it('should support deleting an element', function() {
    const s = new BitSet();
    s.add(1233);
    s.add(1234);
    s.add(1235);
    expect(s.has(1233)).toBe(true);
    expect(s.has(1234)).toBe(true);
    expect(s.has(1235)).toBe(true);
    s.delete(1234);
    expect(s.has(1233)).toBe(true);
    expect(s.has(1234)).toBe(false);
    expect(s.has(1235)).toBe(true);
  });
});

describe('IntervalSet', function() {
  it('should start empty', function() {
    expect([...new IntervalSet()]).toEqual([]);
  });

  describe('IntervalSet#add', function() {
    it('should add an interval', function() {
      const s = new IntervalSet();
      s.add(5, 10);
      expect([...s]).toEqual([[5, 10]]);
    });

    it('should add a second interval', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(5, 7);
      expect([...s]).toEqual([[2, 4], [5, 7]]);
    });

    it('should add an interval that abuts on the left', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(5, 7);
      s.add(7, 9);
      expect([...s]).toEqual([[2, 4], [5, 9]]);
    });

    it('should add an interval that abuts on the right', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(5, 7);
      s.add(0, 2);
      expect([...s]).toEqual([[0, 4], [5, 7]]);
    });

    it('should add an interval that abuts on both sides', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(5, 7);
      s.add(4, 5);
      expect([...s]).toEqual([[2, 7]]);
    });

    it('should add an interval that encloses one other', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(6, 8);
      s.add(5, 9);
      expect([...s]).toEqual([[2, 4], [5, 9]]);
    });

    it('should add an interval that overlaps on the left', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(6, 8);
      s.add(3, 5);
      expect([...s]).toEqual([[2, 5], [6, 8]]);
    });

    it('should add an interval that overlaps multiple on the left', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(6, 8);
      s.add(3, 9);
      expect([...s]).toEqual([[2, 9]]);
    });

    it('should add an interval that overlaps on the right', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(6, 8);
      s.add(5, 7);
      expect([...s]).toEqual([[2, 4], [5, 8]]);
    });

    it('should add an interval that overlaps multiple on the right', function() {
      const s = new IntervalSet();
      s.add(2, 4);
      s.add(6, 8);
      s.add(1, 7);
      expect([...s]).toEqual([[1, 8]]);
    });
  });

  describe('IntervalSet#has', function() {
    it('should be false on the far left', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      expect(s.has(0)).toBe(false);
    });

    it('should be true at the start of an interval', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      expect(s.has(1)).toBe(true);
    });

    it('should be true in the middle of an interval', function() {
      const s = new IntervalSet();
      s.add(1, 3);
      s.add(4, 5);
      expect(s.has(2)).toBe(true);
    });

    it('should be false at the end of an interval', function() {
      const s = new IntervalSet();
      s.add(1, 3);
      s.add(4, 5);
      expect(s.has(3)).toBe(false);
    });

    it('should be false between intervals', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(4, 5);
      expect(s.has(3)).toBe(false);
    });

    it('should be false on the far right', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(4, 5);
      expect(s.has(6)).toBe(false);
    });
  });

  describe('IntervalSet#delete', function() {
    it('should delete an absent interval', function() {
      const s = new IntervalSet();
      s.add(3, 4);
      s.delete(1, 2);
      expect([...s]).toEqual([[3, 4]]);
    });

    it('should delete an interval from the middle of another', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 7);
      s.add(8, 9);
      s.delete(4, 5);
      expect([...s]).toEqual([[1, 2], [3, 4], [5, 7], [8, 9]]);
    });

    it('should delete an interval that abuts on the inside left', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 7);
      s.add(8, 9);
      s.delete(3, 5);
      expect([...s]).toEqual([[1, 2], [5, 7], [8, 9]]);
    });

    it('should delete an interval that abuts on the inside right', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 7);
      s.add(8, 9);
      s.delete(5, 7);
      expect([...s]).toEqual([[1, 2], [3, 5], [8, 9]]);
    });

    it('should delete an interval that abuts on the outside left', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 7);
      s.add(8, 9);
      s.delete(2, 5);
      expect([...s]).toEqual([[1, 2], [5, 7], [8, 9]]);
    });

    it('should delete an interval that abuts on the outside right', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 7);
      s.add(8, 9);
      s.delete(5, 8);
      expect([...s]).toEqual([[1, 2], [3, 5], [8, 9]]);
    });

    it('should delete an interval that outerlaps on the left', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(4, 6);
      s.add(8, 9);
      s.delete(3, 5);
      expect([...s]).toEqual([[1, 2], [5, 6], [8, 9]]);
    });

    it('should delete an interval that outerlaps on the right', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(4, 6);
      s.add(8, 9);
      s.delete(5, 7);
      expect([...s]).toEqual([[1, 2], [4, 5], [8, 9]]);
    });

    it('should delete an interval that overlaps multiple', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      s.add(5, 6);
      s.add(8, 9);
      s.delete(3, 6);
      expect([...s]).toEqual([[1, 2], [8, 9]]);
    });

    it('should delete an interval that outerlaps multiple', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      s.add(5, 6);
      s.add(8, 9);
      s.delete(2, 8);
      expect([...s]).toEqual([[1, 2], [8, 9]]);
    });
  });

  describe('IntervalSet#tail', function() {
    it('should be empty when past the end', function() {
      const s = new IntervalSet();
      s.add(1, 4);
      expect([...s.tail(5)]).toEqual([]);
    });

    it('should handle targets between intervals', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      s.add(6, 7);
      s.add(8, 9);
      expect([...s.tail(5)]).toEqual([[6, 7], [8, 9]]);
    });

    it('should handle targets at the start of an interval', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      s.add(6, 7);
      s.add(8, 9);
      expect([...s.tail(6)]).toEqual([[6, 7], [8, 9]]);
    });

    it('should handle targets at the end of an interval', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      s.add(6, 7);
      s.add(8, 9);
      expect([...s.tail(4)]).toEqual([[6, 7], [8, 9]]);
    });

    it('should handle targets at the middle of an interval', function() {
      const s = new IntervalSet();
      s.add(1, 2);
      s.add(3, 4);
      s.add(6, 8);
      s.add(9, 10);
      expect([...s.tail(7)]).toEqual([[7, 8], [9, 10]]);
    });
  });
});

describe('SparseByteArray', function() {
  it('should start empty', function() {
    expect(chunks(new SparseByteArray())).toEqual([]);
  });

  describe('SparseByteArray#set', function() {
    it('should set some values', function() {
      const a = new SparseByteArray();
      a.set(5, 1, 3, 4);
      expect(chunks(a)).toEqual([[5, [1, 3, 4]]]);
    });

    it('should add a second chunk', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(5, 3, 4);
      expect(chunks(a)).toEqual([[2, [1, 2]], [5, [3, 4]]]);
    });

    it('should add a chunk that abuts on the left', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(5, 3, 4);
      a.set(7, 5, 6);
      expect(chunks(a)).toEqual([[2, [1, 2]], [5, [3, 4, 5, 6]]]);
    });

    it('should add a chunk that abuts on the right', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(5, 3, 4);
      a.set(0, 5, 6);
      expect(chunks(a)).toEqual([[0, [5, 6, 1, 2]], [5, [3, 4]]]);
    });

    it('should add a chunk that abuts on both sides', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(5, 3, 4);
      a.set(4, 5);
      expect(chunks(a)).toEqual([[2, [1, 2, 5, 3, 4]]]);
    });

    it('should add a chunk that encloses another', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(6, 3, 4);
      a.set(5, 5, 6, 7, 8);
      expect(chunks(a)).toEqual([[2, [1, 2]], [5, [5, 6, 7, 8]]]);
    });

    it('should add a chunk within another', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2, 3, 4, 5, 6);
      a.set(4, 7, 8);
      expect(chunks(a)).toEqual([[2, [1, 2, 7, 8, 5, 6]]]);
    });

    it('should add a chunk that overlaps on the left', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(6, 3, 4);
      a.set(3, 5, 6);
      expect(chunks(a)).toEqual([[2, [1, 5, 6]], [6, [3, 4]]]);
    });

    it('should add a chunk that overlaps multiple on the left', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(6, 3, 4);
      a.set(3, 4, 5, 6, 7, 8, 9);
      expect(chunks(a)).toEqual([[2, [1, 4, 5, 6, 7, 8, 9]]]);
    });

    it('should add a chunk that overlaps on the right', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(6, 3, 4);
      a.set(5, 5, 6);
      expect(chunks(a)).toEqual([[2, [1, 2]], [5, [5, 6, 4]]]);
    });

    it('should add a chunk that overlaps multiple on the right', function() {
      const a = new SparseByteArray();
      a.set(2, 1, 2);
      a.set(6, 3, 4);
      a.set(1, 5, 6, 7, 8, 9, 10);
      expect(chunks(a)).toEqual([[1, [5, 6, 7, 8, 9, 10, 4]]]);
    });
  });

  describe('SparseByteArray#get', function() {
    it('should be undefined on the far left', function() {
      const a = new SparseByteArray();
      a.set(1, 5);
      a.set(3, 7);
      expect(a.get(0)).toBeUndefined();
    });

    it('should fetch from the start of a chunk', function() {
      const a = new SparseByteArray();
      a.set(1, 5);
      a.set(3, 7);
      expect(a.get(1)).toBe(5);
    });

    it('should fetch from the middle of a chunk', function() {
      const a = new SparseByteArray();
      a.set(1, 5, 6);
      a.set(4, 7);
      expect(a.get(2)).toBe(6);
    });

    it('should be undefined at the end of a chunk', function() {
      const a = new SparseByteArray();
      a.set(1, 5, 6);
      a.set(4, 7);
      expect(a.get(3)).toBeUndefined();
    });

    it('should be undefined between chunks', function() {
      const a = new SparseByteArray();
      a.set(1, 5);
      a.set(4, 7);
      expect(a.get(3)).toBeUndefined();
    });

    it('should be undefined on the far right', function() {
      const a = new SparseByteArray();
      a.set(1, 5);
      a.set(4, 7);
      expect(a.get(6)).toBeUndefined();
    });
  });

  describe('SparseByteArray#splice', function() {
    it('should splice an absent chunk', function() {
      const a = new SparseByteArray();
      a.set(3, 5);
      a.splice(1);
      expect(chunks(a)).toEqual([[3, [5]]]);
    });

    it('should splice from the middle of a chunk', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(3, 2, 3, 4, 5);
      a.set(8, 6);
      a.splice(4);
      expect(chunks(a))
          .toEqual([[1, [1]], [3, [2]], [5, [4, 5]], [8, [6]]]);
    });

    it('should splice a chunk that abuts on the inside left', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(3, 2, 3, 4, 5);
      a.set(8, 6);
      a.splice(3, 2);
      expect(chunks(a)).toEqual([[1, [1]], [5, [4, 5]], [8, [6]]]);
    });

    it('should splice a chunk that abuts on the inside right', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(3, 2, 3, 4, 5);
      a.set(8, 6);
      a.splice(5, 2);
      expect(chunks(a)).toEqual([[1, [1]], [3, [2, 3]], [8, [6]]]);
    });

    it('should splice a chunk that abuts on the outside left', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(3, 2, 3, 4, 5);
      a.set(8, 6);
      a.splice(2, 3);
      expect(chunks(a)).toEqual([[1, [1]], [5, [4, 5]], [8, [6]]]);
    });

    it('should splice a chunk that abuts on the outside right', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(3, 2, 3, 4, 5);
      a.set(8, 6);
      a.splice(5, 3);
      expect(chunks(a)).toEqual([[1, [1]], [3, [2, 3]], [8, [6]]]);
    });

    it('should splice a chunk that outerlaps on the left', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(4, 2, 3);
      a.set(8, 4);
      a.splice(3, 2);
      expect(chunks(a)).toEqual([[1, [1]], [5, [3]], [8, [4]]]);
    });

    it('should splice a chunk that outerlaps on the right', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(4, 2, 3);
      a.set(8, 4);
      a.splice(5, 2);
      expect(chunks(a)).toEqual([[1, [1]], [4, [2]], [8, [4]]]);
    });

    it('should splice a chunk that overlaps multiple', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(3, 2);
      a.set(5, 3);
      a.set(8, 4);
      a.splice(3, 3);
      expect(chunks(a)).toEqual([[1, [1]], [8, [4]]]);
    });

    it('should splice a chunk that outerlaps multiple', function() {
      const a = new SparseByteArray();
      a.set(1, 1);
      a.set(3, 2);
      a.set(5, 3);
      a.set(8, 4);
      a.splice(2, 6);
      expect(chunks(a)).toEqual([[1, [1]], [8, [4]]]);
    });
  });

  describe('SparseByteArray.slice', function() {
    it('should return a slice', function() {
      const a = new SparseByteArray();
      a.set(5, 1, 2, 3, 4, 5);
      expect([...a.slice(6, 8)]).toEqual([2, 3]);
    });

    it('should return an entire chunk', function() {
      const a = new SparseByteArray();
      a.set(5, 1, 2);
      expect([...a.slice(5, 7)]).toEqual([1, 2]);
    });

    it('should throw if across a gap', function() {
      const a = new SparseByteArray();
      a.set(5, 1, 2);
      a.set(8, 3, 4);
      expect(() => a.slice(6, 9)).toThrow(/^Absent: 7/);
    });

    it('should throw if left edge is missing', function() {
      const a = new SparseByteArray();
      a.set(5, 1, 2);
      expect(() => a.slice(4, 6)).toThrow(/^Absent: 4/);
    });

    it('should throw if right edge is missing', function() {
      const a = new SparseByteArray();
      a.set(5, 1, 2);
      expect(() => a.slice(5, 8)).toThrow(/^Absent: 7/);
    });
  });

  describe('SparseByteArray search', function() {
    const a = new SparseByteArray();
    a.set(0, 1, 2, 3, 4, 2, 3, 5, 6);
    a.set(10, 1, 2, 3, 5, 2, 3, 6, 8);

    it('should find the first occurrence of a pattern', function() {
      expect(a.search([2, 3, 5])).toBe(4);
    });

    it('should respect the bounds', function() {
      expect(a.search([2, 3, 5], 8)).toBe(11);
    });

    it('should return -1 if the pattern is not found', function() {
      expect(a.search([2, 3, 7])).toBe(-1);
    });

    it('should return -1 if the bounds are right of the data', function() {
      expect(a.search([2, 3, 4], 20)).toBe(-1);
    });

    it('should return -1 if the bounds are left of the match', function() {
      expect(a.search([2, 3, 4], 0, 3)).toBe(-1);
    });
  });

  // Basic test to check that as a chunk grows into its owned buffer,
  // that it doesn't start to overlap with a different buffer. This test just
  // adds things at a "fixed" random seed so its consistent but "random"ish
  // and verifies that the growths never cause a patch to slip into a different chunk.
  it('should not generate a scenario where expanding grows into another chunk', function() {
    let seed = 12345;
    const rnd = (n: number) => {  // xorshift; fixed seed keeps this repeatable
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed % n;
    };
    const SPAN = 60;
    for (let trial = 0; trial < 200; trial++) {
      const a = new SparseByteArray();
      const model = new Map<number, number>();
      let high = 0;
      for (let step = 0; step < 40; step++) {
        const op = rnd(3);
        const start = rnd(SPAN);
        const len = 1 + rnd(8);
        const at = `trial ${trial} step ${step}`;
        if (op < 2) {
          const vals = new Uint8Array(len);
          for (let i = 0; i < len; i++) vals[i] = 1 + rnd(255);
          // exercise both the array-like and the variadic overload
          if (op === 0) a.set(start, vals); else a.set(start, ...vals);
          for (let i = 0; i < len; i++) model.set(start + i, vals[i]);
          high = Math.max(high, start + len);
        } else {
          a.splice(start, len);
          for (let i = 0; i < len; i++) model.delete(start + i);
        }

        const bytes: Array<number|undefined> = [];
        const want: Array<number|undefined> = [];
        for (let i = 0; i < SPAN + 16; i++) {
          bytes.push(a.get(i));
          want.push(model.get(i));
        }
        expect(bytes, at).toEqual(want);
        expect(a.length, at).toBe(high);

        // Chunks stay sorted, non-empty, disjoint, and cover exactly the model.
        const covered = new Map<number, number>();
        const buffers = new Set<ArrayBufferLike>();
        let prevEnd = -1;
        for (const [s, d] of a.chunks()) {
          expect(d.length, at).toBeGreaterThan(0);
          expect(s, at).toBeGreaterThanOrEqual(prevEnd);
          expect(d.byteOffset, at).toBe(0);
          prevEnd = s + d.length;
          buffers.add(d.buffer);
          for (let i = 0; i < d.length; i++) covered.set(s + i, d[i]);
        }
        expect(buffers.size, `${at}: chunks must not share a buffer`)
            .toBe(a.chunks().length);
        expect([...covered].sort((x, y) => x[0] - y[0]), at)
            .toEqual([...model].sort((x, y) => x[0] - y[0]));
      }
    }
  });
});

describe('fromHexString', function() {
  const res = [0, 0x40, 0x80, 0xc0, 0xff];
  it('should work without spaces', function() {
    expect([...fromHexString('004080c0FF')]).toEqual(res);
  });
  it('should work with spaces', function() {
    expect([...fromHexString(' 0 0408 0c0 FF ')]).toEqual(res);
  });
});

describe('toHexString', function() {
  const spaceHexStr = '00 40 80 c0 ff';
  const a = fromHexString(spaceHexStr);
  it('should work without spacing', function() {
    expect(toHexString(a)).toBe(spaceHexStr.replaceAll(' ', ''));
  });

  it('should work with spacing', function() {
    expect(toHexString(a, true)).toBe(spaceHexStr);
  });
});

describe('fromByteString' , function() {
  it('should work', function() {
    expect(fromByteString('ABC123\0\'\"\\\n\r\t\xa9\xff'))
      .toEqual(fromHexString('41 42 43 31 32 33 00 27 22 5C 0A 0D 09 A9 FF'))
  });
});

describe('dirOf', function() {
  it('returns the directory portion', function() {
    expect(util.dirOf('a/b/c.s')).toBe('a/b');
    expect(util.dirOf('bhop/bhop.s')).toBe('bhop');
  });

  it('returns empty for a bare filename', function() {
    expect(util.dirOf('x.s')).toBe('');
    expect(util.dirOf('')).toBe('');
  });

  it('accepts backslash separators and normalizes them', function() {
    expect(util.dirOf('a\\b\\c.s')).toBe('a/b');
    expect(util.dirOf('a/b\\c.s')).toBe('a/b');
  });

  it('keeps an absolute root', function() {
    expect(util.dirOf('/opt/inc/x.s')).toBe('/opt/inc');
  });
});

describe('joinDir', function() {
  it('joins a base and a relative path', function() {
    expect(util.joinDir('bhop', 'bhop')).toBe('bhop/bhop');
  });

  it('passes either side through when the other is empty', function() {
    expect(util.joinDir('', 'sub')).toBe('sub');
    expect(util.joinDir('base', '')).toBe('base');
    expect(util.joinDir('', '')).toBe('');
  });

  it('collapses . and ..', function() {
    expect(util.joinDir('a/b', '../c')).toBe('a/c');
    expect(util.joinDir('a/b', './c')).toBe('a/b/c');
    // Can't climb above the start of a relative path, so the extra .. is kept.
    expect(util.joinDir('a', '../../b')).toBe('../b');
    expect(util.joinDir('', './')).toBe('');
  });

  it('normalizes backslash separators', function() {
    expect(util.joinDir('a\\b', 'c\\d')).toBe('a/b/c/d');
    expect(util.joinDir('vendor\\inc', '..\\other')).toBe('vendor/other');
  });

  it('keeps an absolute base absolute', function() {
    expect(util.joinDir('/opt/inc', 'sub')).toBe('/opt/inc/sub');
    expect(util.joinDir('/opt/inc/detail', '..')).toBe('/opt/inc');
  });
});
