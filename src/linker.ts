
// SPDX-License-Identifier: MPL-2.0

import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import type { Expr } from './expr.ts';
import * as Exprs from './expr.ts';
import { type LinkerConfig, lowerLinkerConfig, parseLinkerConfig } from './linkerconfig.ts';
import { type Chunk, type Module, type OverwriteMode, Segment, type Substitution, type Symbol } from './module.ts';
import { Targets } from "./preamble.ts";
import { Preprocessor } from './preprocessor.ts';
import * as Tokens from './token.ts';
import { type SourceInfo } from './token.ts';
import { Tokenizer } from './tokenizer.ts';
import { TokenStream, SourceContents } from './tokenstream.ts';
import { IntervalSet, SparseByteArray, binaryInsert } from './util.ts';

export interface Export {
  value: number;
  offset?: number;
  bank?: number;
  //segment?: string;
}

export type MesenLabelFormatType = "NesMemory"|"NesPrgRom"|"NesInternalRam"|"NesSaveRam"|"NesWorkRam";
export interface MesenLabelFormat {
  type: MesenLabelFormatType,
  address: string,
  label: string,
  comment: string,
}

export class Linker {
  opts: Options;
  // TODO - accept a list of [filename, contents]?
  static assemble(contents: string): Uint8Array {
    const opts = {lineContinuations: true};
    const source = new Tokenizer(contents, 'contents.s', opts);
    const asm = new Assembler(Cpu.P02);
    const toks = new TokenStream(undefined, undefined, opts);
    toks.enter(source);
    const pre = new Preprocessor(toks, asm);
    asm.tokens(pre);
    const linker = new Linker();
    //linker.base(this.prg, 0);
    linker.read(asm.module());
    const out = linker.link();
    const data = new Uint8Array(out.length);
    out.apply(data);
    return data;
  }

  static link(...files: Module[]): SparseByteArray {
    const linker = new Linker();
    for (const file of files) {
      linker.read(file);
    }
    return linker.link();
  }

  private _link = new Link();
  private _exports?: Map<string, Export>;

  constructor(opts: Options = {}) {
    this.opts = opts;
  }

  read(file: Module): Linker {
    this._link.readFile(file);
    return this;
  }

  base(data: Uint8Array, offset = 0): Linker {
    this._link.base(data, offset);
    return this;
  }

  link(signal?: { readonly aborted: boolean }): SparseByteArray {
    // An ld65 config replaces the built-in segment configuration.
    // I don't think its worth trying to sort out using both for now.
    // Maybe at some point we start issuing warnings if they mix the two.
    if (this.opts.linkerConfig != null) {
      this._link.setConfig(parseLinkerConfig(this.opts.linkerConfig,
                                             this.opts.linkerConfigName));
    } else {
      const target = Targets.get(this.opts.target?.toLowerCase())
      if (target) {
        target.segments.forEach( seg => this._link.addRawSegment(seg) );
      }
    }
    return this._link.link(signal);
  }

  report(verbose = false): string {
    return this._link.report(verbose);
  }

  exports(): Map<string, Export> {
    if (this._exports) return this._exports;
    return this._exports = this._link.buildExports();
  }

  watch(...offset: number[]) {
    this._link.watches.push(...offset);
  }

  private static getComment(sourceLines?: string[], line: number = 0, debugLevel: number = 1, sourceInfo?: SourceInfo) {
    let comment = "";

    if (sourceLines && line >= 0) {
      const actualLine = line;
      let firstLine = actualLine;

      if (debugLevel === 0) {
        // Level 0: Only include comments, skip source code and labels
        // Walk backwards while we see comment lines (;) or label definitions (ending with :)
        do { firstLine--; } while (firstLine >= 0 && /^\s*(;|.*:\s*$)/.test(sourceLines[firstLine]));

        const lines = sourceLines.slice(firstLine + 1, actualLine + 1);
        const result: string[] = [];

        for (const l of lines) {
          const trimmed = l.trim();
          // Check if line is a full comment line
          if (/^\s*;/.test(l)) {
            // Remove leading semicolon and colons from comments
            const commentText = trimmed.substring(1).trim().replace(/:/g, '');
            if (commentText) {
              result.push(commentText);
            }
          } else if (/^\s*.*:\s*$/.test(l)) {
            // Label-only line - skip it (labels go in the label field, not comments)
          } else {
            // Check if line has an inline comment (code ; comment)
            const inlineCommentMatch = l.match(/;(.*)$/);
            if (inlineCommentMatch) {
              // Remove colons from the comment (no leading semicolon)
              const commentText = inlineCommentMatch[1].trim().replace(/:/g, '');
              if (commentText) {
                result.push(commentText);
              }
            }
            // Otherwise skip the line (it's just code with no comment)
          }
        }

        comment = result.join('\\n');
      } else {
        // Level 1+: Include comments and code, but not labels
        // Walk backwards while we see comment lines (;) or label definitions (ending with :)
        do { firstLine--; } while (firstLine >= 0 && /^\s*(;|.*:\s*$)/.test(sourceLines[firstLine]));
        // Filter out label-only lines and remove colons from remaining lines
        comment = sourceLines.slice(firstLine + 1, actualLine + 1)
          .filter((s) => !/^\s*\S+:\s*$/.test(s))  // Exclude label-only lines
          .map((s) => s.trim().replace(/:/g, ''))
          .join('\\n');
      }
    }

    // Level 2: Append source file location
    if (debugLevel >= 2 && sourceInfo) {
      const suffix = ` in file ${sourceInfo.file}:${sourceInfo.line}`;
      comment = comment ? comment + suffix : suffix.trim();
    }

    return comment;
  }

  private static getLabelTypeAndAddress(cpuAddr: number): {
    type: MesenLabelFormatType,
    address: number
  } {
    const labelType = (cpuAddr < 0x2000) ? "NesInternalRam" :
        (cpuAddr < 0x6000) ? "NesMemory" :
        (cpuAddr < 0x8000) ? "NesSaveRam" :
        "NesPrgRom";

    let address = cpuAddr;
    // HACKY: SRAM addresses need 0x6000 offset subtracted for MLB format
    if (address >= 0x6000 && labelType === "NesSaveRam") {
      address -= 0x6000;
    }

    return { type: labelType, address };
  }

