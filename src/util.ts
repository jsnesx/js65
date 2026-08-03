
// SPDX-License-Identifier: MPL-2.0

// Returns element where fn returns 0, or ~insertion point
// First parameter is the size to search: [0..n-1] inclusive.
// Function returns + if we need to increase, - if we need to decrease.
// To find an element in a list:
//     binarySearch(list.length, (i) => wanted - list[i]);
export function binarySearch(n: number, f: (i: number) => number): number {
  if (!n) return ~0;
  const fa = f(0);
  const fb = f(n - 1);
  if (fa < 0) return ~0;
  if (fa === 0) return 0;
  if (fb > 0) return ~n;
  if (fb === 0) return n - 1;
  let a = 0;
  let b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    const fm = f(m);
    if (fm > 0) {
      a = m;
    } else if (fm < 0) {
      b = m;
    } else {
      return m;
    }
  }
  return ~b;
}

export function binaryInsert<T>(arr: T[], f: (t: T) => number, t: T) {
  const x = f(t);
  const index = binarySearch(arr.length, i => x < f(arr[i]) ? -1 : 1);
  arr.splice(~index, 0, t);
}

type Chunk = [start: number, data: Uint8Array];

export class SparseByteArray {
  private _chunks: Chunk[] = [];
  private _length = 0;

  // NOTE: length is a high water mark.
  get length() { return this._length; }
  // TODO - set length - may need to splice
  //  - alternative: shrink() method

  private _find(target: number): number {
    return binarySearch(this._chunks.length, (i: number) => {
      const [start, data] = this._chunks[i];
      if (target < start) return -1;
      if (target >= start + data.length) return 1;
      return 0;
    });
  }

  apply(target: Uint8Array) {
    if (target.length < this._length) throw new Error(`Target too small.`);
    for (const [start, chunk] of this._chunks) {
      target.set(chunk, start);
    }
  }

  chunks(): ReadonlyArray<readonly [number, Uint8Array]> {
    return this._chunks;
  }

  get(index: number): number|undefined {
    const i = this._find(index);
    if (i < 0) return undefined;
    const [start, data] = this._chunks[i];
    return data[index - start];
  }

  set(start: number, data: ArrayLike<number>): void;
  set(start: number, ...values: number[]): void;
  set(start: number, ...args: [ArrayLike<number>]|number[]) {
    if (!args.length) return;
    const first = args[0];
    this.setInternal(start, typeof first === 'number' ? args as number[] : first);
  }

  private setInternal(start: number, values: ArrayLike<number>) {
    const len = values.length;
    if (!len) return; // nothing to do
    const end = start + len;
    this._length = Math.max(this._length, end);
    let i0 = this._find(start);
    let i1 = this._find(end);
    if (i0 >= 0 && i0 === i1) {
      // Trivial case of overwriting already-filled bytes.
      const [s0, a0] = this._chunks[i0];
      a0.set(values, start - s0);
      return;
    }
    // Widen the replaced range to swallow whatever we overlap, plus a chunk
    // that merely abuts on either side, so the result stays a single run.
    const prev = this._chunks[~i0 - 1];
    if (prev && prev[0] + prev[1].length === start) i0 = ~i0 - 1;
    if (this._chunks[~i1]?.[0] === end) i1 = ~i1;
    const head = i0 >= 0 ? this._chunks[i0] : undefined;
    const tail = i1 >= 0 ? this._chunks[i1] : undefined;
    const newStart = head ? head[0] : start;
    const newEnd = tail ? tail[0] + tail[1].length : end;
    const total = newEnd - newStart;

    let out: Uint8Array;
    if (!head) {
      out = new Uint8Array(total);
    } else if (head[1].buffer.byteLength >= total) {
      // Reuse the head chunk's buffer since its bytes are already in place.
      out = new Uint8Array(head[1].buffer, 0, total);
    } else {
      // double the size of the buffer and then add the new data.
      out = new Uint8Array(new ArrayBuffer(Math.max(total, head[1].length * 2)), 0, total);
      out.set(head[1]);
    }
    out.set(values, start - newStart);
    // `tail` is a different chunk than `head` here (equal indices took the fast
    // path above), so it owns a different buffer and can't alias `out`.
    if (tail && end < newEnd) out.set(tail[1].subarray(end - tail[0]), end - newStart);

    const s = i0 < 0 ? ~i0 : i0;
    let e = i1 < 0 ? ~i1 : i1;
    if (i1 >= 0) e++;
    this._chunks.splice(s, e - s, [newStart, out]);
  }

