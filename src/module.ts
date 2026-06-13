
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Expr } from './expr.ts';
import type { SourceInfo } from './token.ts';


// export interface Substitution {
//   offset: number;
//   size: number;
//   expr: Expr;
// }

export interface Substitution {
  /** Offset into the chunk to substitute the expression into. */
  offset: number;
  /** Number of bytes to substitute. */
  size: number;
  /** Expression to substitute. */
  expr: Expr;
}

// Default is "allow"
export type OverwriteMode = 'forbid' | 'allow' | 'require';

/** Fields shared by Chunk (Uint8Array data) and ChunkNum (number[] data). */
interface BaseChunk {
  /** Human-readable identifier. */
  name?: string;
  /** Which segments this chunk may be located in. */
  segments: string[];
  /** Absolute address of the start of the chunk, if not relocatable. */
  org?: number;
  /** Substitutions to insert into the data. */
  subs?: Substitution[];
  /** Assertions within this chunk. Each expression must be nonzero. */
  asserts?: Expr[];
  /** How overwriting previously-written fixed-position data is handled. */
  overwrite?: OverwriteMode; // NOTE: only set programmatically?
  /** Source infos for each byte in the chunk. */
  sourceMap?: Map<number, SourceInfo>;
  /** Labels within the chunk, mapped to byte offset. */
  labelIndex?: Map<string, number>;
}

/**
 * Chunk whose data is a number array.
 * NOTE: While building this is a number array.  When serialized to disk, it
 * is a base64-encoded string.  When linking, it's a Uint8Array.
 */
export interface ChunkNum extends BaseChunk {
  data: number[];
}

/** Chunk whose data has been decoded to a Uint8Array (used while linking). */
export interface Chunk extends BaseChunk {
  data: Uint8Array;
}


export interface Symbol {
  /** Name to export this symbol as, for importing into other objects. */
  export?: string;
  // /** Index of the chunk this symbol is defined in. */
  // chunk?: number; // TODO - is this actually necessary?
  // /** Byte offset into the chunk for the definition. */
  // offset?: number;
  /** Value of the symbol. */
  expr?: Expr;
}

// export interface Segment {
//   name: string;
//   bank?: number;
//   size?: number;
//   offset?: number;
//   memory?: number;
//   addressing?: number;
//   default?: boolean;
//   free?: Array<readonly [number, number]>;
// }

export interface Segment {
  /** Name of the segment, as used in .segment directives. */
  name: string;
  /** Bank for the segment. */
  bank?: number;
  /** Segment size in bytes. */
  size?: number;
  /** Offset of the segment in the rom image. */
  offset?: number;
  /** Memory location of the segment in the CPU. */
  memory?: number;
  /** Address size. */
  addressing?: number;
  /** Address size. */
  fill?: number;
  /** Output file for the segment. Use "%O" for the main output file, or a filename. Empty/undefined means no output. */
  out?: string;
  /** Name of the segment that this should be placed inside. */
  overlay?: string;
  /** True if this segment is the "default" segment to use if no segment is defined */
  default?: boolean;
  /** Unallocated ranges (org), half-open [a, b). */
  free?: number[][];
}

// deno-lint-ignore no-namespace
export namespace Segment {
  export function merge(a: Segment, b: Segment): Segment {
    const seg = {...a, ...b};
    const free = [...(a.free || []), ...(b.free || [])];
    if (free.length) seg.free = free;
    return seg;
  }
  export function includesOrg(s: Segment, addr: number): boolean {
    if (s.memory == null || s.size == null) return false;
    return addr >= s.memory && addr < (s.memory + s.size);
  }
}

// export interface Module {
//   chunks?: Chunk<Uint8Array>[],
//   symbols?: Symbol[],
//   segments?: Segment[],
// }

export interface Module {
  /** Filename if loaded from a file, otherwise a user provided name */
  name?: string;
  /** All chunks, in a determinstic (indexable) order. */
  chunks?: Chunk[];
  /** All symbols, in a deterministic (indexable) order. */
  symbols?: Symbol[];
  /** All segments.  Indexed by name, but we don't use a map. */
  segments?: Segment[];
  /** All symbols from all scopes for debug purposes. */
  debugSymbols?: Symbol[];
}