  getDebugInfo(sources?: SourceContents, debugLevel: number = 1) : string {
    if (!sources) return "";

    // Splitting the full source into lines is O(file size); doing it once per
    // label/range (as the comment lookups below otherwise would) makes debug
    // info generation O(n^2) in the program size. Split each file at most once.
    const sourceLinesCache = new Map<string, string[] | undefined>();
    const getSourceLines = (file: string): string[] | undefined => {
      if (sourceLinesCache.has(file)) return sourceLinesCache.get(file);
      const lines = sources.data.get(file)?.split('\n');
      sourceLinesCache.set(file, lines);
      return lines;
    };

    let data = "";
    const labelMap = new Map<string, MesenLabelFormat>();
    const seenLabels: Set<string> = new Set;

    // Build a set of real label names from all chunk labelIndexes
    // Labels NOT in this set are anonymous/temp labels with lower priority
    const realLabels = new Set<string>();
    for (const c of this._link.chunks || []) {
      if (c.labelIndex) {
        for (const [labelName, _] of c.labelIndex) {
          if (labelName.startsWith('@')) {
            // The de-anonymized version will be in debugSymbols with a _<IDX> suffix
            // We'll mark all labels starting with the base name as real
            const baseName = labelName.substring(1);
            // Find matching de-anonymized labels in debugSymbols
            const symbolsToCheck = this._link.debugSymbols || this._link.symbols || [];
            for (const s of symbolsToCheck) {
              if (s.expr?.sym && s.expr.sym.startsWith(baseName + '_')) {
                realLabels.add(s.expr.sym);
              }
            }
          } else {
            // Regular label - add as-is
            realLabels.add(labelName);
          }
        }
      }
    }

    // Anonymous/temp labels are those NOT in realLabels set
    const isAnonTempLabel = (name: string) => !realLabels.has(name);

    // Helper function to add or merge an entry into the labelMap
    const addLabel = (entry: MesenLabelFormat, isAnonTemp: boolean = false) => {
      const key = `${entry.type}:${entry.address}`;
      const existing = labelMap.get(key);

      if (existing) {
        const existingIsAnonTemp = isAnonTempLabel(existing.label);

        // Merge: prefer real labels over anonymous/temp labels
        if (entry.label && !isAnonTemp && existingIsAnonTemp) {
          // Replace anonymous/temp label with real label
          existing.label = entry.label;
        }
        // Always merge comments if existing doesn't have one
        if (entry.comment && !existing.comment) {
          existing.comment = entry.comment;
        }
      } else {
        // New entry
        labelMap.set(key, entry);
      }
    };

    // Calculate PRG ROM base offset from the minimum segment file offset
    // Find the earliest file offset where the ORG address is at least > $4000
    // which is a good enough approximation for any ROM only output segments
    let prgBaseOffset = Infinity;
    for (const [_, seg] of this._link.segments) {
      if (seg.offset < prgBaseOffset && seg.memory >= 0x4000) {
        prgBaseOffset = seg.offset;
      }
    }
    // If we can't find any "PRG" segments, then just assume there's an iNES header?
    if (prgBaseOffset === Infinity) prgBaseOffset = 0x10;

    // Build a set of all labels that appear in chunks to avoid duplicates
    const chunkLabels = new Set<string>();
    for (const c of this._link.chunks || []) {
      if (c.labelIndex) {
        for (const [label, _offset] of c.labelIndex) {
          chunkLabels.add(label);
        }
      }
    }

    // Check all symbols for constant values and set RAM labels
    // Use debugSymbols if available (contains all symbols), otherwise fall back to symbols (exported only)
    const symbolsToProcess = this._link.debugSymbols || this._link.symbols || [];
    for (const s of symbolsToProcess) {
      if (s.expr?.op !== 'num') continue;
      if (!s.expr.sym) continue;
      if (chunkLabels.has(s.expr.sym)) continue;

      // Resolve chunk-relative expressions to actual addresses
      let labelType: MesenLabelFormatType;
      let addr: number;

      const meta = s.expr.meta;
      const chunk = (meta?.chunk != null && typeof meta.chunk === 'number' && this._link.chunks)
        ? this._link.chunks[meta.chunk]
        : undefined;

      if (chunk?.segment?.isRam || !chunk) {
        // For chunks that are not output to the final ROM, use a heuristic to determine address
        const result = Linker.getLabelTypeAndAddress(s.expr.num ?? 0);
        labelType = result.type;
        addr = result.address;
      } else {
        // For chunks that are output, use the resolved address instead
        const offsetInChunk: number = s.expr.num! - ((meta?.rel) ? 0 : (chunk.org ?? 0));
        const fileOffset = (chunk.offset ?? 0) + offsetInChunk;
        addr = fileOffset - prgBaseOffset;
        labelType = "NesPrgRom";
      }

      // Generate comment from source info if available
      let comment = "";
      if (s.expr.source) {
        const {file, line} = s.expr.source;
        const sourceLines = getSourceLines(file);
        comment = Linker.getComment(sourceLines, line, debugLevel, s.expr.source);
      }
      const isAnonTemp = isAnonTempLabel(s.expr.sym!);
      addLabel({
        type: labelType,
        address: `${addr.toString(16)}`,
        label: s.expr.sym!,
        comment
      }, isAnonTemp);
      seenLabels.add(s.expr.sym!);
    }

    // Pass 2: Process labels from overlapping chunks only
    for (const c of this._link.chunks || []) {
      // Only process overlapping chunks here - they're skipped in Pass 3
      if (!c.overlaps) continue;

      const isRamChunk = c.segment?.isRam ?? false;

      if (!c.labelIndex) continue;

      for (const [labelName, offsetInChunk] of c.labelIndex) {
        // Skip if already emitted in standalone symbols pass
        if (seenLabels.has(labelName)) continue;

        let labelType: MesenLabelFormatType;
        let addr: number;

        // Calculate address based on chunk type
        if (isRamChunk) {
          // RAM chunk - use org + offset to get CPU address
          const cpuAddr = (c.org ?? 0) + offsetInChunk;
          const result = Linker.getLabelTypeAndAddress(cpuAddr);
          labelType = result.type;
          addr = result.address;
        } else {
          // ROM chunk - use file offset
          if (c.offset == null) {
            // Skip relocatable chunks without placement for now
            // They'll be picked up in Pass 3 if they have output bytes
            continue;
          }
          const fileOffset = c.offset + offsetInChunk;
          addr = fileOffset - prgBaseOffset;
          labelType = "NesPrgRom";
        }

        // Get source info from sourceMap if available
        let comment = "";
        const srcInfo = c.sourceMap?.get(offsetInChunk);
        if (srcInfo) {
          const {file, line} = srcInfo;
          const sourceLines = getSourceLines(file);
          comment = Linker.getComment(sourceLines, line - 1, debugLevel, srcInfo);
        }

        // Labels from chunk labelIndex are real labels, not anonymous/temp
        addLabel({
          type: labelType,
          address: addr.toString(16),
          label: labelName,
          comment
        }, false);

        seenLabels.add(labelName);
      }
    }

    // Pass 3: Process source-mapped ranges by iterating output bytes
    for (const c of this._link.chunks || []) {
      if (c.overlaps) continue;
      const isRamChunk = c.segment?.isRam ?? false;
      const rev = new Map();
      for (const [k, v] of (c.labelIndex || [])) {
        rev.set(v, k);
      }

      // Group consecutive bytes with the same source info into ranges
      let rangeStart = -1;
      let rangeEnd = -1;
      let rangeSrcInfo: SourceInfo | undefined;
      let rangeName: string | undefined;
      let name = c.name;

      const flushRange = () => {
        if (rangeStart < 0 || !rangeSrcInfo) return;

        let {file, line} = rangeSrcInfo;
        line--;
        const sourceLines = getSourceLines(file);
        const comment = Linker.getComment(sourceLines, line, debugLevel, rangeSrcInfo);

        // In debug level 0, skip entries with no comment and no label
        const n = !seenLabels.has(rangeName!) ? rangeName! : "";
        if (debugLevel === 0 && !comment && !n) {
          rangeStart = -1;
          return;
        }

        seenLabels.add(n);

        // Format address as range if more than one byte, otherwise single address
        // Mesen uses inclusive end addresses, so subtract 1 from end
        const formatAddr = (start: number, end: number) => {
          if (end > start + 1) {
            return `${start.toString(16)}-${(end - 1).toString(16)}`;
          }
          return start.toString(16);
        };

        if (isRamChunk) {
          // For RAM, use org address directly with proper type
          const memAddrStart = c.org! + rangeStart;
          const memAddrEnd = c.org! + rangeEnd;
          const labelType: MesenLabelFormat['type'] =
              (memAddrStart < 0x2000) ? "NesInternalRam" :
              (memAddrStart < 0x6000) ? "NesMemory" :
              (memAddrStart < 0x8000) ? "NesSaveRam" : "NesWorkRam";

          let addrStart = memAddrStart;
          let addrEnd = memAddrEnd;
          // SRAM addresses need offset adjustment
          if (memAddrStart >= 0x6000 && memAddrStart < 0x8000) {
            addrStart -= 0x6000;
            addrEnd -= 0x6000;
          }

          // Labels from chunk labelIndex (via rev map) are real labels
          addLabel({
            type: labelType,
            address: formatAddr(addrStart, addrEnd),
            label: n,
            comment: comment,
          }, false);
        } else {
          // Calculate the PRG ROM offset (file offset minus the PRG base offset/header)
          const prgRomOffsetStart = c.offset! + rangeStart - prgBaseOffset;
          const prgRomOffsetEnd = c.offset! + rangeEnd - prgBaseOffset;
          // Labels from chunk labelIndex (via rev map) are real labels
          addLabel({
            type: "NesPrgRom",
            address: formatAddr(prgRomOffsetStart, prgRomOffsetEnd),
            label: n,
            comment: comment,
          }, false);
        }

        rangeStart = -1;
      };

      for (let offset = 0; offset < c.size; offset++) {
        name = rev.get(offset) || name;
        const srcInfo = c.sourceMap?.get(offset);

        // Check if this continues the current range
        const sameSource = srcInfo && rangeSrcInfo &&
          srcInfo.file === rangeSrcInfo.file &&
          srcInfo.line === rangeSrcInfo.line;

        if (srcInfo && sameSource && offset === rangeEnd) {
          // Continue the range
          rangeEnd = offset + 1;
        } else {
          // Flush previous range and start new one
          flushRange();

          if (srcInfo) {
            rangeStart = offset;
            rangeEnd = offset + 1;
            rangeSrcInfo = srcInfo;
            rangeName = name;
          }
        }
      }

      // Flush final range
      flushRange();
    }

    // Generate final output from the merged labelMap
    for (const label of labelMap.values()) {
      data += `${label.type}:${label.address}:${label.label}:${label.comment}\n`;
    }
    return data;
  }
}