  splice(start: number, length = 1) {
    const end = start + length;
    let i0 = this._find(start);
    let i1 = this._find(end);
    let e0: Chunk|undefined;
    let e1: Chunk|undefined;
    if (i0 >= 0) {
      const [s0, a0] = this._chunks[i0];
      const l0 = start - s0;
      // the head keeps the original buffer, and the tail gets allocated a new one
      if (l0) e0 = [s0, a0.subarray(0, l0)];
      else i0 = ~i0;
    }
    if (i1 >= 0) {
      const [s1, a1] = this._chunks[i1];
      e1 = [end, a1.slice(end - s1)];
    }

    const entries: Chunk[] = [];
    if (e0) entries.push(e0);
    if (e1) entries.push(e1);

    const s = i0 < 0 ? ~i0 : i0;
    let e = i1 < 0 ? ~i1 : i1;
    if (i1 >= 0) e++;

    this._chunks.splice(s, e - s, ...entries);
  }

  /** Returns a copy of `[start, end)`, which must be entirely present. */
  slice(start: number, end: number): Uint8Array {
    if (end <= start) return new Uint8Array(0);
    const i = this._find(start);
    if (i < 0) throw new Error(`Absent: ${start}`);
    const [s, a] = this._chunks[i];
    if (s + a.length < end) throw new Error(`Absent: ${s + a.length}`);
    return a.slice(start - s, end - s);
  }

  search(needle: ArrayLike<number>, start?: number, end?: number): number {
    return this.pattern(needle).search(start, end);
  }

  /** Perform a Boyer-Moore search. */
  pattern(needle: ArrayLike<number>): SparseByteArray.Pattern {
    // Stupid trivial edge cases first
    if (!needle.length) return {search: (start = 0) => start};
    const len = needle.length;
    // Build jump table based on mismatched char info
    const charTable: number[] = new Array(256).fill(len);
    for (let i = 0; i < needle.length; i++) {
      charTable[needle[i]] = len - 1 - i;
    }
    // Build jump table based on scan offset for mismatch (bad char rule)
    const offsetTable: number[] = [];
    let lastPrefixPos = len;
    for (let i = len; i > 0; --i) {
      if (isPrefix(i)) {
        lastPrefixPos = i;
      }
      offsetTable[len - i] = lastPrefixPos - i + len;
      for (let i = 0; i < len - 1; ++i) {
        const slen = suffixLength(i);
        offsetTable[slen] = len - 1 - i + slen;
      }
    }
    return {search: (start = 0, end = this._length): number => {
      if (!this._chunks.length || end < start) return -1;
      // handle start position
      let k = this._find(start);
      let i0 = 0;
      if (k >= 0) {
        i0 = start - this._chunks[k][0];
      } else {
        k = ~k;
      }
      while (k < this._chunks.length) {
        const [offset, haystack] = this._chunks[k++];
        const i1 = Math.min(end - offset, haystack.length);
        if (i1 < 0) break;
        for (let i = len - 1 + i0, j; i < i1;) {
          for (j = len - 1; needle[j] === haystack[i]; --i, --j) {
            if (j === 0) return i + offset;
          }
          i += Math.max(offsetTable[len - 1 - j], charTable[haystack[i]]);
        }
        i0 = 0;
      }
      return -1;
    }};

    function isPrefix(p: number) {
      for (let i = p, j = 0; i < len; ++i, ++j) {
        if (needle[i] !== needle[j]) return false;
      }
      return true;
    }
    function suffixLength(p: number) {
      let out = 0;
      for (let i = p, j = len - 1;
           i >= 0 && needle[i] === needle[j];
           --i, --j) {
        ++out;
      }
      return out;
    }
  }

  addOffset(offset: number): SparseByteArray {
    const out = new SparseByteArray();
    for (const [start, data] of this._chunks) {
      out._chunks.push([start + offset, data.slice()]);
    }
    out._length = this._length && this._length + offset;
    return out;
  }

  toIpsPatch(): Uint8Array {
    let size = 8;
    for (const [, chunk] of this._chunks) {
      size += 5 + chunk.length;
    }
    const buffer = new Uint8Array(size);
    let i = 5;
    buffer[0] = 0x50;
    buffer[1] = 0x41;
    buffer[2] = 0x54;
    buffer[3] = 0x43;
    buffer[4] = 0x48;
    for (const [start, chunk] of this._chunks) {
      if (chunk.length > 0xffff) throw new Error(`Oops!`);
      buffer[i++] = start >>> 16;
      buffer[i++] = (start >>> 8) & 0xff;
      buffer[i++] = start & 0xff;
      buffer[i++] = chunk.length >>> 8;
      buffer[i++] = chunk.length & 0xff;
      buffer.subarray(i, i + chunk.length).set(chunk);
      i += chunk.length;
    }
    buffer[i] = 0x45;
    buffer[i + 1] = 0x4f;
    buffer[i + 2] = 0x46;
    return buffer;
  }

