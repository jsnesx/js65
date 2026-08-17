
// SPDX-License-Identifier: MPL-2.0

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
  /** Truncate the value to the correct range. */
  forceRange?: boolean;
}

// Default is "allow"
export type OverwriteMode = 'forbid' | 'allow' | 'require';

// Default is declarationOrder
export type PlacementMode = 'declarationOrder' | 'any' | 'all';

/** Fields shared by Chunk (Uint8Array data) and ChunkNum (number[] data). */
interface BaseChunk {
  /** Human-readable identifier. */
  name?: string;
  /** Which segments this chunk may be located in. */
  segments: string[];
  /** Absolute address of the start of the chunk, if not relocatable. */
  org?: number;
  /** Alignment constraint (a power of two) the linker must place this chunk on */
  align?: number;
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
  /** Tracks if the chunk is assigned to a segment in zeropage.
   * Defaults to abs (false) unless assigned by using .segment "whatever" : zeropage
   * to force the segment to use zeropage (or if the segment was defined in the
   * same compliation unit as zeropage)
   */
  zeropage?: boolean;
  /** Defines the rule used when placing in a segment */
  placement?: PlacementMode;
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
  /** Segment name where the output data goes. Lets you imitate the MEMORY/SEGMENT split from ca65 */
  load?: string;
  /** Similar to load but for the `org` address to write to. */
  run?: string;
  /** Alignment (a power of two) the segment start must satisfy. */
  align?: number;
  /** Alignment of the load position, when load != run. */
  alignLoad?: number;
  /** Occupies address space but emits no bytes (ld65 `type = bss`/`zp`). */
  bss?: boolean;
  /** Emit START/SIZE/LAST/LOAD/RUN/FILEOFFS symbols */
  define?: boolean;
  /** Drop the segment entirely if no chunks land in it. */
  optional?: boolean;
  /** Opt in to byte-pattern sharing during placement (js65 extension). */
  dedupe?: boolean;
  /** True if this segment is the "default" segment to use if no segment is defined */
  default?: boolean;
  /** Unallocated ranges (org), half-open [a, b). */
  free?: number[][];
  /** Linker is required to place data in ALL of the segments in the list */
  mirror?: string[];
  /** Linker places data in ANY ONE of the segments in the list */
  pool?: string[];
}

export const RESERVED_SEGMENT_PREFIX = '@';

export const ANON_SEGMENT_PREFIX = '@anon@';

/** Where an anonymous segment was declared, recovered from its name. */
export interface AnonSegmentSource {
  file: string;
  /** Undefined when the module was assembled without debug info. */
  line?: number;
}

export function anonSegmentName(file: string, line: number|undefined,
                                hash: string): string {
  return `${ANON_SEGMENT_PREFIX}${file}:${line ?? ''}:${hash}`;
}

// deno-lint-ignore no-namespace
export namespace Segment {
  export function isAnon(s: Segment|string): boolean {
    return (typeof s === 'string' ? s : s.name).startsWith(ANON_SEGMENT_PREFIX);
  }
  /** Parses the anonSegmentName into a file:line pair for slightly better error reporting */
  export function anonSource(s: Segment|string): AnonSegmentSource|undefined {
    const name = typeof s === 'string' ? s : s.name;
    if (!isAnon(name)) return undefined;
    const body = name.substring(ANON_SEGMENT_PREFIX.length);
    const hashAt = body.lastIndexOf(':');
    if (hashAt < 0) return undefined;
    const lineAt = body.lastIndexOf(':', hashAt - 1);
    if (lineAt < 0) return undefined;
    const file = body.substring(0, lineAt);
    const lineStr = body.substring(lineAt + 1, hashAt);
    if (!file) return undefined;
    if (lineStr && !/^\d+$/.test(lineStr)) return undefined;
    return {file, line: lineStr ? Number(lineStr) : undefined};
  }
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