export interface Options {
  target?: string;
  /** Full text of the linker config file. */
  linkerConfig?: string;
  /** Name to report `linkerConfig` parse errors against. */
  linkerConfigName?: string;
}

// TODO - link-time only function for getting either the original or the
//        patched byte.  Would allow e.g. copy($8000, $2000, "1e") to move
//        a bunch of code around without explicitly copy-pasting it in the
//        asm patch.

// Tracks an export.
// interface Export {
//   chunks: Set<number>;
//   symbol: number;
// }

function fail(msg: string): never {
  throw new Error(msg);
}

/** Rounds up to the next multiple of `align`, which must be positive. */
function alignUp(value: number, align: number): number {
  // NOTE: arithmetic rather than bit twiddling, since offsets in RAM segments
  // are past the 32-bit sign bit (see LinkSegment.RAM_OFFSET).
  return align > 1 ? Math.ceil(value / align) * align : value;
}

class LinkSegment {
  readonly name: string;
  readonly bank: number;
  readonly size: number;
  readonly offset: number;
  readonly memory: number;
  readonly addressing: number;
  /** Byte to fill unused space with, or undefined to leave it alone. */
  readonly fill: number|undefined;
  /** Whether chunks placed here may share bytes with identical data. */
  readonly dedupe: boolean;
  readonly isRam: boolean;
  /**
   * Space reserved by unmapped segments within a mapped segment.
   * Only applies to a scenario where you have chunks directly written
   * through an unmapped segment AND chunks written directly to this
   * mapped segment.
   */
  readonly used: number;

  constructor(segment: Segment, used = 0) {
    const name = this.name = segment.name;
    this.bank = segment.bank ?? 0;
    this.addressing = segment.addressing ?? 2;
    this.size = segment.size ?? fail(`Size must be specified: ${name}`);
    // A segment is RAM if it emits no bytes, declared `bss`/`zp`, or
    // (the legacy heuristic) it has no output file and no offset specified.
    // If out is specified (any string), it outputs.
    // If offset is specified without out, it outputs to main file.
    this.isRam = segment.bss ?? (!segment.out && segment.offset == null);
    // For RAM segments, offset defaults to memory (so delta=0, org space = tracking space)
    this.offset = segment.offset ?? (this.isRam ? segment.memory ?? 0 : fail(`Offset must be specified: ${name}`));
    // this.memory = segment.memory ?? fail(`Memory must be specified: ${name}`);
    // Allow memory offset to be null for non-prg segments
    this.memory = segment.memory ?? 0;
    this.fill = segment.fill;
    this.dedupe = segment.dedupe ?? false;
    this.used = used;
  }

  // offset = org + delta
  // For RAM segments, use a high bit offset to separate from ROM file offset space
  // This prevents RAM free space tracking from conflicting with ROM file offsets
  static readonly RAM_OFFSET = 0x80000000;
  get delta(): number { return this.isRam ? LinkSegment.RAM_OFFSET : (this.offset - this.memory); }
}

class LinkChunk {
  readonly name: string|undefined;
  readonly size: number;
  /** Alignment (a power of two) for placing this chunk. */
  readonly align: number|undefined;
  segments: readonly string[];
  asserts: Expr[];

  subs = new Set<Substitution>();
  selfSubs = new Set<Substitution>();

  /** Symbols that are imported into this chunk (these are also deps). */
  imports = new Set<string>();
  // /** Symbols that are exported from this chunk. */
  // exports = new Set<string>();

  follow = new Map<Substitution, LinkChunk>();

  /**
   * Whether the chunk is placed overlapping with something else.
   * Overlaps aren't written to the patch.
   */
  overlaps = false;

  /** Table of contents for labels in the chunk, for debugging. */
  readonly labelIndex: Map<string, number>|undefined;

  /** Table of contents for source info in the chunk, for debugging. */
  readonly sourceMap: Map<number, SourceInfo>|undefined;

  private _data?: Uint8Array;

  private _org?: number;
  private _offset?: number;
  private _segment?: LinkSegment;

  private readonly _overwrite: OverwriteMode;

