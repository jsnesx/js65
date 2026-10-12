// SPDX-License-Identifier: MPL-2.0

import { MaxKeySizeCacheMap } from '../util.ts';

export type CharMapping = MaxKeySizeCacheMap<string, number[]>;

/** `.charmap`/`.strmap` state and the `.pushcharmap`/`.popcharmap` stack. */
export class CharMap {
  /** Mapping for any string to byte array  */
  mapping: CharMapping = new MaxKeySizeCacheMap();
  /** Saved charmaps for `.pushcharmap`/`.popcharmap`. */
  private readonly stack: CharMapping[] = [];

  constructor(private readonly fail: (msg: string) => never) {}

  set(code: number, target: number) {
    if (code < 0 || code > 255) this.fail(`.charmap index out of range: ${code}`);
    this.mapping.set(String.fromCodePoint(code), [target & 0xff]);
  }

  strMap(key: string, bytes: number[]) {
    if (!key) this.fail(`.strmap key must not be empty`);
    if (!bytes.length) this.fail(`.strmap value must not be empty`);
    this.mapping.set(key, bytes.map(b => b & 0xff));
  }

  push() {
    this.stack.push(new MaxKeySizeCacheMap(this.mapping));
  }

  pop() {
    this.mapping = this.stack.pop() ?? this.mapping;
  }

  /**
   * Converts the character to the numerical value for the output.
   * This assumes that it is not multimapped to multiple output bytes to keep
   * ca65 compatibility.
   */
  readonly encodeChar = (char: string): number|undefined => {
    const bytes = this.mapping.get(char);
    if (!bytes) return undefined;
    if (bytes.length !== 1) {
      this.fail(`Character literal '${char}' maps to ${bytes.length} bytes`);
    }
    return bytes[0];
  };
}

export function writeString(data: number[], str: string, charmap: CharMapping) {
  // Split into Unicode code points (not js string UTF-16 code units) so a multi-byte
  // character is one unit for both matching and the unmapped fallback.
  const chars = Array.from(str);
  const maxKeyLen = charmap.getLargestKeySize();
  for (let i = 0; i < chars.length; ) {
    // Greedy longest-match, so a `.strmap` key beats the single-character
    // `.charmap` entries it overlaps.
    let bytes: number[]|undefined;
    let len = Math.min(maxKeyLen, chars.length - i);
    for (; len >= 1; len--) {
      bytes = charmap.get(chars.slice(i, i + len).join(''));
      if (bytes) break;
    }
    if (bytes) {
      data.push(...bytes);
      i += len;
    } else {
      // Unmapped: emit the code point/character itself
      data.push(chars[i].codePointAt(0)! & 0xff);
      i++;
    }
  }
}