  toIpsHexString(): string {
    return toHexViewString(this.toIpsPatch());
  }
}

export function toHexString(data: Uint8Array, spacing: boolean = false): string {
  const spacer = spacing ? " " : "";
  return [...data].map(x => x.toString(16).padStart(2, "0")).join(spacer);
}

export function toHexViewString(data: Uint8Array) : string {
  //return Array.from(this.toIpsPatch(), x => x.toString(16).padStart(2, '0'))
  // NOTE: this format is compatible with `xxd -r foo.ips.hex > foo.ips`
  const bytes = [...data];
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push([i.toString(16).padStart(8, '0') + ':',
                ...bytes.slice(i, i + 16)
                    .map(x => x.toString(16).padStart(2, '0'))].join(' '));
  }
  return lines.join('\n');
}

export function fromHexString(str: string): Uint8Array {
  str = str.replaceAll(' ', '');
  if (str.length % 2)
    str = '0' + str;

  const bytes: number[] = [];
  for (let offs = 0; offs < str.length; offs += 2)
    bytes.push(parseInt(str.substring(offs, offs + 2), 16));

  return new Uint8Array(bytes);
}

export function fromByteString(str: string): Uint8Array {
  return new Uint8Array([...str].map(x => x.charCodeAt(0)))
}

// deno-lint-ignore no-namespace
export namespace SparseByteArray {
  export interface Pattern {
    search(start?: number, end?: number): number;
  }
}


export class BitSet {
  private data = new Uint8Array(16);

  add(i: number) {
    const byte = i >>> 3;
    if (byte >= this.data.length) {
      let newSize = this.data.length;
      while (newSize <= byte) newSize <<= 1;
      const newData = new Uint8Array(newSize);
      newData.subarray(0, this.data.length).set(this.data);
      this.data = newData;
    }
    this.data[byte] |= (1 << (i & 7));
  }

  delete(i: number) {
    const byte = i >>> 3;
    if (byte < this.data.length) this.data[byte] &= ~(1 << (i & 7));
  }

  has(i: number): boolean {
    return Boolean((this.data[i >>> 3] || 0) & (1 << (i & 7)));
  }
}

/** Index of the first element of a sorted array that is >= `x`. */
export function lowerBound(arr: ArrayLike<number>, x: number): number {
  const i = binarySearch(arr.length, (j: number) => x - arr[j]);
  return i < 0 ? ~i : i;
}

export class IntervalSet implements Iterable<readonly [number, number]> {
  protected data: Array<[number, number]> = [];

  [Symbol.iterator]() {
    return this.data[Symbol.iterator]();
  }

  // This is made protected so the FreeSpace class can create an index tracking
  // the smallest interval ranges.
  protected replace(s: number, e: number, entries: Array<[number, number]>) {
    this.data.splice(s, e - s, ...entries);
  }

  protected _find(v: number): number {
    return binarySearch(this.data.length, (i: number) => {
      const entry = this.data[i];
      //if (!entry) console.log(i, v);
      if (v < entry[0]) return -1;
      if (v >= entry[1]) return 1;
      return 0;
    });
  }

  has(x: number) {
    return this._find(x) >= 0;
  }

  add(start: number, end: number) {
    let i0 = this._find(start);
    let i1 = this._find(end);
    if (this.data[~i0 - 1]?.[1] === start) i0 = ~i0 - 1;
    if (this.data[~i1]?.[0] === end) i1 = ~i1;
    const entry: [number, number] = [start, end];
    if (i0 >= 0) entry[0] = this.data[i0][0];
    if (i1 >= 0) entry[1] = this.data[i1][1];
    const s = i0 < 0 ? ~i0 : i0;
    let e = i1 < 0 ? ~i1 : i1;
    if (i1 >= 0) e++;
    this.replace(s, e, [entry]);
  }