  constructor(readonly linker: Link,
              readonly index: number,
              chunk: Chunk,
              chunkOffset: number,
              symbolOffset: number) {
    this.name = chunk.name;
    this.size = chunk.data.length;
    this.align = chunk.align;
    this.segments = chunk.segments;
    this.labelIndex = chunk.labelIndex && new Map(chunk.labelIndex);
    this.sourceMap = chunk.sourceMap && new Map(chunk.sourceMap);
    this._data = chunk.data;
    for (const sub of chunk.subs || []) {
      this.subs.add(translateSub(sub, chunkOffset, symbolOffset));
    }
    this.asserts = (chunk.asserts || [])
        .map(e => translateExpr(e, chunkOffset, symbolOffset));
    if (chunk.org != null) this._org = chunk.org;
    this._overwrite = chunk.overwrite || 'allow';
  }

  get org() { return this._org; }
  get offset() { return this._offset; }
  get segment() { return this._segment; }
  get data() { return this._data ?? fail('no data'); }

  initialPlacement() {
    // Invariant: exactly one of (data) or (org, _offset, _segment) is present.
    // If (org, ...) filled in then we use linker.data instead.
    // We don't call this in the ctor because it depends on all the segments
    // being loaded, but it's the first thing we do in link().
    if (this._org == null) return;
    const eligibleSegments: LinkSegment[] = [];
    for (const name of this.segments) {
      const s = this.linker.segments.get(name);
      if (!s) throw new Error(`Unknown segment: ${name}`);
      if (this._org >= s.memory && this._org < s.memory + s.size) {
        eligibleSegments.push(s);
      }
    }
    if (eligibleSegments.length !== 1) {
      throw new Error(`Non-unique segment for ${this.name}:\n${''
          }Segments: ${this.segments.join(',')}, ${''
          }org: $${this.org?.toString(16)}, ${''
          }offset: $${this.offset?.toString(16)}\n${''
          }Eligible: [${eligibleSegments}]`);
    }
    const segment = eligibleSegments[0];
    if (this._org >= segment.memory + segment.size) {
      throw new Error(`Chunk does not fit in segment ${segment.name}`);
    }
    this.place(this._org, segment, this._overwrite);
  }

  // NOTE: overwrite is only passed for direct placements!
  place(org: number, segment: LinkSegment, overwrite?: OverwriteMode) {
    this._org = org;
    this._segment = segment;
    const offset = this._offset = org + segment.delta;
    for (const w of this.linker.watches) {
      if (w >= offset && w < offset + this.size)
        fail("Unable to place");
    }
    binaryInsert(this.linker.placed, x => x[0], [offset, this]);

    // For RAM segments, skip data manipulation but still track free space
    if (segment.isRam) {
      this.linker.free.delete(offset, offset + this.size);
      // Notify follow-ons
      for (const [sub, chunk] of this.follow) {
        chunk.resolveSub(sub, false);
      }
      this._data = undefined;
      return;
    }

    // Copy data, leaving out any holes
    const full = this.linker.data;
    const data = this._data ?? fail(`No data`);
    this._data = undefined;

    if (this.subs.size) {
      full.splice(offset, data.length);
      const sparse = new SparseByteArray();
      sparse.set(0, data);
      for (const sub of this.subs) {
        sparse.splice(sub.offset, sub.size);
      }
      for (const [start, chunk] of sparse.chunks()) {
        full.set(offset + start, ...chunk);
      }
    } else {
      full.set(offset, data);
    }

    if (overwrite && data.length) {
      // Regardless of the check mode, it's a direct write so record it
      let overwritten: boolean|null = false;
      const [next] = this.linker.written.tail(offset);
      if (next?.[0] <= offset && next[1] >= offset + data.length) {
        overwritten = true;
      } else if (next?.[0] < offset + data.length) {
        overwritten = null;
      }
      let error = '';
      if (overwrite === 'require' && overwritten !== true) {
        error = `required to overwrite ${data.length} bytes but did not.`;
      } else if (overwrite === 'forbid' && overwritten !== false) {
        error = `forbidden to overwrite ${data.length} but did anyway.`;
      }
      if (error) {
        error = `Chunk at ${segment.name}:$${
            org.toString(16).padStart(4, '0')} (offset $${
            offset.toString(16).padStart(5, '0')} was ${error}`;
        if (!NO_THROW) throw new Error(error);
        if (!QUIET) console.error(error);
      }
      this.linker.written.add(offset, offset + data.length);
    }

    // Retry the follow-ons
    for (const [sub, chunk] of this.follow) {
      chunk.resolveSub(sub, false);
    }

    this.linker.free.delete(this.offset!, this.offset! + this.size);
  }

  resolveSubs(initial = false) { //: Map<number, Substitution[]> {
    // iterate over the subs, see what progres we can make?
    // result: list of dependent chunks.

    // NOTE: if we depend on ourself then we will return empty deps,
    //       and may be placed immediately, but will still have holes.
    //      - NO, it's responsibility of caller to check that
    for (const sub of this.selfSubs) {
      this.resolveSub(sub, initial);
    }

    // const deps = new Set();
    for (const sub of this.subs) {
      // const subDeps = 
      this.resolveSub(sub, initial);
      // if (!subDeps) continue;
      // for (const dep of subDeps) {
      //   let subs = deps.get(dep);
      //   if (!subs) deps.set(dep, subs = []);
      //   subs.push(sub);
      // }
    }
    // if (this.org != null) return new Set();
    // return deps;
  }

  addDep(sub: Substitution, dep: number) {
    if (dep === this.index && this.subs.delete(sub)) this.selfSubs.add(sub);
    this.linker.chunks[dep].follow.set(sub, this);
  }

  // Returns a list of dependent chunks, or undefined if successful.
  resolveSub(sub: Substitution, initial: boolean) { //: Iterable<number>|undefined {

    // TODO - resolve(resolver) via chunkData to resolve banks!!


    // Do a full traverse of the expression - see what's blocking us.
    if (!this.subs.has(sub) && !this.selfSubs.has(sub)) return;
    sub.expr = Exprs.traverse(sub.expr, (e, rec, p) => {
      // First handle most common bank byte case, since it triggers on a
      // different type of resolution.
      if (initial && p?.op === '^' && p.args!.length === 1 && e.meta) {
        if (e.meta.bank == null) {
          this.addDep(sub, e.meta.chunk!);
        }
        return e; // skip recursion either way.
      }
      e = this.linker.resolveLink(Exprs.evaluate(rec(e)));
      if (initial && e.meta?.rel) this.addDep(sub, e.meta.chunk!);
      return e;
    });

    // PROBLEM - off is relative to the chunk, but we want to be able to
    // specify an ABSOLUTE org within a segment...!
    // An absolute offset within the whole orig is no good, either
    // want to write it as .segment "foo"; Sym = $1234
    // Could also just do .move count, "seg", $1234 and store a special op
    // that uses both sym and num?

    // See if we can do it immediately.
    let del = false;
    if (sub.expr.op === 'num' && !sub.expr.meta?.rel) {
      this.writeValue(sub.offset, sub.expr.num!, sub.size, sub.expr.meta?.branch, sub.expr.source);
      del = true;
    } else if (sub.expr.op === '.move') {
      if (sub.expr.args!.length !== 1) throw new Error(`bad .move`);
      const child = sub.expr.args![0];
      if (child.op === 'num' && child.meta?.offset != null) {
        const delta =
            child.meta!.offset! - (child.meta!.rel ? 0 : child.meta!.org!);
        const start = child.num! + delta;
        const slice = this.linker.orig.slice(start, start + sub.size);
        this.writeBytes(sub.offset, Uint8Array.from(slice));
        del = true;
      }
    }
    if (del) {
      this.subs.delete(sub) || this.selfSubs.delete(sub);
    }
  }

  writeBytes(offset: number, bytes: Uint8Array) {
    if (this._data) {
      this._data.subarray(offset, offset + bytes.length).set(bytes);
    } else if (this._offset != null) {
      this.linker.data.set(this._offset + offset, bytes);
    } else {
      throw new Error(`Impossible`);
    }
  }

  writeValue(offset: number, val: number, size: number, isBranch?: boolean, source?: SourceInfo) {
    // Check range based on whether this is a branch (signed) or regular value
    if (isBranch) {
      // Branch offsets use signed range
      const min = -(1 << ((size << 3) - 1));  // -128 for 1 byte, -32768 for 2 bytes
      const max = (1 << ((size << 3) - 1)) - 1;  // 127 for 1 byte, 32767 for 2 bytes
      if (val < min || val > max) {
        const at = source ? Tokens.at({source}) : '';
        throw new Error(`Branch out of range: offset ${val} at $${
            (this.org! + offset).toString(16)} (valid range: ${min} to ${max})${at}`);
      }
    } else {
      // Regular values use unsigned range check
      // NOTE: 2**bits rather than 1<<bits, since a 4-byte value shifts by 32,
      // which wraps around to 1 and rejects everything.
      const bits = (size) << 3;
      const limit = 2 ** bits;
      if (val != null && (val < -limit || val >= limit)) {
        const name = ['byte', 'word', 'farword', 'dword'][size - 1];
        throw new Error(`Not a ${name}: $${val.toString(16)} at $${
            (this.org! + offset).toString(16)}`);
      }
    }
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = val & 0xff;
      val >>= 8;
    }
    this.writeBytes(offset, bytes);
  }
}

function translateSub(s: Substitution, dc: number, ds: number): Substitution {
  s = {...s};
  s.expr = translateExpr(s.expr, dc, ds);
  return s;
}
function translateExpr(e: Expr, dc: number, ds: number): Expr {
  e = {...e};
  if (e.meta) e.meta = {...e.meta};
  if (e.args) e.args = e.args.map(a => translateExpr(a, dc, ds));
  if (e.meta?.chunk != null) e.meta.chunk += dc;
  if (e.op === 'sym' && e.num != null) e.num += ds;
  return e;
}
function translateSymbol(s: Symbol, dc: number, ds: number): Symbol {
  s = {...s};
  if (s.expr) s.expr = translateExpr(s.expr, dc, ds);
  return s;
}

// This class is single-use.
class Link {
  data = new SparseByteArray();
  orig = new SparseByteArray();

  // Maps symbol to symbol # // [symbol #, dependent chunks]
  exports = new Map<string, number>(); // readonly [number, Set<number>]>();
  chunks: LinkChunk[] = [];
  symbols: Symbol[] = [];
  debugSymbols?: Symbol[] = undefined;
  written = new IntervalSet();
  free = new IntervalSet();
  rawSegments = new Map<string, Segment[]>();
  segments = new Map<string, LinkSegment>();

  /**
   * Names of the segments in the order they are filled.
   * This comes from first, the order they appear in the ld65 linker script,
   * and then second the order they appear in object files (parsed in the
   * order they are passed into the link command)
   */
  segmentOrder: string[] = [];
  private segmentIndex = new Map<string, number>();
  /** Names of mapped segments that other unmapped segments are written to. */
  private segmentMappings = new Set<string>();
  /** Track the `used` values for each mapped segment */
  private segmentUsed = new Map<string, number>();

  watches: number[] = []; // debugging aid: offsets to watch.
  placed: Array<[number, LinkChunk]> = [];
  initialReport = '';

  base(data: Uint8Array, offset = 0) {
    this.data.set(offset, data);
    this.orig.set(offset, data);
  }

  readFile(file: Module) {
    const dc = this.chunks.length;
    const ds = this.symbols.length;
    // segments come first, since LinkChunk constructor needs them
    for (const segment of file.segments || []) {
      this.addRawSegment(segment);
    }
    for (const chunk of file.chunks || []) {
      const lc = new LinkChunk(this, this.chunks.length, chunk, dc, ds);
      this.chunks.push(lc);
    }
    for (const symbol of file.symbols || []) {
      this.symbols.push(translateSymbol(symbol, dc, ds));
    }
    // Read debug symbols if available
    if (file.debugSymbols) {
      if (!this.debugSymbols) this.debugSymbols = [];
      for (const symbol of file.debugSymbols) {
        this.debugSymbols.push(translateSymbol(symbol, dc, ds));
      }
    }
    // TODO - what the heck do we do with segments?
    //      - in particular, who is responsible for defining them???

    // Basic idea:
    //  1. get all the chunks
    //  2. build up a dependency graph
    //  3. write all fixed chunks, memoizing absolute offsets of
    //     missing subs (these are not eligible for coalescing).
    //     -- probably same treatment for freed sections
    //  4. for reloc chunks, find the biggest chunk with no deps.
  }

  // resolveChunk(chunk: LinkChunk) {
  //   //if (chunk.resolving) return; // break any cycles
    
  // }

  resolveLink(expr: Expr): Expr {
    if (expr.op === '.orig' && expr.args?.length === 1) {
      const child = expr.args[0];
      const offset = child.meta?.offset;
      if (offset != null) {
        const num = this.orig.get(offset + child.num!);
        if (num != null) return {op: 'num', num};
      }
    } else if (expr.op === 'num' && expr.meta?.chunk != null) {
      const meta = expr.meta;
      const chunk = this.chunks[meta.chunk!];
      if (chunk.org !== meta.org ||
          chunk.segment?.bank !== meta.bank ||
          chunk.offset !== meta.offset) {
        const meta2 = {
          org: chunk.org,
          offset: chunk.offset,
          bank: chunk.segment?.bank,
        };
        expr = Exprs.evaluate({...expr, meta: {...meta, ...meta2}});
      }
    }
    return expr;
  }

  // NOTE: so far this is only used for asserts?
  // It basically copy-pastes from resolveSubs... :-(

  resolveExpr(expr: Expr): number {
    expr = Exprs.traverse(expr, (e, rec) => {
      return this.resolveLink(Exprs.evaluate(rec(e)));
    });

    if (expr.op === 'num' && !expr.meta?.rel) return expr.num!;
    const at = Tokens.at(expr);
    throw new Error(`Unable to fully resolve expr${at}`);
  }