  delete(start: number, end: number) {
    let i0 = this._find(start);
    let i1 = this._find(end);
    let e0 = i0 >= 0 ? this.data[i0] : undefined;
    let e1 = i1 >= 0 ? this.data[i1] : undefined;
    if (e0) {
      e0 = [e0[0], Math.min(e0[1], start)];
      if (e0[0] === e0[1]) {
        e0 = undefined;
        i0 = ~i0;
      }
    }
    if (e1) {
      e1 = [Math.max(e1[0], end), e1[1]];
      if (e1[0] === e1[1]) {
        e1 = undefined;
        i1 = ~i1;
      }
    }

    const entries = [];
    if (e0) entries.push(e0);
    if (e1) entries.push(e1);

    const s = i0 < 0 ? ~i0 : i0;
    let e = i1 < 0 ? ~i1 : i1;
    if (i1 >= 0) e++;

    this.replace(s, e, entries);
  }

  // Given a point, returns an iterator over the intervals to the
  // right of that point (possibly slicing any containing interval).
  tail(x: number): IterableIterator<readonly [number, number]> {
    let index = this._find(x);
    if (index < 0) index = ~index;
    const data = this.data;
    return {
      [Symbol.iterator]() { return this; },
      next() {
        if (index >= data.length) return {value: undefined, done: true};
        const e = data[index++];
        return {value: [Math.max(x, e[0]), e[1]], done: false};
      },
    };
  }
}

const map = new WeakMap<object, number>();
let index = 0;
export function hash(o: object): string {
  let id = map.get(o);
  if (!id) {
    map.set(o, id = ++index);
  }
  return `${o.constructor.name || 'object'}@${id.toString(36)}`;
}

export function assertNever(x: never): never {
  throw new Error(`non-exhaustive check: ${x}`);
}

const PATH_SEP = /[\\/]/;

/** Directory portion of a path ('a/b/c.s' -> 'a/b', 'x.s' -> '', 'a\b\c.s' -> 'a/b'). */
export function dirOf(p: string): string {
  const parts = p.split(PATH_SEP);
  parts.pop();
  return parts.join('/');
}

/** Combine two paths together and handle `.` and `..` when joining */
export function joinDir(base: string, rel: string): string {
  const combined = !base ? rel : !rel ? base : `${base}/${rel}`;
  // A leading separator means a POSIX absolute path and we want to keep the leading
  // root `/` if we are working with an absolute path
  const root = PATH_SEP.test(combined.charAt(0)) ? '/' : '';
  const out: string[] = [];
  for (const part of combined.split(PATH_SEP)) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return root + out.join('/');
}

/**
 * Basic wrapper for a Map that stores a cache of the largest key size.
 * This is intended to be used for charmapping where we need to know what the
 * largest key size is each time we are writing out a new character.
 */
export class MaxKeySizeCacheMap<K, V> {
  private map: Map<K, V>;
  private maxKey: K | undefined = undefined;
  private maxKeySize: number = 0;

  constructor(iterable?: Iterable<readonly [K, V]> | null) {
    this.map = new Map(iterable);
    if (iterable instanceof MaxKeySizeCacheMap) {
      this.maxKey = iterable.getLargestKey();
      this.maxKeySize = iterable.getLargestKeySize();
    } else {
      // Otherwise, evaluate the entries to find the initial maximum
      this.recalculateMaxKey();
    }
  }

  *[Symbol.iterator](): IterableIterator<readonly [K, V]> {
    yield* this.map.entries();
  }

  public getLargestKey(): K | undefined { return this.maxKey; }

  public getLargestKeySize(): number { return this.maxKeySize; }

  get(key: K): V|undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): this {
    this.map.set(key, value);
    this.checkAndUpdateMax(key);
    return this;
  }

  delete(key: K): boolean {
    const wasDeleted = this.map.delete(key);
    if (wasDeleted && Object.is(key, this.maxKey)) {
      this.recalculateMaxKey();
    }
    return wasDeleted;
  }

  clear(): void {
    this.map.clear();
    this.maxKey = undefined;
    this.maxKeySize = 0;
  }

  private checkAndUpdateMax(key: K): void {
    const size = this.calculateSize(key);
    if (size > this.maxKeySize) {
      this.maxKeySize = size;
      this.maxKey = key;
    }
  }

  private recalculateMaxKey(): void {
    let largestSize = 0;
    let largestKey: K | undefined = undefined;

    for (const key of this.map.keys()) {
      const size = this.calculateSize(key);
      if (size > largestSize) {
        largestSize = size;
        largestKey = key;
      }
    }

    this.maxKeySize = largestSize;
    this.maxKey = largestKey;
  }

  // We could set this up to support other non-string key types but
  // this will be fine for our case. its not a big deal.
  private calculateSize(key: K): number { return String(key).length; }
}