  link(signal?: { readonly aborted: boolean }): SparseByteArray {
    // Preserve the order that the segments are declared
    for (const name of [...this.segmentOrder, ...this.rawSegments.keys()]) {
      if (this.segmentIndex.has(name)) continue;
      this.segmentIndex.set(name, this.segmentIndex.size);
    }
    this.segmentOrder = [...this.segmentIndex.keys()];
    // Merge all segments (mapped and unmapped) into a single Segment each.
    // Note that we intentionally copy the segments into `s` so we don't overwrite
    // the original data.
    const merged = new Map<string, Segment>();
    for (const [name, segments] of this.rawSegments) {
      let s = {...segments[0]};
      for (let i = 1; i < segments.length; i++) {
        s = Segment.merge(s, segments[i]);
      }
      merged.set(name, s);
    }
    // Resolve unmapped segments and hand out file offsets, so that everything
    // below sees plain memory/offset/size.
    this.lowerSegments(merged);

    // Build up the LinkSegment objects
    for (const [name, s] of merged) {
      this.segments.set(name, new LinkSegment(s, this.segmentUsed.get(name)));
    }
    // Add the free space
    for (const [name, s] of this.segments) {
      // Check to see if the user has declared any space free in the segment,
      // if not then we treat the entire segment as free'd
      const explicit =
          (this.rawSegments.get(name) ?? []).flatMap(seg => seg.free ?? []);
      if (explicit.length) {
        for (const [start, end] of explicit) {
          if (end <= start) continue;
          this.free.add(start + s.delta, end + s.delta);
          // Only an explicitly declared free range takes its bytes out of the
          // base image - a synthesized one would wipe out the very bytes a
          // patch build searches for.
          this.data.splice(start + s.delta, end - start);
        }
      } else if (s.size > 0) {
        // Mark the entire segment as free if it was originally a mapped
        // segment. We don't want originally unmapped segments to be
        // automatically freed since they don't "own" the space
        // There is an exception to this, a mapped segment holding chunks of
        // that the user wrote directly, owns whatever that data.
        const from = this.segmentMappings.has(name) ?
            this.segmentUsed.get(name) : 0;
        if (from != null && from < s.size) {
          this.free.add(s.memory + from + s.delta, s.memory + s.size + s.delta);
        }
      }
    }
    // Set up all the initial placements.
    for (const chunk of this.chunks) {
      chunk.initialPlacement();
    }
    if (DEBUG) {
      this.initialReport = `Initial:\n${this.report(true)}`;
    }
    // Find all the exports.
    for (let i = 0; i < this.symbols.length; i++) {
      const symbol = this.symbols[i];
      // TODO - we'd really like to identify this earlier if at all possible!
      if (!symbol.expr) throw new Error(`Symbol ${i} never resolved`);
      // look for imports/exports
      if (symbol.export != null) {
        this.exports.set(symbol.export, i);
      }
    }
    // Resolve all the imports in all symbol and chunk.subs exprs.
    for (const symbol of this.symbols) {
      symbol.expr = this.resolveSymbols(symbol.expr!);
    }
    for (const chunk of this.chunks) {
      for (const sub of [...chunk.subs, ...chunk.selfSubs]) {
        sub.expr = this.resolveSymbols(sub.expr);
      }
      for (let i = 0; i < chunk.asserts.length; i++) {
        chunk.asserts[i] = this.resolveSymbols(chunk.asserts[i]);
      }
    }
    // At this point, we don't care about this.symbols at all anymore.
    // Now figure out the full dependency tree: chunk #X requires chunk #Y
    for (const c of this.chunks) {
      c.resolveSubs(true);
    }

    // Resolve everything that can be resolved without knowing where the
    // relocatable chunks will land.
    for (const chunk of this.chunks) {
      chunk.resolveSubs();
    }

    // Now place them. Segments are filled by declaration order first,
    // and within the segment, filled from largest to smalled. Anything that
    // still depends on a different segment can be resolved later.
    const candidates = new Map<string, LinkChunk[]>();
    for (const chunk of this.chunks) {
      if (chunk.org != null) continue;  // already placed by initialPlacement
      const [first] = this.eligibleSegments(chunk);
      if (first == null) continue;      // no segment at all: reported below
      let list = candidates.get(first);
      if (!list) candidates.set(first, list = []);
      list.push(chunk);
    }
    for (const name of this.segmentOrder) {
      const list = candidates.get(name);
      if (!list) continue;
      list.sort((a, b) => b.size - a.size || a.index - b.index);
      for (const chunk of list) {
        if (signal?.aborted) throw new Error('Compilation cancelled');
        chunk.resolveSubs();
        this.placeChunk(chunk);
      }
    }
    // Anything eligible for no segment at all never got a chance above, so
    // let placeChunk report it.
    for (const chunk of this.chunks) {
      if (chunk.org == null) this.placeChunk(chunk);
    }


    // At this point, everything should be placed, so do one last resolve.
    const patch = new SparseByteArray();
    // Before placing the data, add the fill bytes to segments with fill
    for (const [_name, seg] of this.segments) {
      if (seg.isRam) continue;  // RAM segments don't need fill
      if (seg.fill != null) {  // NOTE: fill = 0 still fills.
        const buf = new Uint8Array(new ArrayBuffer(seg.size));
        buf.fill(seg.fill);
        patch.set(seg.offset, buf);
      }
    }
    for (const c of this.chunks) {
      for (const a of c.asserts) {
        const v = this.resolveExpr(a);
        if (v) continue;
        const at = Tokens.at(a);
        throw new Error(`Assertion failed${at}`);
      }
      if (c.overlaps) continue;
      if (c.segment?.isRam) continue;  // RAM chunks not in output
      patch.set(c.offset!, Uint8Array.from(this.data.slice(c.offset!, c.offset! + c.size!)));
    }
    if (DEBUG) console.log(this.report(true));
    return patch;
  }

  /**
   * We have two basic types of segments which share the `segment` name.
   * The first acts as a MEMORY section in the ld65, but where the user can still use it
   * as a segment and put data into it. In ld65 terms, doing `.segment :mem ...` creates
   * both a MEMORY and SEGMENT section that can had data added to it.
   * These are referred to as `mapped` segments.
   * 
   * The second type `.segment :load` gets converted/mapped into the first type
   * to allow the same style of `1 : N` memory : segment mapping that ld65 supports.
   * These are referred to as `unmapped` segments.
   * 
   * Things get complicated when supporting different load / run addresses.
   * We need to place the data at a `load` address, but set the pc at the run address.
   * This is the mega function that maps the unmapped type of segments into the mapped
   * typed which greatly simplifies the later linking code, since we will have actual
   * file offsets / :mem addresses to use.
   * 
   * If a segment already has the :mem/:size etc, then this phase doesn't do anything.
   * Its just for lowering the `:load/:run` type segments to fill out the :mem for them.
   */
  private lowerSegments(merged: Map<string, Segment>) {
    const order = this.segmentOrder.filter(name => merged.has(name));
    const needsLowering = (s: Segment) => s.load != null || s.run != null;

    // Build a map of segment names -> chunks with the chunks preferring
    // to land in the first segment that it lists.
    const contents = new Map<string, LinkChunk[]>();
    const referenced = new Set<string>();
    for (const chunk of this.chunks) {
      const eligible = this.eligibleSegments(chunk);
      for (const name of eligible) referenced.add(name);
      const [first] = eligible;
      if (first == null) continue;
      let list = contents.get(first);
      if (!list) contents.set(first, list = []);
      list.push(chunk);
    }

    // Phase 1: measure each unmapped segment against its contents.
    // Sizing isn't dependant on final org, its just using the relative size
    // of the chunks in it.
    const sizes = new Map<string, number>();
    const aligns = new Map<string, number>();
    const unmapped: Segment[] = [];
    for (const name of order) {
      const seg = merged.get(name)!;
      if (!needsLowering(seg)) continue;
      const chunks = contents.get(name) ?? [];
      if (seg.optional && !referenced.has(name)) {
        merged.delete(name);
        continue;
      }
      unmapped.push(seg);
      // Enforcing the widest chunk alignment on the segment start is what
      // makes a segment-relative chunk alignment equal an absolute one.
      let align = seg.align ?? 1;
      for (const c of chunks) align = Math.max(align, c.align ?? 1);
      aligns.set(name, align);
      let size = seg.size;
      if (size == null) {
        let cursor = 0;
        const bySize =
            [...chunks].sort((a, b) => b.size - a.size || a.index - b.index);
        for (const c of bySize) {
          cursor = alignUp(cursor, c.align ?? 1) + c.size;
        }
        size = cursor;
      }
      for (const c of chunks) {
        if (c.org == null) continue;
        if (seg.memory == null) {
          fail(`Segment ${name} holds a .org chunk${
              c.name ? ` (${c.name})` : ''} but has no address of its own. ${''
              }.org can only be used in segments with :mem`);
        }
        size = Math.max(size, c.org + c.size - seg.memory);
      }
      sizes.set(name, size);
    }

    const used = new Map<string, number>(); // mapped seg name -> # of allocated bytes
    const runs = new Map<string, number>(); // mapped seg name -> next start addr for RUN
    const loads = new Map<string, number>(); // mapped seg name -> next start addr for LOAD
    // Helper function to validate and find the mapped segment that backs
    // this unmapped segment.
    const mappingOf = (seg: Segment, which: 'load'|'run'): Segment => {
      const name = (which === 'load' ? seg.load ?? seg.run : seg.run ?? seg.load)!;
      const mapped = merged.get(name);
      if (!mapped) {
        fail(`Segment ${seg.name} has ${which} "${name}", which is not a segment`);
      }
      if (needsLowering(mapped)) {
        fail(`Segment ${seg.name} has ${which} "${name}", which is already mapped to memory`);
      }
      this.segmentMappings.add(name);
      return mapped;
    };
    // Helper function that adds the unmapped segments data to the `used` map for
    // the mapped segment. We will go through this `used` map later to build out the
    // :mem and other related fields for mapping the unmapped segment.
    // The goal is to allocate a chunk of space from the mapped segment so we can place
    // in this allocated space later (effectively creates a :mem :start pair for this segment)
    const allocate = (seg: Segment, mapped: Segment, size: number, align: number,
                      memory?: number): number => {
      const base = mapped.memory ?? 0;
      const start = memory ?? alignUp(base + (used.get(mapped.name) ?? 0), align);
      if (start < base ||
          (mapped.size != null && start + size > base + mapped.size)) {
        fail(`Segment ${seg.name} ($${size.toString(16)} bytes at $${
             start.toString(16)}) does not fit in ${mapped.name}`);
      }
      used.set(mapped.name,
               Math.max(used.get(mapped.name) ?? 0, start + size - base));
      return start;
    };
    
    // Build out the new mappings for the unmapped segments, tracking the total
    // size of data needed in the other segment, and also keep track of where the
    // load/run addresses end up at.
    for (const seg of unmapped) {
      const size = sizes.get(seg.name)!;
      const align = aligns.get(seg.name)!;
      const runSeg = mappingOf(seg, 'run');
      const loadSeg = mappingOf(seg, 'load');
      // An explicit :mem places the run address instead of allocating one.
      const run = allocate(seg, runSeg, size, align, seg.memory);
      const load = loadSeg === runSeg ?
          run : allocate(seg, loadSeg, size, seg.alignLoad ?? align);
      runs.set(seg.name, run);
      loads.set(seg.name, load);
    }

    // Now start building out the file offsets `:off` that we will give to unmapped segments.
    // Map of file out name -> next start addr as an offset into the segment (or :size if its :fill)
    const fileLocations = new Map<string, number>();
    for (const name of order) {
      const seg = merged.get(name);
      // Skip over unmapped segments here.
      if (!seg || needsLowering(seg) || seg.bss) continue;
      // Any anything without an output file nor an offset.
      // These are RAM, which takes no file space.
      if (seg.out == null && seg.offset == null) continue;
      const file = seg.out || '%O';
      let cursor = fileLocations.get(file) ?? 0;
      if (seg.offset != null) {
        cursor = seg.offset;
      } else {
        seg.offset = cursor;
      }
      // A filled segment writes its whole size, but an unfilled mapped segment
      // only writes as far as the segments lowered into it actually reached.
      // Unless it holds chunks of its own, which can land anywhere it has space.
      const extent =
          seg.fill == null && this.segmentMappings.has(name) &&
              !referenced.has(name) ?
          (used.get(name) ?? 0) : (seg.size ?? 0);
      fileLocations.set(file, cursor + extent);
    }

    // FINALLY we have all the data we need to map the segment to turn an unmapped
    // segment into a mapped one. Add all of the :out/:fill/ etc data to map it.
    for (const seg of unmapped) {
      const runSeg = mappingOf(seg, 'run');
      const loadSeg = mappingOf(seg, 'load');
      // The loadSeg is what decides whether any bytes are emitted at all.
      const emits = !loadSeg.bss && loadSeg.offset != null;
      seg.size = sizes.get(seg.name)!;
      seg.memory = runs.get(seg.name)!;
      if (emits) {
        seg.offset =
            loadSeg.offset! + (loads.get(seg.name)! - (loadSeg.memory ?? 0));
      }
      seg.out = seg.out ?? loadSeg.out;
      seg.bank = seg.bank ?? loadSeg.bank;
      seg.fill = seg.fill ?? loadSeg.fill;
      seg.addressing = seg.addressing ?? runSeg.addressing;
      seg.bss = seg.bss ?? !emits;
    }

    // A mapped segment that chunks name directly keeps whatever the segments
    // lowered into it left over.
    for (const name of this.segmentMappings) {
      if (referenced.has(name)) this.segmentUsed.set(name, used.get(name) ?? 0);
    }
  }

  /**
   * The segments a chunk may go in, ordered by segment declaration.
   * The chunk is placed in the first one it fits in, and defers to the rest in turn.
   * A chunk that named no segment at all falls back to the default segment.
   */
  eligibleSegments(chunk: LinkChunk): readonly string[] {
    let segments = chunk.segments;
    if (!segments.length) {
      // if this chunk doesn't have a predefined segment, and there is a default segment defined, then use that one
      for (const [name, raw] of this.rawSegments) {
        if (raw.some(s => s.default)) {
          chunk.segments = segments = [name];
          break;
        }
      }
    }
    if (segments.length < 2) return segments;
    const order = (name: string) =>
        this.segmentIndex.get(name) ?? this.segmentIndex.size;
    return [...segments].sort((a, b) => order(a) - order(b));
  }

  placeChunk(chunk: LinkChunk) {
    if (chunk.org != null) return; // don't re-place.
    const size = chunk.size;
    const align = chunk.align ?? 1;
    const segments = this.eligibleSegments(chunk);
    // An empty chunk like a bare label needs no space at all, 
    // so place it at the start of its segment.
    // TODO is there a better way to handle this case?
    if (!size && segments.length) {
      const segment = this.segment(segments[0]);
      chunk.place(segment.memory, segment);
      chunk.overlaps = true;
      return;
    }
    // Check if the chunk can be deduped but placing it at a data segment that overlaps
    // Hueristic, don't search for duplicates for large chunk sizes.
    if (align === 1 && size < 256 && !chunk.subs.size && !chunk.selfSubs.size) {
      // chunk is resolved: search for an existing copy of it first
      const pattern = this.data.pattern(chunk.data);
      for (const name of segments) {
        const segment = this.segment(name);
        if (!segment.dedupe) continue;
        if (segment.isRam) continue;  // Skip pattern matching for RAM segments
        const start = segment.offset;
        const end = start + segment.size;
        const index = pattern.search(start, end);
        if (index < 0) continue;
        chunk.place(index - segment.delta, segment);
        chunk.overlaps = true;
        return;
      }
    }
    // either unresolved, or didn't find a match; just allocate space.
    // look for the smallest possible free block.
    for (const name of segments) {
      const segment = this.segment(name);
      // For RAM segments, free space is tracked with RAM_OFFSET added to memory addresses
      // For ROM segments, free space is tracked in file offset coordinates.
      // Adjacent free ranges merge, so the space a mapped segment handed to the
      // ones lowered into it has to be excluded here rather than left out of
      // `free`.
      const base = segment.isRam ? segment.memory + LinkSegment.RAM_OFFSET : segment.offset;
      const s0 = base + segment.used;
      const s1 = base + segment.size;
      let found: number|undefined;
      let smallest = Infinity;
      for (const [f0, f1] of this.free.tail(s0)) {
        if (f0 >= s1) break;
        const end = Math.min(f1, s1);
        // Find an org address for the data that matches its alignment.
        // Any space from skipping bytes for alignment remain free so we can use it later.
        const start = alignUp(f0 - segment.delta, align) + segment.delta;
        if (start + size > end) continue;
        const df = end - f0;
        if (df < smallest) {
          found = start;
          smallest = df;
        }
      }
      if (found != null) {
        // found a region
        chunk.place(found - segment.delta, segment);
        // this.free.delete(f0, f0 + size);
        // TODO - factor out the subs-aware copy method!
        return;
      }
    }
    if (DEBUG) console.log(`Initial:\n${this.initialReport}`);
    const name = chunk.name ? `${chunk.name} ` : '';
    const where = segments.length ? segments.join(', ') : '(no segment)';
    const aligned = align > 1 ? `${align}-byte aligned ` : '';
    throw new Error(`Could not find space for ${aligned}${size}-byte chunk ${name}in ${where}`);
  }

  segment(name: string): LinkSegment {
    return this.segments.get(name) ??
        fail(`Segment not found with name: ${name}`);
  }

  resolveSymbols(expr: Expr): Expr {
    // pre-traverse so that transitive imports work
    return Exprs.traverse(expr, (e, rec) => {
      while (e.op === 'im' || e.op === 'sym') {
        if (e.op === 'im') {
          const name = e.sym!;
          const imported = this.exports.get(name);
          if (imported == null) {
            const at = Tokens.at(expr);
            throw new Error(`Symbol never exported ${name}${at}`);
          }
          e = this.symbols[imported].expr!;
        } else {
          if (e.num == null) throw new Error(`Symbol not global`);
          e = this.symbols[e.num].expr!;
        }
      }
      return Exprs.evaluate(rec(e));
    });
  }

  // resolveBankBytes(expr: Expr): Expr {
  //   return Exprs.traverse(expr, (e: Expr) => {
  //     if (e.op !== '^' || e.args?.length !== 1) return e;
  //     const child = e.args[0];
  //     if (child.op !== 'off') return e;
  //     const chunk = this.chunks[child.num!];
  //     const banks = new Set<number>();
  //     for (const s of chunk.segments) {
  //       const segment = this.segments.get(s);
  //       if (segment?.bank != null) banks.add(segment.bank);
  //     }
  //     if (banks.size !== 1) return e;
  //     const [b] = banks;
  //     return {op: 'num', size: 1, num: b};
  //   });
  // }

  //     if (expr.op === 'import') {
  //       if (!expr.sym) throw new Error(`Import with no symbol.`);
  //       const sym = this.symbols[this.exports.get(expr.sym)];
  //       return this.resolveImports(sym.expr);
  //     }
  //     // TODO - this is nonsense...
  //     const args = [];
  //     let mut = false;
  //     for (let i = 0; i < expr.args; i++) {
  //       const child = expr.args[i];
  //       const resolved = this.resolveImports(child);
  //       args.push(resolved);
  //       if (child !== resolved) expr.args[i] = resolved;
  //       return 
  //     }
  //   }
  //   // TODO - add all the things
  //   return patch;
  // }

  setConfig(cfg: LinkerConfig) {
    const exported = new Set<string>();
    // Check the symbol exports here to see if any override linker weak symbols
    for (const symbol of this.symbols) {
      if (symbol.export != null) exported.add(symbol.export);
    }
    for (const segment of lowerLinkerConfig(cfg, exported)) {
      this.addRawSegment(segment);
      this.segmentOrder.push(segment.name);
    }
  }

  addRawSegment(segment: Segment) {
    let list = this.rawSegments.get(segment.name);
    if (!list) this.rawSegments.set(segment.name, list = []);
    list.push(segment);
  }

  buildExports(): Map<string, Export> {
    const map = new Map<string, Export>();
    for (const symbol of this.symbols) {
      if (!symbol.export) continue;
      const e = Exprs.traverse(symbol.expr!, (e, rec) => {
        return this.resolveLink(Exprs.evaluate(rec(e)));
      });
      if (e.op !== 'num') throw new Error(`never resolved: ${symbol.export}`);
      const value = e.num!;
      const out: Export = {value};
      if (e.meta?.offset != null && e.meta.org != null) {
        out.offset = e.meta.offset + value - e.meta.org;
      }
      if (e.meta?.bank != null) out.bank = e.meta.bank;
      map.set(symbol.export, out);
    }
    return map;
  }

  report(verbose = false): string {
    // TODO - accept a segment to filter?
    let out = '';
    for (const [s, e] of this.free) {
      out += `Free: ${s.toString(16)}..${e.toString(16)}: ${e - s} bytes\n`;
    }
    if (verbose) {
      for (const [s, c] of this.placed) {
        const name = c.name ?? `Chunk ${c.index}`;
        const end = c.offset! + c.size;
        out += `${s.toString(16).padStart(5, '0')} .. ${
            end.toString(16).padStart(5, '0')}: ${name} (${end - s} bytes)\n`;
      }
    }
    return out;
  }
}

const DEBUG = false;
const NO_THROW = false; // for overwrite
const QUIET = false; // temporary for overwrite
