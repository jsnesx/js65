
// SPDX-License-Identifier: MPL-2.0

import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import { type ErrorCollector, FatalError, RecoverableError } from './error.ts';
import type { Expr } from './expr.ts';
import * as Exprs from './expr.ts';
import { type CfgSymbols, type LinkerConfig, configSymbols, linkerDefines, lowerLinkerConfig, parseLinkerConfig, resolveCfgExpr } from './linkerconfig.ts';
import { type Assertion, type Chunk, type Module, type OverwriteMode, type PlacementMode, Segment, type Substitution, type Symbol } from './module.ts';
import { buildLinkTimeEnv, replayModules } from './latepass.ts';
import { Targets } from "./preamble.ts";
import { Preprocessor } from './preprocessor.ts';
import * as Tokens from './token.ts';
import { type SourceInfo } from './token.ts';
import { Tokenizer } from './tokenizer.ts';
import { TokenStream, SourceContents } from './tokenstream.ts';
import { type LinkerOptions } from './options.ts';
import { IntervalSet, SparseByteArray, binaryInsert, lowerBound } from './util.ts';

export type { LinkerOptions as Options };

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

const RE_COLON = /:/g;
const RE_INLINE_COMMENT = /;(.*)$/;
const RE_LABEL_ONLY_LINE = /^\s*.*:\s*$/;
const RE_FULL_COMMENT_LINE = /^\s*;/;
const RE_LABEL_OR_COMMENT_LINE = /^\s*(;|.*:\s*$)/;

export class Linker {
  opts: LinkerOptions;
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

  private _link: Link;
  private _exports?: Map<string, Export>;

  constructor(opts: LinkerOptions = {}) {
    this.opts = opts;
    this._link = new Link(opts.errorCollector, linkerDefines(opts.defines));
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
      this._link.checkAnonMode('A linker config');
      this._link.setConfig(parseLinkerConfig(this.opts.linkerConfig,
                                             this.opts.linkerConfigName));
    } else if (this.opts.target != null) {
      const target = Targets.get(this.opts.target.toLowerCase());
      if (!target) {
        this._link.fail(`Unknown target: ${this.opts.target}. Supported targets are ${
            [...Targets.keys()].join(', ')}`);
      }
      this._link.checkAnonMode(`--target ${this.opts.target}`);
      target.segments.forEach( seg => this._link.addRawSegment(seg) );
    }
    return this._link.link(signal);
  }

  report(verbose = false): string {
    return this._link.report(verbose);
  }

  outputFiles(): Array<{name: string, data: Uint8Array}> {
    return this._link.outputFiles();
  }

  exports(): Map<string, Export> {
    if (this._exports) return this._exports;
    return this._exports = this._link.buildExports();
  }

  watch(...offset: number[]) {
    this._link.watches.push(...offset);
  }

  private static getComment(sourceLines: string[], firstLine: number,
                            line: number, debugLevel: number) {
    let comment = "";

    {
      const actualLine = line;

      if (debugLevel === 0) {
        // Level 0: Only include comments, skip source code and labels
        const lines = sourceLines.slice(firstLine, actualLine + 1);
        const result: string[] = [];

        for (const l of lines) {
          const trimmed = l.trim();
          // Check if line is a full comment line
          if (RE_FULL_COMMENT_LINE.test(l)) {
            // Remove leading semicolon and colons from comments
            const commentText = trimmed.substring(1).trim().replace(RE_COLON, '');
            if (commentText) {
              result.push(commentText);
            }
          } else if (RE_LABEL_ONLY_LINE.test(l)) {
            // Label-only line - skip it (labels go in the label field, not comments)
          } else {
            // Check if line has an inline comment (code ; comment)
            const inlineCommentMatch = l.match(RE_INLINE_COMMENT);
            if (inlineCommentMatch) {
              // Remove colons from the comment (no leading semicolon)
              const commentText = inlineCommentMatch[1].trim().replace(RE_COLON, '');
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
        // Filter out label-only lines and remove colons from remaining lines
        comment = sourceLines.slice(firstLine, actualLine + 1)
          .filter((s) => !RE_LABEL_ONLY_LINE.test(s))
          .map((s) => s.trim().replace(RE_COLON, ''))
          .join('\\n');
      }
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

  /**
   * Check for an ines header in the output, if we have one, skip it.
   * Also check for a trainer and skip it too.
   */
  private prgBaseOffset(): number {
    const data = this._link.data;
    const inesMagic = [0x4e, 0x45, 0x53, 0x1a];  // "NES\x1a"
    if (inesMagic.every((b, i) => data.get(i) === b)) {
      // A trainer, if flag 6 asks for one, sits between header and PRG.
      return ((data.get(6) ?? 0) & 0x04) ? 0x210 : 0x10;
    }

    // No header in the output, so fall back to the earliest file offset of a
    // segment that runs where only ROM can, ignoring anything that doesn't
    // land in the main output file.
    let offset = Infinity;
    for (const [_, seg] of this._link.segments) {
      if (seg.isRam || (seg.out != null && seg.out !== '%O')) continue;
      if (seg.memory >= 0x4000 && seg.offset < offset) offset = seg.offset;
    }
    return offset === Infinity ? 0 : offset;
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

    // Build up a list of comments before a line as we iterate through the
    // file so we can attach the full comment to a line of code that is written
    // above the line in the source code.
    const windowStartCache = new Map<string, Int32Array>();
    const windowStarts = (file: string, lines: string[]): Int32Array => {
      let starts = windowStartCache.get(file);
      if (!starts) {
        starts = new Int32Array(lines.length + 1);
        for (let i = 1; i <= lines.length; i++) {
          starts[i] = RE_LABEL_OR_COMMENT_LINE.test(lines[i - 1]) ? starts[i - 1] : i;
        }
        windowStartCache.set(file, starts);
      }
      return starts;
    };

    const commentCache = new Map<string, Map<number, string>>();
    let cachedFile: string|undefined;
    let cachedComments: Map<number, string>|undefined;
    const commentFor = (source: SourceInfo, line: number): string => {
      if (source.file !== cachedFile) {
        cachedFile = source.file;
        cachedComments = commentCache.get(cachedFile);
        if (!cachedComments) {
          commentCache.set(cachedFile, cachedComments = new Map());
        }
      }
      let comment = cachedComments!.get(line);
      if (comment === undefined) {
        const lines = getSourceLines(source.file);
        const start = !lines || line < 0 ? -1 :
            line <= lines.length ? windowStarts(source.file, lines)[line] : line;
        comment = start < 0 ? "" :
            Linker.getComment(lines!, start, line, debugLevel);
        cachedComments!.set(line, comment);
      }
      // Level 2: Append source file location
      if (debugLevel >= 2) {
        const suffix = ` in file ${source.file}:${source.line}`;
        comment = comment ? comment + suffix : suffix.trim();
      }
      return comment;
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

    const prgBaseOffset = this.prgBaseOffset();

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

      // A symbol defined over a label (`P1_HELD = Buttons+2`) is resolved
      // before the chunk is placed, so its value is still relative to the
      // chunk. Only the chunk knows where that ended up.
      const value = chunk && meta?.rel ?
          (chunk.org ?? 0) + (s.expr.num ?? 0) : (s.expr.num ?? 0);

      if (chunk?.segment?.isRam || !chunk) {
        // For chunks that are not output to the final ROM, use a heuristic to determine address
        const result = Linker.getLabelTypeAndAddress(value);
        labelType = result.type;
        addr = result.address;
      } else {
        // For chunks that are output, use the resolved address instead
        const offsetInChunk: number = value - (chunk.org ?? 0);
        const fileOffset = (chunk.offset ?? 0) + offsetInChunk;
        addr = fileOffset - prgBaseOffset;
        labelType = "NesPrgRom";
      }

      // Generate comment from source info if available
      let comment = "";
      if (s.expr.source) {
        comment = commentFor(s.expr.source, s.expr.source.line);
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
        if (srcInfo) comment = commentFor(srcInfo, srcInfo.line - 1);

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

        const comment = commentFor(rangeSrcInfo, rangeSrcInfo.line - 1);

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
  Tokens.fail(msg);
}

function impossible(msg: string): never {
  throw new Error(msg);
}

/** User friendly string name for anon segments */
function anonSegmentLabel(name: string, memory: number): string {
  const src = Segment.anonSource(name);
  if (!src) return name;
  const at = src.line != null ? `${src.file}:${src.line}` : src.file;
  return `@${at} $${memory.toString(16)}`;
}

/** How a segment is named in an error in an error message. */
function segmentLabel(s: {name: string, memory: number}): string {
  return Segment.isAnon(s.name) ?
      `anonymous segment ${anonSegmentLabel(s.name, s.memory)}` :
      `segment ${s.name}`;
}

/** Rounds up to the next multiple of `align`, which must be positive. */
function alignUp(value: number, align: number): number {
  // NOTE: arithmetic rather than bit twiddling, since offsets in RAM segments
  // are past the 32-bit sign bit (see LinkSegment.RAM_OFFSET).
  return align > 1 ? Math.ceil(value / align) * align : value;
}

/**
 * The linker's pool of unallocated space, which answers "smallest free range
 * that fits" without walking the pool.
 *
 * Placement is best-fit-decreasing: chunks go out largest first, and each one
 * takes the smallest hole it fits in. This class extends the basic IntervalSet
 * in order to keep an index of the smallest intervals so that way when there
 * are a large number of free spaces and we are trying to set chunks in there,
 * we can reduce the number of intervals to check.
 *
 * The index only covers ranges lying wholly inside the window being searched,
 * since a range hanging off either end contributes only the part that overlaps.
 * At most two ranges can do that - one per end - so `bestFit` looks those up
 * directly and lets the index handle everything between them.
 */
export class FreeSpace extends IntervalSet {
  /** Range length -> the starts of every range with that length, sorted. */
  private readonly bySize = new Map<number, number[]>();
  /** The lengths present in `bySize`, sorted, so a query can walk upwards. */
  private readonly sizes: number[] = [];

  protected override replace(s: number, e: number, entries: Array<[number, number]>) {
    // Reindex the data in the free space whenever a free chunk size changes.
    for (let i = s; i < e; i++) {
      const [start, end] = this.data[i];
      this.unindex(start, end - start);
    }
    super.replace(s, e, entries);
    for (const [start, end] of entries)
      this.index(start, end - start);
  }

  private index(start: number, len: number) {
    let starts = this.bySize.get(len);
    if (!starts) {
      this.bySize.set(len, starts = []);
      this.sizes.splice(lowerBound(this.sizes, len), 0, len);
    }
    starts.splice(lowerBound(starts, start), 0, start);
  }

  private unindex(start: number, len: number) {
    const starts = this.bySize.get(len);
    if (!starts) return;
    const i = lowerBound(starts, start);
    if (starts[i] !== start) return;
    starts.splice(i, 1);
    if (!starts.length) {
      this.bySize.delete(len);
      this.sizes.splice(lowerBound(this.sizes, len), 1);
    }
  }

  /**
   * Similar to best fit, but we only care about getting the first available free space
   * that fits this data.
   */
  firstFit(s0: number, s1: number, size: number, align: number, delta: number): number|undefined {
    for (const [f0, f1] of this.tail(s0)) {
      // Hit the end of the segment
      if (f0 >= s1) return undefined;
      const intervalEnd = Math.min(f1, s1);
      const start = alignUp(f0 - delta, align) + delta;
      if (start + size > intervalEnd) continue;
      return start;
    }
    // Definitely doesn't fit!
    return undefined;
  }

  /**
   * Aligns and find the smallest free segment that fits the chunk
   * Check three different interval types to find the "best" match:
   * - the interval that contains the start address
   * - the smallest interval that is still in the bounds
   * - the interval that contains the end address.
   * Our goal is to fit the largest things we have into the tightest box
   * possible to leave as much room for other large blocks as possible.
   *
   * `slack` receives the size of the hole that was chosen, so a caller
   * comparing several windows can tell which one fits tightest.
   */
  bestFit(s0: number, s1: number, size: number, align: number,
          delta: number, slack?: {value: number}): number|undefined {
    let found: number|undefined;
    let smallest = Infinity;

    // helper to align and validate that this chunk fits in the interval
    const consider = (f0: number, end: number): boolean => {
      const start = alignUp(f0 - delta, align) + delta;
      if (start + size > end) return false;
      const df = end - f0;
      if (df >= smallest) return false;
      found = start;
      smallest = df;
      return true;
    };

    // The range surrounding the low end of the window, if any.
    const lo = this._find(s0);
    if (lo >= 0 && this.data[lo][0] < s0) {
      consider(s0, Math.min(this.data[lo][1], s1));
    }

    // Everything wholly inside the window, shortest length first. The first
    // length that yields a fit wins outright, since every later one is longer.
    const widest = s1 - s0;
    for (let k = lowerBound(this.sizes, size); k < this.sizes.length; k++) {
      const len = this.sizes[k];
      // Too long to fit in the window at all, or already beaten by the range
      // off the low end - and lengths only grow from here.
      if (len > widest || len >= smallest) break;
      const starts = this.bySize.get(len)!;
      let done = false;
      for (let i = lowerBound(starts, s0); i < starts.length; i++) {
        const f0 = starts[i];
        if (f0 + len > s1) break;  // runs past the window, so not inside it
        if (consider(f0, f0 + len)) { done = true; break; }
      }
      if (done) break;
    }

    // And the range straddling the high end, which comes last in address order.
    const hi = this._find(s1);
    if (hi >= 0 && this.data[hi][0] >= s0)
      consider(this.data[hi][0], s1);

    if (slack) slack.value = smallest;
    return found;
  }
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
  /** Output file the segment's bytes go to, `%O` (or unset) being the main one. */
  readonly out: string|undefined;
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

  /**
   * A segment is RAM if it emits no bytes, declared `bss`/`zp`, or
   * it has no output file and no offset specified.
   * If out is specified (any string), it outputs.
   * If offset is specified without out, it outputs to main file.
   */
  static isRamSegment(segment: Segment): boolean {
    return segment.bss ?? (!segment.out && segment.offset == null);
  }

  constructor(segment: Segment, used = 0, ramBase = LinkSegment.RAM_OFFSET) {
    const name = this.name = segment.name;
    this.bank = segment.bank ?? 0;
    this.addressing = segment.addressing ?? 2;
    this.size = segment.size ?? fail(`Size must be specified: ${name}`);
    this.isRam = LinkSegment.isRamSegment(segment);
    this.ramBase = ramBase;
    // For RAM segments, offset defaults to memory (so delta=0, org space = tracking space)
    this.offset = segment.offset ?? (this.isRam ? segment.memory ?? 0 : fail(`Offset must be specified: ${name}`));
    // this.memory = segment.memory ?? fail(`Memory must be specified: ${name}`);
    // Allow memory offset to be null for non-prg segments
    this.memory = segment.memory ?? 0;
    this.fill = segment.fill;
    this.out = segment.out;
    this.dedupe = segment.dedupe ?? false;
    this.used = used;
  }

  // offset = org + delta
  // For RAM segments, use a high bit offset to separate from ROM file offset space
  // This prevents RAM free space tracking from conflicting with ROM file offsets
  static readonly RAM_OFFSET = 0x80000000;
  /**
   * Where this segment's memory area starts in the linker's offset space.
   * Each area gets a slice of its own, since two of them may cover the same
   * addresses (banked/overlapping RAM) and must not be allocated out of the same space.
   */
  readonly ramBase: number;
  get delta(): number { return this.isRam ? this.ramBase : (this.offset - this.memory); }
}

class LinkChunk {
  readonly name: string|undefined;
  readonly size: number;
  /** Alignment (a power of two) for placing this chunk. */
  readonly align: number|undefined;
  segments: readonly string[];
  asserts: Assertion[];
  placement: PlacementMode;
  isMirrored: boolean = false;

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
  private _mirrorOffsets: Array<[LinkSegment, number]> = [];

  private readonly _overwrite: OverwriteMode;

  constructor(readonly linker: Link,
              readonly index: number,
              chunk: Chunk,
              readonly chunkOffset: number,
              readonly symbolOffset: number) {
    this.name = chunk.name;
    this.size = chunk.data.length;
    this.align = chunk.align;
    this.segments = chunk.segments;
    this.placement = chunk.placement ?? 'declarationOrder';
    this.labelIndex = chunk.labelIndex && new Map(chunk.labelIndex);
    this.sourceMap = chunk.sourceMap && new Map(chunk.sourceMap);
    this._data = chunk.data;
    for (const sub of chunk.subs || []) {
      this.subs.add(translateSub(sub, chunkOffset, symbolOffset));
    }
    this.asserts = (chunk.asserts || [])
        .map(a => ({...a, expr: translateExpr(a.expr, chunkOffset, symbolOffset)}));
    if (chunk.org != null) this._org = chunk.org;
    this._overwrite = chunk.overwrite || 'allow';
  }

  get org() { return this._org; }
  get offset() { return this._offset; }
  get segment() { return this._segment; }
  get data() { return this._data ?? impossible('no data'); }

  /**
   * Every (segment, offset) this chunk's bytes live at.
   * Regular chunks have one spot but a mirror has one per
   * segment in the list, all sharing the same `org`.
   */
  placements(): Array<[LinkSegment, number]> {
    if (this._segment == null || this._offset == null) return [];
    return [[this._segment, this._offset], ...this._mirrorOffsets];
  }

  at(): {source?: SourceInfo}|undefined {
    const source = this.sourceMap?.get(0);
    return source && {source};
  }

  /** The segments a mirror chunk replicates into, in declaration order. */
  private mirrorSegments(): LinkSegment[] {
    return this.segments.map(name => {
      const s = this.linker.segments.get(name);
      if (!s) this.linker.fail(`Unknown segment: ${name}`, this.at());
      return s;
    });
  }

  resolveMirrorOrg() {
    if (this.placement !== 'all') return;
    this.isMirrored = true;
    // `.org` mirrors are already fixed
    if (this._org != null) return;

    const linkSegs = this.mirrorSegments();
    const size = this.size;
    const align = this.align ?? 1;

    let org = Math.max(...linkSegs.map(s => s.memory + s.used));
    let settled;
    do {
      settled = org;
      for (const s of linkSegs) {
        const base = s.isRam ? s.memory + s.delta : s.offset;
        // Search from the candidate org onwards, in this segment's own space.
        const s0 = Math.max(base + s.used, org + s.delta);
        const s1 = base + s.size;
        const start = this.linker.free.firstFit(s0, s1, size, align, s.delta)
          ?? this.linker.fail(`Cannot place chunk ${this.name} mirrored across ${
              this.segments.join(' & ')}. Couldn't find a common free space ${
              ''}in all provided banks.`, this.at());
        // Back into org space, max to make sure we never move backwards.
        org = Math.max(org, start - s.delta);
      }
    } while (settled !== org);
    this._org = org;
  }

  fixedPlacements() {
    // Invariant: exactly one of (data) or (org, _offset, _segment) is present.
    // If (org, ...) filled in then we use linker.data instead.
    // We don't call this in the ctor because it depends on all the segments
    // being loaded, but it's the first thing we do in link().

    // This is called twice at the start, once for the user placed `.org` segments
    // and then once again after we've settled an `.org` for the mirrored chunks
    if (this._org == null || !this._data) return;
    if (this.placement === 'all') return this.mirrorPlacement();
    const eligibleSegments: LinkSegment[] = [];
    for (const name of this.segments) {
      const s = this.linker.segments.get(name);
      if (!s) this.linker.fail(`Unknown segment: ${name}`, this.at());
      if (this._org >= s.memory && this._org < s.memory + s.size) {
        eligibleSegments.push(s);
      }
    }
    if (eligibleSegments.length !== 1) {
      // If the user is in an anon segment but then `.org`s outside of that range
      if (!eligibleSegments.length && this.segments.length === 1 &&
          Segment.isAnon(this.segments[0])) {
        const s = this.linker.segments.get(this.segments[0])!;
        this.linker.fail(`.org $${this._org.toString(16)} is outside the ${''
            }anonymous segment ${anonSegmentLabel(s.name, s.memory)} ${''
            }(size $${s.size.toString(16)})`, this.at());
      }
      this.linker.fail(`Non-unique segment for ${this.name}:\n${''
          }Segments: ${this.segments.join(',')}, ${''
          }org: $${this.org?.toString(16)}, ${''
          }offset: $${this.offset?.toString(16)}\n${''
          }Eligible: [${eligibleSegments}]`, this.at());
    }
    const segment = eligibleSegments[0];
    // The org is inside the segment, but check that the data it carries
    // still ends inside it.
    if (this._org + this.size > segment.memory + segment.size) {
      this.linker.fail(`Chunk ($${this.size.toString(16)} bytes at $${
          this._org.toString(16)}) does not fit in ${''
          }${segmentLabel(segment)} (size $${segment.size.toString(16)})`,
                       this.at());
    }
    this.place(this._org, segment, this._overwrite);
  }

  private mirrorPlacement() {
    const segments = this.mirrorSegments();
    const org = this._org!;
    const bad = segments.filter(
        s => org < s.memory || org + this.size > s.memory + s.size);
    if (bad.length) {
      this.linker.fail(`Chunk ($${this.size.toString(16)} bytes at $${
          org.toString(16)}) mirrored across ${
          this.segments.join(' & ')} does not fit in ${
          bad.map(s => segmentLabel(s)).join(', ')}`, this.at());
    }
    this.place(org, segments[0], this._overwrite, segments.slice(1));
  }

  // NOTE: overwrite is only passed for direct placements!
  place(org: number, segment: LinkSegment, overwrite?: OverwriteMode,
        mirrors: readonly LinkSegment[] = []) {
    this._org = org;
    this._segment = segment;
    this._offset = org + segment.delta;
    this._mirrorOffsets = mirrors.map(s => [s, org + s.delta]);

    const data = this._data ?? impossible(`No data`);
    this._data = undefined;
    // placements returns a list of segments + mirrors to write to
    for (const [seg, offset] of this.placements()) {
      this.writeSegment(org, seg, offset, data, overwrite);
    }

    // Retry the follow-ons
    for (const [sub, chunk] of this.follow) {
      chunk.resolveSub(sub, false);
    }
  }

  /** The per-segment half of `place`: bytes, free space and overwrite checks. */
  private writeSegment(org: number, segment: LinkSegment, offset: number,
                       data: Uint8Array, overwrite?: OverwriteMode) {
    for (const w of this.linker.watches) {
      if (w >= offset && w < offset + this.size)
        fail("Unable to place");
    }
    binaryInsert(this.linker.placed, x => x[0], [offset, this]);

    // For RAM segments, skip data manipulation but still track free space
    if (segment.isRam) {
      this.linker.free.delete(offset, offset + this.size);
      return;
    }

    // Copy data, leaving out any holes
    const full = this.linker.data;

    if (this.subs.size) {
      full.splice(offset, data.length);
      const sparse = new SparseByteArray();
      sparse.set(0, data);
      for (const sub of this.subs) {
        sparse.splice(sub.offset, sub.size);
      }
      for (const [start, chunk] of sparse.chunks()) {
        full.set(offset + start, chunk);
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
    // Run this before resolving the follow up chunks so it properly reserves
    // the following space even if this chunk failed to place.
    this.linker.free.delete(offset, offset + this.size);
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
      const bankOp = p?.op === '^' || p?.op === '.bankbyte';
      if (initial && bankOp && p!.args!.length === 1 && e.meta) {
        const target = e.meta.chunk != null ?
            this.linker.chunks[e.meta.chunk] : undefined;
        if (target?.isMirrored) {
          // `p` is `^`/`.bank` and `e` is the operand for the label's source
          this.linker.errorCollector?.add(
              'warning', `.bank value is 0 for mirrored data`,
              p!.source ?? e.source ?? sub.expr.source);
          e.meta.bank = 0;
        }
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
      this.writeValue(sub.offset, sub.expr.num!, sub.size, sub.expr.meta?.branch,
                      sub.expr.source, sub.forceRange);
      del = true;
    } else if (sub.expr.op === '.move') {
      if (sub.expr.args!.length !== 1) throw new Error(`bad .move`);
      const child = sub.expr.args![0];
      if (child.op === 'num' && child.meta?.offset != null) {
        const delta =
            child.meta!.offset! - (child.meta!.rel ? 0 : child.meta!.org!);
        const start = child.num! + delta;
        this.writeBytes(sub.offset, this.linker.orig.slice(start, start + sub.size));
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
      // A mirror resolves its subs once but has to patch every copy.
      for (const [, base] of this.placements()) {
        this.linker.data.set(base + offset, bytes);
      }
    } else {
      throw new Error(`Impossible`);
    }
  }

  writeValue(offset: number, val: number, size: number, isBranch?: boolean,
             source?: SourceInfo, forceRange?: boolean) {
    // `force_range` says to truncate whatever we're given, which the masking
    // loop at the bottom already does, so the feature is just a skipped check.
    if (!forceRange && val != null && !Exprs.fits(val, size, isBranch)) {
      this.linker.fail(
          Exprs.rangeErrorMessage(val, size, isBranch,
                                  ` at $${(this.org! + offset).toString(16)}`),
          source && {source});
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
  if (e.meta?.chunk != null)
    e.meta.chunk += dc;
  if (e.op === 'sym' && e.num != null)
    e.num += ds;
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
  free = new FreeSpace();
  rawSegments = new Map<string, Segment[]>();
  segments = new Map<string, LinkSegment>();

  /**
   * Names of the segments in the order they are filled.
   * This comes from first, the order they appear in the ld65 linker script,
   * and then second the order they appear in object files (parsed in the
   * order they are passed into the link command)
   */
  segmentOrder: string[] = [];
  // Order that modules are passed into the link command.
  private rawModules: Module[] = [];
  /** Linker ordering for anon segments. Ordered by files passed in, then top to bottom of each file. */
  private anonDeclarationOrder: string[] = [];
  /** True once any named (non-anonymous) segment has been registered. */
  private hasNamedSegment = false;
  private segmentIndex = new Map<string, number>();
  /** Segment name -> representative of its overlap group. Built on first use. */
  private overlapGroups: Map<string, string>|undefined;
  /** Names of mapped segments that other unmapped segments are written to. */
  private segmentMappings = new Set<string>();
  /** Track the `used` values for each mapped segment */
  private segmentUsed = new Map<string, number>();
  /** Org ranges of each mapped segment that placement may still use. */
  private segmentFree = new Map<string, Array<readonly [number, number]>>();
  /**
   * Address a lowered segment loads at, in its load mapping's address space.
   * Only differs from the segment's own `memory` when load != run.
   */
  private segmentLoad = new Map<string, number>();
  /** Bytes accounted for in each segment once its geometry was fixed. */
  private segmentExtent = new Map<string, number>();
  /** Effective alignment of each segment's start, for the map file. */
  private segmentAlign = new Map<string, number>();
  /** Internal offset base for each output file. The main file is always 0. */
  private fileBases = new Map<string, number>([['%O', 0]]);
  /** Internal offset base for each RAM memory area. */
  private ramBases = new Map<string, number>();
  /** Maps RAM SEGMENTs to the underlying MEMORY area */
  private segmentArea = new Map<string, string>();
  /** Bytes written to each output file, keyed the same way as `fileBases`. */
  private outputs = new Map<string, SparseByteArray>();
  /** The ld65 config in use, kept around for its SYMBOLS block. */
  private config?: LinkerConfig;
  /** ld65 cfg file declared segments, segments are forced free if they came from here */
  private configSegments = new Set<string>();
  /** Symbols the object files export, captured when the config was set. */
  private objectExports: ReadonlySet<string> = new Set();
  /** Stores information about the modules for the latepass if we need to replace data */
  private moduleRanges: Array<{
    chunkStart: number; chunkCount: number;
    symbolStart: number; symbolCount: number;
    debugStart: number; debugCount: number;
  }> = [];

  watches: number[] = []; // debugging aid: offsets to watch.
  placed: Array<[number, LinkChunk]> = [];
  initialReport = '';

  /** Imports already reported missing, so each is named once per run. */
  private missingImports = new Set<string>();

  constructor(readonly errorCollector?: ErrorCollector,
              /** `-D` overrides for config `SYMBOLS`, already reduced to numbers. */
              private readonly defines: CfgSymbols = new Map()) {}

  fail(msg: string, at?: {source?: SourceInfo}): never {
    if (!this.errorCollector) Tokens.fail(msg, at);
    this.errorCollector.add('error', msg, at?.source);
    throw new RecoverableError(msg, at?.source);
  }

  private collect<T>(items: Iterable<T>, fn: (item: T) => void,
                     onError?: (item: T) => void): void {
    for (const item of items) {
      try {
        fn(item);
      } catch (err) {
        if (err instanceof FatalError || !this.errorCollector)
          throw err;
        if (err instanceof Tokens.SourceError) {
          if (!err.recorded) this.errorCollector.addFromException(err);
          onError?.(item);
          continue;
        }
        throw err; // rethrow fatal errors
      }
    }
  }

  private stopIfFailed(what: string): void {
    if (!this.errorCollector?.hasErrors()) return;
    const message = `cannot continue linking, ${what}`;
    this.errorCollector.add('info', message);
    const err = new FatalError(message);
    err.recorded = true;
    throw err;
  }

  private errorCount(): number {
    return this.errorCollector?.getMessages()
        .filter(m => m.level === 'error').length ?? 0;
  }

  base(data: Uint8Array, offset = 0) {
    this.data.set(offset, data);
    this.orig.set(offset, data);
  }

  // Flattens one module's segments/chunks/symbols into the global arrays.
  private loadModuleInto(file: Module) {
    const dc = this.chunks.length;
    const ds = this.symbols.length;
    const dd = this.debugSymbols?.length ?? 0;
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
    this.moduleRanges.push({
      chunkStart: dc, chunkCount: file.chunks?.length ?? 0,
      symbolStart: ds, symbolCount: file.symbols?.length ?? 0,
      debugStart: dd, debugCount: file.debugSymbols?.length ?? 0,
    });
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

  readFile(file: Module) {
    this.loadModuleInto(file);
    this.rawModules.push(file);
  }

  // Reloads every module from scratch for after a replay changes things.
  private rebuildFromModules(): void {
    this.chunks = [];
    this.symbols = [];
    this.debugSymbols = undefined;
    this.rawSegments = new Map();
    this.moduleRanges = [];
    // `setConfig` only runs once, so its segments (declared in a linker.cfg
    // rather than an inline `.segment` attr) need to be re-seeded here or
    // they vanish from `rawSegments` on every replay.
    if (this.config) {
      for (const segment of lowerLinkerConfig(this.config, this.objectExports, this.defines)) {
        this.addRawSegment(segment);
      }
    }
    for (const file of this.rawModules) {
      this.loadModuleInto(file);
    }
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
        if (chunk.isMirrored) {
          meta2.bank = 0;
        }
        expr = Exprs.evaluate({...expr, meta: {...meta, ...meta2}});
      }
    }
    return expr;
  }

  // NOTE: so far this is only used for asserts?
  // It basically copy-pastes from resolveSubs... :-(

  resolveExprOrNull(expr: Expr): number|null {
    expr = Exprs.traverse(expr, (e, rec) => {
      return this.resolveLink(Exprs.evaluate(rec(e)));
    });

    if (expr.op === 'num' && !expr.meta?.rel) return expr.num!;
    return null;
  }

  private checkAssert(a: Assertion): void {
    const source = a.expr.source;
    const val = this.resolveExprOrNull(a.expr);
    if (val == null) {
      this.errorCollector?.add('warning', `Cannot evaluate assertion`, source);
      return;
    }
    if (val) return;
    const pc = a.pc != null ? ` (PC=$${a.pc.toString(16)})` : '';
    const msg = `${a.message ?? 'Assertion failed'}${pc}`;
    const soft = a.action === 'warning' || a.action === 'ldwarning';
    // No collector means fail() throws, which is the only way to report here.
    if (!this.errorCollector) {
      if (!soft) this.fail(msg, a.expr);
      return;
    }
    this.errorCollector.add(soft ? 'warning' : 'error', msg, source);
  }

  link(signal?: { readonly aborted: boolean }): SparseByteArray {
    // Catch a cross-module named/anon mix before any state is half-built.
    this.checkAnonMode();
    // Preserve the order that the segments are declared
    for (const name of [...this.segmentOrder, ...this.rawSegments.keys()]) {
      if (this.segmentIndex.has(name)) continue;
      this.segmentIndex.set(name, this.segmentIndex.size);
    }
    this.segmentOrder = [...this.segmentIndex.keys()];
    // Bail out early if we find any segment references that weren't defined.
    const unknownSegments = new Set<string>();
    this.collect(this.chunks, chunk => {
      const name = chunk.segments.find(
          s => !this.rawSegments.has(s) && !unknownSegments.has(s));
      if (name == null) return;
      unknownSegments.add(name);
      this.fail(`Unknown segment: ${name}`, chunk.at());
    });
    // Merge all segments (mapped and unmapped) into a single Segment each.
    const merged = new Map<string, Segment>();
    this.mergeSegments(merged);
    // Composite segments are aliases and not real segments, we expand them here
    // now that we should have all of the segments known.
    this.expandComposites(merged);
    this.stopIfFailed('the segment lists are not valid');
    // Resolve unmapped segments and hand out file offsets, so that everything
    // below sees plain memory/offset/size.
    this.lowerSegments(merged);

    // Run the late asm pass and if it changes something, we need to relower
    // the segments to lay them out tighter if the size changed.
    if (this.lateAssemblyPass(merged, signal)) {
      this.stopIfFailed('the late assembly pass failed');
      this.lowerSegments(merged);
    }

    // Build up the LinkSegment objects
    this.collect(merged, ([name, s]) => {
      const ramBase = LinkSegment.isRamSegment(s) ?
          this.ramBase(this.segmentArea.get(name) ?? name) : 0;
      this.segments.set(
          name, new LinkSegment(s, this.segmentUsed.get(name), ramBase));
    });
    // Everything below needs valid geometry, so stop here if we haven't got it.
    this.stopIfFailed('the segment layout is not valid');
    // Add the free space
    for (const [name, s] of this.segments) {
      // A segment's bytes are only up for grabs where the source said so, with
      // `.free` or a `:fill` (which the assembler turns into a whole-segment
      // `.free`). Anything else may well be a ROM this build is patching, so
      // the linker must not hand out bytes nobody claimed.
      const explicit = this.explicitFree(name);
      if (explicit.length) {
        for (const [start, end] of explicit) {
          if (end <= start) continue;
          this.free.add(start + s.delta, end + s.delta);
          // Only an explicitly declared free range takes its bytes out of the
          // base image - a synthesized one would wipe out the very bytes a
          // patch build searches for.
          this.data.splice(start + s.delta, end - start);
        }
      } else if (s.size > 0 &&
                 (s.isRam || s.fill != null || this.configSegments.has(name))) {
        // A segment is free in its entirety when nothing of the image is at
        // stake: a `:fill` overwrites whatever was there, a config lays out a
        // ROM from nothing, and RAM holds no bytes of the image at all. The
        // exception is that a mapped segment only owns what it did not hand
        // out to the segments lowered into it. lowerSegments works out which
        // parts of it those are.
        const ranges = this.segmentFree.get(name) ??
            [[s.memory, s.memory + s.size] as const];
        for (const [start, end] of ranges) {
          if (end > start) this.free.add(start + s.delta, end + s.delta);
        }
      }
    }
    // Set up all the initial placements of data that is at a specific org already.
    this.collect(this.chunks, chunk => chunk.fixedPlacements());
    // Then settle a shared org for the mirrored chunks, which needs the fixed
    // data placed first so it only considers space that is really free.
    this.collect(this.chunks, chunk => chunk.resolveMirrorOrg());
    // and place all the mirrored chunks AFTER placing the regular fixed data
    this.collect(this.chunks, chunk => chunk.fixedPlacements());
    if (DEBUG) {
      this.initialReport = `Initial:\n${this.report(true)}`;
    }
    // Find all the exports.
    this.collect(this.symbols.keys(), i => {
      const symbol = this.symbols[i];
      // TODO - we'd really like to identify this earlier if at all possible!
      if (!symbol.expr) this.fail(`Symbol ${i} never resolved`);
      // look for imports/exports
      if (symbol.export != null) {
        this.exports.set(symbol.export, i);
      }
    });
    // Publish the linker's own symbols here: geometry is final, the object
    // files' exports are all registered, and nothing has been resolved yet, so
    // a forward reference into a later segment's defines just works.
    this.defineConfigSymbols(this.defineSegmentSymbols(merged));
    // Resolve all the imports in all symbol and chunk.subs exprs. This is where
    // a missing `.import` shows up, so batching here is what lets one run name
    // every symbol
    this.collect(this.symbols, symbol => {
      symbol.expr = this.resolveSymbols(symbol.expr!);
    });
    for (const chunk of this.chunks) {
      this.collect([...chunk.subs, ...chunk.selfSubs], sub => {
        sub.expr = this.resolveSymbols(sub.expr);
      });
      this.collect(chunk.asserts, a => {
        a.expr = this.resolveSymbols(a.expr);
      });
    }

    this.stopIfFailed('some symbols could not be resolved');

    // At this point, we don't care about this.symbols at all anymore.
    // Now figure out the full dependency tree: chunk #X requires chunk #Y
    this.collect(this.chunks, c => c.resolveSubs(true));

    // Resolve everything that can be resolved without knowing where the
    // relocatable chunks will land.
    this.collect(this.chunks, chunk => chunk.resolveSubs());

    // Now place them. Segments are filled by declaration order first,
    // and within the segment sorted so they are filled as follows:
    // - first, the number of segments it can land in (so chunks restricted
    //   to only 1 bank fill before chunks that can spill to multiple banks).
    // - second, from largest to smallest in that group.
    // - third, in case of a tie on all of the above, just use chunk index.
    // Anything that still depends on a different segment can be resolved later.
    // If a segment is part of a pool though, we want to fill the best fit across
    // the pool instead of in a single segment
    const candidates = new Map<string, LinkChunk[]>();
    const eligibleCount = new Map<LinkChunk, number>();
    for (const chunk of this.chunks) {
      if (chunk.org != null) continue;  // already placed by fixedPlacement
      const eligible = this.eligibleSegments(chunk);
      const [first] = eligible;
      if (first == null) continue;      // no segment at all: reported below
      eligibleCount.set(chunk, eligible.length);
      const key = this.overlapGroup(first);
      let list = candidates.get(key);
      if (!list) candidates.set(key, list = []);
      list.push(chunk);
    }
    const errorsBeforePlacement = this.errorCount();
    for (const name of this.segmentOrder) {
      const list = candidates.get(name);
      if (!list) continue;
      list.sort((a, b) => eligibleCount.get(a)! - eligibleCount.get(b)! ||
                 b.size - a.size || a.index - b.index);
      this.collect(list, chunk => {
        if (signal?.aborted) throw new FatalError('Compilation cancelled');
        chunk.resolveSubs();
        this.placeChunk(chunk);
      });
    }
    // Anything eligible for no segment at all never got a chance above, so
    // let placeChunk report it.
    this.collect(this.chunks, chunk => {
      if (chunk.org != null || this.eligibleSegments(chunk).length) return;
      this.placeChunk(chunk);
    });
    if (this.errorCount() > errorsBeforePlacement + 1) {
      this.errorCollector!.add('info', `a chunk that could not be placed leaves ${
          ''}its space free, which may lead to spurious error reports`);
    }


    // At this point, everything should be placed, so do one last resolve.
    // Each output file collects its own bytes, at offsets relative to itself
    // rather than the internal space the linker placed them in.
    const patch = this.output('%O');
    // Before placing the data, add the fill bytes to segments with fill
    for (const [_name, seg] of this.segments) {
      if (seg.isRam) continue;  // RAM segments don't need fill
      if (seg.fill != null) {  // NOTE: fill = 0 still fills.
        const buf = new Uint8Array(new ArrayBuffer(seg.size));
        buf.fill(seg.fill);
        this.output(seg.out).set(seg.offset - this.fileBase(seg.out || '%O'),
                                 buf);
      }
    }
    for (const c of this.chunks) {
      this.collect(c.asserts, a => this.checkAssert(a));
    }
    this.stopIfFailed('the module did not link cleanly');
    for (const c of this.chunks) {
      if (c.overlaps) continue;
      // At this point, all segments should have been validated, and if the offset
      // isn't known now this is a compiler bug that should be reported.
      if (c.offset == null) {
        impossible(`Chunk ${c.name ?? c.index} was never placed`);
      }
      // A mirror wrote its bytes into every listed segment, each of which may
      // be a different output file.
      for (const [segment, offset] of c.placements()) {
        if (segment.isRam) continue;  // RAM chunks not in output
        const base = this.fileBase(segment.out || '%O');
        this.output(segment.out).set(
            offset - base, this.data.slice(offset, offset + c.size!));
      }
    }
    if (DEBUG) console.log(this.report(true));
    return patch;
  }

  /** Merges each raw segment's pieces into one `Segment`, into `target`. */
  private mergeSegments(target: Map<string, Segment>): void {
    target.clear();
    for (const [name, segments] of this.rawSegments) {
      let s = {...segments[0]};
      for (let i = 1; i < segments.length; i++) {
        s = Segment.merge(s, segments[i]);
      }
      target.set(name, s);
    }
  }

  /** Replays modules whose late-assembly guesses disagree with `linkEnv`. */
  private lateAssemblyPass(merged: Map<string, Segment>,
                            signal?: {readonly aborted: boolean}): boolean {
    if (!this.rawModules.some(m => m.lateAssembly?.sizeQueries.length ||
                                    m.lateAssembly?.condQueries.length)) return false;
    const linkEnv = buildLinkTimeEnv(this.rawModules, merged);
    const noMessages = this.rawModules.map(() => []);
    const replayed = replayModules(this.rawModules, noMessages, linkEnv, signal,
                                   {errorLimit: this.errorCollector?.limit});
    if (this.errorCollector) this.errorCollector.merge(replayed.messages);
    let didReplace = false;
    for (let i = 0; i < this.rawModules.length; i++) {
      const module = replayed.modules[i];
      if (module === this.rawModules[i]) continue;
      this.rawModules[i] = module;
      didReplace = true;
    }
    if (!didReplace) return false;
    // Chunk/symbol sizes may have changed, so reflatten everything.
    this.rebuildFromModules();
    this.mergeSegments(merged);
    this.expandComposites(merged);
    return true;
  }

  /**
   * Replaces any mirror/pool composite segments into the appropriate list of segments,
   * with the right attributes for placement.
   */
  private expandComposites(merged: Map<string, Segment>) {
    const referenced = new Set(this.chunks.flatMap(c => [...c.segments]));
    /** Every alias name including the optional ones. */
    const declared = new Set<string>();
    const composites = new Map<string, {
      members: readonly string[],
      placement: PlacementMode,
      at?: {source?: SourceInfo},
    }>();
    // Remove all composite segments from the final list and build out the composite list
    for (const [name, seg] of merged) {
      const members = seg.mirror ?? seg.pool;
      if (!members) continue;
      merged.delete(name);
      declared.add(name);
      if (seg.optional && !referenced.has(name)) continue;
      const at = this.segmentSource(name);
      composites.set(name, {
        members,
        placement: (seg.mirror ? 'all' : 'any') as PlacementMode,
        ...(at ? {at} : {}),
      });
    }
    if (!declared.size) return;
    // Members are resolved after every composite is known, so that the error for
    // a nested composite can tell it apart from a plain unknown segment.
    this.collect(composites, ([name, {members, at}]) => {
      for (const member of members) {
        if (composites.has(member)) {
          this.fail(`Segment ${name} lists ${member}, which is itself a ${
              ''}segment list. Nesting is not supported`, at);
        }
        if (!merged.has(member)) {
          this.fail(`Segment ${name} lists unknown segment ${member}`, at);
        }
      }
    });
    // Update all of the chunks that reference a composite segment to
    // use the list of `segments` and the correct placement too.
    this.collect(this.chunks, chunk => {
      const named = chunk.segments.filter(s => composites.has(s));
      if (!named.length) return;
      if (chunk.segments.length > 1) {
        this.fail(`Segment list ${named.join(', ')} cannot be combined with ${
            ''}other segments: ${chunk.segments.join(', ')}`, chunk.at());
      }
      const composite = composites.get(named[0])!;
      chunk.segments = composite.members;
      chunk.placement = composite.placement;
    });
    // from here on a composite name is not a segment anyone can place into.
    this.segmentOrder = this.segmentOrder.filter(n => !declared.has(n));
    for (const name of declared) {
      this.segmentIndex.delete(name);
      this.rawSegments.delete(name);
    }
  }

  private segmentSource(name: string): {source?: SourceInfo}|undefined {
    for (const chunk of this.chunks) {
      if (chunk.segments.includes(name)) return chunk.at();
    }
    return undefined;
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

    /** Get a rough estimate for the size of the output */
    const measure = (chunks: readonly LinkChunk[]): number => {
      let cursor = 0;
      const bySize =
          [...chunks].sort((a, b) => b.size - a.size || a.index - b.index);
      for (const c of bySize) {
        if (c.org != null) continue;
        cursor = alignUp(cursor, c.align ?? 1) + c.size;
      }
      return cursor;
    };

    // Phase 1: measure each unmapped segment against its contents.
    // Sizing isn't dependant on final org, its just using the relative size
    // of the chunks in it.
    const sizes = new Map<string, number>();
    const aligns = new Map<string, number>();
    /** Mapped segment -> room its own chunks need, when it holds any. */
    const selfSizes = new Map<string, number>();
    const unmapped: Segment[] = [];

    const drop = (name: string) => {
      merged.delete(name);
      const i = unmapped.findIndex(s => s.name === name);
      if (i >= 0) unmapped.splice(i, 1);
    };
    this.collect(order, name => {
      const seg = merged.get(name)!;
      if (!needsLowering(seg)) return;
      const chunks = contents.get(name) ?? [];
      if (seg.optional && !referenced.has(name)) {
        merged.delete(name);
        return;
      }
      unmapped.push(seg);
      // Enforcing the widest chunk alignment on the segment start is what
      // makes a segment-relative chunk alignment equal an absolute one.
      let align = seg.align ?? 1;
      for (const c of chunks) align = Math.max(align, c.align ?? 1);
      aligns.set(name, align);
      this.segmentAlign.set(name, align);
      let size = seg.size ?? measure(chunks);
      for (const c of chunks) {
        if (c.org == null) continue;
        if (seg.memory == null) {
          this.fail(`Segment ${name} holds a .org chunk${
              c.name ? ` (${c.name})` : ''} but has no address of its own. ${''
              }.org can only be used in segments with :mem`, c.at());
        }
        size = Math.max(size, c.org + c.size - seg.memory);
      }
      sizes.set(name, size);
    }, drop);

    // Now do the same measurement for the chunks that are in a mapped segment itself,
    // which is the room it has to be given before the next segment lowered into it.
    for (const name of order) {
      const seg = merged.get(name);
      if (!seg || needsLowering(seg)) continue;
      let align = seg.align ?? 1;
      const own = contents.get(name) ?? [];
      for (const c of own) align = Math.max(align, c.align ?? 1);
      this.segmentAlign.set(name, align);
      const size = measure(own);
      if (size) selfSizes.set(name, size);
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
        this.fail(`Segment ${seg.name} has ${which} "${name}", which is not a segment`);
      }
      if (needsLowering(mapped)) {
        this.fail(`Segment ${seg.name} has ${which} "${name}", which is already mapped to memory`);
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
        this.fail(`Segment ${seg.name} ($${size.toString(16)} bytes at $${
             start.toString(16)}) does not fit in ${mapped.name}`);
      }
      used.set(mapped.name,
               Math.max(used.get(mapped.name) ?? 0, start + size - base));
      return start;
    };
    
    // Build out the new mappings for the unmapped segments, tracking the total
    // size of data needed in the other segment, and also keep track of where the
    // load/run addresses end up at. A mapped segment that holds chunks of its
    // own takes its turn here too, rather than being left whatever the segments
    // lowered into it did not use.
    const selfStarts = new Map<string, number>();
    // Mapped segments that other segments are lowered into.
    const backing = new Set<string>(
        unmapped.flatMap(s => [s.load, s.run].filter(n => n != null)));
    this.collect(this.allocationOrder(order), name => {
      const seg = merged.get(name);
      if (!seg) return;
      if (!needsLowering(seg)) {
        // Only worth reserving in a segment that is sharing its space.
        const size = selfSizes.get(name);
        const align = this.segmentAlign.get(name) ?? 1;
        if (!size || !backing.has(name)) return;
        const base = seg.memory ?? 0;
        const start = alignUp(base + (used.get(name) ?? 0), align);
        const room = base + (seg.size ?? 0) - start;
        if (room <= 0) return;
        selfStarts.set(name, allocate(seg, seg, Math.min(size, room), align));
        return;
      }
      const size = sizes.get(seg.name)!;
      const align = aligns.get(seg.name)!;
      const runSeg = mappingOf(seg, 'run');
      const loadSeg = mappingOf(seg, 'load');
      // if the segment we are mapping into has free space declared, then
      // treat it like we are in patching mode, and give the load segment
      // the full memory space and let the free space handler place it later.
      if (seg.memory == null && seg.size == null && seg.align == null &&
          seg.alignLoad == null &&
          this.isPatched(runSeg) && this.isPatched(loadSeg)) {
        sizes.set(seg.name, Math.min(runSeg.size ?? 0, loadSeg.size ?? 0));
        runs.set(seg.name, runSeg.memory ?? 0);
        loads.set(seg.name, loadSeg.memory ?? 0);
        this.segmentLoad.set(seg.name, loadSeg.memory ?? 0);
        this.segmentExtent.set(seg.name, size);
        return;
      }
      // An explicit :mem places the run address instead of allocating one.
      const run = allocate(seg, runSeg, size, align, seg.memory);
      const load = loadSeg === runSeg ?
          run : allocate(seg, loadSeg, size, seg.alignLoad ?? align);
      runs.set(seg.name, run);
      loads.set(seg.name, load);
      this.segmentLoad.set(seg.name, load);
      this.segmentExtent.set(seg.name, size);
    }, drop);

    // Build out a map of how far into each segment we've gotten so far
    for (const name of order) {
      const seg = merged.get(name);
      if (!seg || needsLowering(seg)) continue;
      let extent = used.get(name) ?? 0;
      for (const c of contents.get(name) ?? []) {
        if (c.org == null) continue;
        extent = Math.max(extent, c.org + c.size - (seg.memory ?? 0));
      }
      this.segmentExtent.set(name, Math.min(extent, seg.size ?? extent));
    }

    // Now start building out the file offsets `:off` that we will give to unmapped segments.
    // Map of file out name -> next start addr as an offset into the segment (or :size if its :fill)
    const fileLocations = new Map<string, number>();
    for (const name of order) {
      const seg = merged.get(name);
      // Skip over unmapped segments here.
      if (!seg || needsLowering(seg) || seg.bss) continue;
      // Skip things that aren't getting written out to the file.
      // Anon segments ARE written to file, and will get :out assigned after this.
      if (!Segment.isAnon(seg) && seg.out == null && seg.offset == null) continue;
      const file = seg.out || '%O';
      const base = this.fileBase(file);
      let cursor = fileLocations.get(file) ?? 0;
      // An explicit `:off` is relative to the file it writes to, and puts the
      // cursor there. Everything downstream sees the internal offset instead,
      // which is the file's own base plus that.
      if (seg.offset != null) cursor = seg.offset;
      seg.offset = base + cursor;
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
    this.collect([...unmapped], seg => {
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
      // A lowered RAM segment shares its space with everything else that runs
      // in the same area, and with nothing outside it.
      this.segmentArea.set(seg.name, runSeg.name);
    }, seg => drop(seg.name));

    // Finally, work out what part of each mapped segment is still up for grabs.
    for (const name of order) {
      const seg = merged.get(name);
      if (!seg || needsLowering(seg)) continue;
      const memory = seg.memory ?? 0;
      const size = seg.size ?? 0;
      if (!this.segmentMappings.has(name)) {
        this.segmentFree.set(name, [[memory, memory + size]]);
        continue;
      }
      const ranges: Array<readonly [number, number]> = [];
      const self = selfStarts.get(name);
      if (self != null) {
        ranges.push([self, self + selfSizes.get(name)!]);
        // Chunks are placed from `used` forward, so that is where its own
        // space starts as far as the placer is concerned.
        this.segmentUsed.set(name, self - memory);
      } else {
        this.segmentUsed.set(name, used.get(name) ?? 0);
      }
      ranges.push([memory + (used.get(name) ?? 0), memory + size]);
      this.segmentFree.set(name, ranges);
    }
  }

  /** The ranges a segment's own declarations claimed as free, if any. */
  private explicitFree(name: string): number[][] {
    return (this.rawSegments.get(name) ?? []).flatMap(seg => seg.free ?? []);
  }

  /**
   * Best effort guess to see if this segment is patching an existing segment.
   * If there's free ranges that don't cover the full segment, then its likely
   * patching a rom instead.
   */
  private isPatched(seg: Segment): boolean {
    const ranges = this.explicitFree(seg.name)
        .filter(([start, end]) => end > start)
        .sort((a, b) => a[0] - b[0]);
    if (!ranges.length) return false;
    let covered = seg.memory ?? 0;
    for (const [start, end] of ranges) {
      if (start > covered) return true;
      covered = Math.max(covered, end);
    }
    return covered < (seg.memory ?? 0) + (seg.size ?? 0);
  }

  /**
   * The order segments are given room in the mapped segments they share.
   * A linker config declares its MEMORY areas and its SEGMENTS separately, and
   * it is the SEGMENTS order that decides who gets the front of an area - even
   * for an entry merged into the area of the same name, whose place in
   * `segmentOrder` is the area's (that order writes the output files).
   */
  private allocationOrder(order: readonly string[]): readonly string[] {
    if (!this.config) return order;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of [...this.config.segments.map(s => s.name), ...order]) {
      if (seen.has(name) || !order.includes(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }

  /**
   * Base of an output file in the linker's internal offset space.
   *
   * Every file's own offsets start at zero, but chunks, free space and the
   * base image all share one address space here, so each extra file is handed
   * a slice of its own well above anything a real ROM reaches. The main file
   * keeps base 0 so a patch build's offsets stay the file offsets it read.
   */
  private fileBase(file: string): number {
    let base = this.fileBases.get(file);
    if (base == null) {
      base = Link.FILE_SPACE * this.fileBases.size;
      if (base >= LinkSegment.RAM_OFFSET) impossible(`Too many output files`);
      this.fileBases.set(file, base);
    }
    return base;
  }

  private static readonly FILE_SPACE = 0x1000000;

  /**
   * Base of a RAM area in the linker's internal offset space.
   * To support banked or overlapping ram, we give each ram segment mapped into memory
   * its own base so we can assign address that overlap easier.
   */
  private ramBase(area: string): number {
    let base = this.ramBases.get(area);
    if (base == null) {
      base = LinkSegment.RAM_OFFSET + Link.RAM_SPACE * this.ramBases.size;
      this.ramBases.set(area, base);
    }
    return base;
  }

  private static readonly RAM_SPACE = 0x10000;

  /** The bytes written to one output file, `undefined` meaning the main one. */
  private output(file: string|undefined): SparseByteArray {
    const name = file || '%O';
    let out = this.outputs.get(name);
    if (!out) this.outputs.set(name, out = new SparseByteArray());
    return out;
  }

  /**
   * Everything a `file =`/`:out` sent somewhere other than the main output,
   * which `link()` returns. Only meaningful after `link()`.
   */
  outputFiles(): Array<{name: string, data: Uint8Array}> {
    const out: Array<{name: string, data: Uint8Array}> = [];
    for (const [name, bytes] of this.outputs) {
      if (name === '%O') continue;
      const data = new Uint8Array(bytes.length);
      bytes.apply(data);
      out.push({name, data});
    }
    return out;
  }

  /**
   * Adds a symbol the linker itself defines (a segment `define`, or a config
   * SYMBOLS entry). An object file's own definition always wins, since ld65
   * treats these as defaults. Returns whether the symbol was actually added.
   */
  private addLinkerSymbol(name: string, value: number): boolean {
    if (this.exports.has(name)) return false;
    this.exports.set(name, this.symbols.length);
    this.symbols.push({export: name, expr: {op: 'num', num: value}});
    return true;
  }

  /**
   * Creates the START/RUN/ETC symbols for each of the segments.
   * This happens after mapping all segments, so it applies to all segment
   * types (mapped, unmapped, ld65)
   * Returns the symbols it defined, so a config SYMBOLS entry can refer to
   * them.
   */
  private defineSegmentSymbols(merged: Map<string, Segment>): CfgSymbols {
    const defined: CfgSymbols = new Map();
    const define = (name: string, value: number) => {
      if (this.addLinkerSymbol(name, value)) defined.set(name, value);
    };
    for (const name of this.segmentOrder) {
      const seg = merged.get(name);
      if (!seg?.define) continue;
      const start = seg.memory ?? 0;
      const size = seg.size ?? 0;
      define(`__${name}_START__`, start);
      define(`__${name}_RUN__`, start);
      define(`__${name}_LOAD__`, this.segmentLoad.get(name) ?? start);
      define(`__${name}_SIZE__`, size);
      // _LAST__ is the end of what is actually used, which for a mapped
      // segment is only as far as the geometry pass could account for.
      define(`__${name}_LAST__`, start + (this.segmentExtent.get(name) ?? size));
      if (!seg.bss && seg.offset != null) {
        define(`__${name}_FILEOFFS__`, seg.offset);
      }
    }
    return defined;
  }

  /**
   * The config's SYMBOLS block. Entries resolve in declaration order against
   * the earlier ones and against every segment `define`, so
   * `value = __RAM_LAST__` works.
   */
  private defineConfigSymbols(segmentSymbols: CfgSymbols) {
    if (!this.config) return;
    const symbols: CfgSymbols =
        new Map([...configSymbols(this.config, this.objectExports, this.defines),
                 ...segmentSymbols]);
    this.collect(this.config.symbols, sym => {
      if (sym.type === 'import') {
        if (!this.exports.has(sym.name)) {
          this.fail(`Symbol ${sym.name} is imported by the linker config but is ${
               ''}never exported`);
        }
        return;
      }
      // An object file's definition wins, which is what `weak` asks for and
      // what js65 does for `export` too (ld65 would call that a conflict).
      if (this.exports.has(sym.name)) return;
      // A `-D` on the command line replaces the config's value.
      const define = this.defines.get(sym.name);
      const value = define ??
          resolveCfgExpr(sym.value!, symbols, `Value of '${sym.name}'`);
      symbols.set(sym.name, value);
      this.addLinkerSymbol(sym.name, value);
    });
  }

  /**
   * The segments a chunk may go in, ordered by segment declaration and not the order
   * in the chunk's list of segments.
   * The chunk is placed in the first one it fits in, and defers to the rest in turn.
   * A chunk that named no segment at all falls back to the default segment.
   */
  eligibleSegments(chunk: LinkChunk): readonly string[] {
    // Disallow placing a chunk in a segment that isn't defined anywhere
    // This keeps the error collecting running even if the user referenced an undefined segment.
    let segments = chunk.segments.length ?
        chunk.segments.filter(name => this.rawSegments.has(name)) :
        chunk.segments;
    // Don't allow default segment bytes to get placed when anon segments are used.
    if (!chunk.segments.length && !this.anonDeclarationOrder.length) {
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

  /**
   * Maps from a segment name to the "representative" of an overlapping
   * group of segments. If you have A0, A1, A2 that are all :mem $a000
   * then this builds a map of A0 -> A0, A1 -> A0, A2 -> A0 so that we
   * can know which segments are in a group when laying out the chunks.
   */
  private overlapGroup(name: string): string {
    if (!this.overlapGroups) {
      this.overlapGroups = new Map();
      // Traverse the segments in address order and build out a set of
      // intervals for each of the overlapping memory spaces.
      const spans: Array<[string, number, number]> = [];
      for (const [n, s] of this.segments) {
        if (s.size <= 0) continue;
        const base = s.isRam ? s.memory + s.delta : s.offset;
        spans.push([n, base, base + s.size]);
      }
      spans.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
      const order = (n: string) =>
          this.segmentIndex.get(n) ?? this.segmentIndex.size;
      let rep: string|undefined;
      let reach = -Infinity;
      for (const [n, lo, hi] of spans) {
        // A window starting at or after everything seen so far cannot overlap
        // any of it, so it opens a fresh group.
        if (rep == null || lo >= reach) {
          rep = n;
          reach = hi;
        } else {
          reach = Math.max(reach, hi);
          if (order(n) < order(rep)) rep = n;
        }
        this.overlapGroups.set(n, rep);
      }
      // Now promote the first declared segment as the group representative.
      for (const [n, r] of this.overlapGroups) {
        this.overlapGroups.set(n, this.overlapGroups.get(r) ?? r);
      }
    }
    return this.overlapGroups.get(name) ?? name;
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
    if (align === 1 && size < 256 && !chunk.subs.size && !chunk.selfSubs.size && !chunk.overlaps) {
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
    for (let i = 0; i < segments.length;) {
      const group = this.overlapGroup(segments[i]);
      let best: {segment: LinkSegment, start: number, slack: number}|undefined;
      // Check each of the segments that this chunk can be in, grouped by the segment group
      // This inner list walks through each segment in the group, and the outer loop
      // handles switching to the next segment group.
      while (i < segments.length && this.overlapGroup(segments[i]) === group) {
        const segment = this.segment(segments[i++]);
        // For RAM segments, free space is tracked with RAM_OFFSET added to memory addresses
        // For ROM segments, free space is tracked in file offset coordinates.
        // Adjacent free ranges merge, so the space a mapped segment handed to the
        // ones lowered into it has to be excluded here rather than left out of
        // `free`.
        const base = segment.isRam ? segment.memory + segment.delta : segment.offset;
        const s0 = base + segment.used;
        const s1 = base + segment.size;
        // Any space skipped over for alignment stays free, so we can use it later.
        // Slack is used here to determine the best fit in the group.
        const slack = {value: Infinity};
        const found = this.free.bestFit(s0, s1, size, align, segment.delta, slack);
        if (found == null) continue;
        if (best == null || slack.value < best.slack) {
          best = {segment, start: found, slack: slack.value};
        }
      }
      if (best) {
        chunk.place(best.start - best.segment.delta, best.segment);
        // TODO - factor out the subs-aware copy method!
        return;
      }
    }
    if (DEBUG) console.log(`Initial:\n${this.initialReport}`);
    const name = chunk.name ? `${chunk.name} ` : '';
    const aligned = align > 1 ? `${align}-byte aligned ` : '';
    if (!segments.length && this.anonDeclarationOrder.length) {
      this.fail(`${size}-byte chunk ${name}was emitted before the first ` +
                `.segment. All bytes must be placed in a segment`, chunk.at());
    }
    const where = segments.length ?
        segments.map(n => this.segmentLabel(n)).join(', ') : '(no segment)';
    this.fail(`Could not find space for ${aligned}${size}-byte chunk ${
        name}in ${where}`, chunk.at());
  }

  segment(name: string): LinkSegment {
    return this.segments.get(name) ??
        impossible(`Segment not found with name: ${name}`);
  }

  resolveSymbols(expr: Expr): Expr {
    // pre-traverse so that transitive imports work
    return Exprs.traverse(expr, (e, rec) => {
      while (e.op === 'im' || e.op === 'sym') {
        if (e.op === 'im') {
          const name = e.sym!;
          const imported = this.exports.get(name);
          if (imported == null) {
            const msg = `Symbol never exported ${name}`;
            if (this.missingImports.has(name)) throw new RecoverableError(msg);
            this.missingImports.add(name);
            // If possible, blame the node that names the symbol, not the
            // root expression it happens to sit inside.
            this.fail(msg, e.source ? e : expr);
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
    this.config = cfg;
    this.objectExports = exported;
    for (const segment of lowerLinkerConfig(cfg, exported, this.defines)) {
      this.addRawSegment(segment);
      this.configSegments.add(segment.name);
      this.segmentOrder.push(segment.name);
    }
  }

  addRawSegment(segment: Segment) {
    if (Segment.isAnon(segment)) {
      if (this.rawSegments.has(segment.name)) {
        // Merging them would silently fuse two banks into one, since
        // Segment.merge is last-wins.
        this.fail(`Duplicate anonymous segment ${segment.name}; ` +
                  `this is a js65 bug, please report it`);
      }
      this.anonDeclarationOrder.push(segment.name);
    } else {
      this.hasNamedSegment = true;
    }
    let list = this.rawSegments.get(segment.name);
    if (!list) this.rawSegments.set(segment.name, list = []);
    list.push(segment);
  }

  checkAnonMode(what?: string) {
    if (!this.anonDeclarationOrder.length) return;
    if (what) this.fail(`${what} cannot be combined with anonymous segments`);
    if (this.hasNamedSegment) {
      this.fail(`Anonymous segments cannot be combined with named segments.`);
    }
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
      if (e.meta?.bank != null)
        out.bank = e.meta.bank;
      if (e.meta?.chunk != null && this.chunks[e.meta.chunk]?.isMirrored) {
        this.errorCollector?.add(
            'warning',
            `.bank value is 0 for mirrored data`,
            symbol.expr?.source);
      }
      map.set(symbol.export, out);
    }
    return map;
  }

  private segmentLabel(name: string): string {
    if (!Segment.isAnon(name)) return name;
    const memory = this.segments.get(name)?.memory ?? 0;
    return anonSegmentLabel(name, memory);
  }

  /**
   * Bare bones segment list report used for comparing against ca65 built projects.
   */
  private segmentReport(): string {
    if (!this.segments.size) return '';
    const hex = (n: number, w = 6) => n.toString(16).toUpperCase().padStart(w, '0');
    // How far the chunks actually placed in each segment reach. `Size` is what
    // the segment was given, `Used` is what it needed - the two differ because
    // a segment is measured before placement gets to backfill alignment gaps.
    const used = new Map<string, number>();
    for (const chunk of this.chunks) {
      const seg = chunk.segment;
      if (!seg || chunk.org == null) continue;
      const end = chunk.org + chunk.size - seg.memory;
      used.set(seg.name, Math.max(used.get(seg.name) ?? 0, end));
    }
    // Chop the name of the anon segment to 20 characters so it fits nicer in the output
    const rows = this.segmentOrder.filter(n => this.segments.has(n))
        .map(n => [n, this.segmentLabel(n)] as const);
    const width = Math.max(20, ...rows.map(([, label]) => label.length));
    let out = 'Segment list:\n-------------\n';
    out += `${'Name'.padEnd(width)}   Start     End    Size    Used  Align  FileOffs  File\n`;
    out += '-'.repeat(width + 56) + '\n';
    for (const [name, label] of rows) {
      const s = this.segments.get(name)!;
      const end = s.memory + Math.max(s.size - 1, 0);
      // A segment that emits nothing has no offset worth printing.
      const file = s.isRam ? '' : (s.out || '%O');
      const offs = s.isRam ?
          '      ' : hex(s.offset - (this.fileBases.get(file) ?? 0));
      out += `${label.padEnd(width)}  ${hex(s.memory)}  ${hex(end)}  ${
             hex(s.size)}  ${hex(used.get(name) ?? 0)}  ${
             hex(this.segmentAlign.get(name) ?? 1, 5)}  ${offs}  ${file}\n`;
    }
    return out + '\n';
  }

  report(verbose = false): string {
    // TODO - accept a segment to filter?
    let out = this.segmentReport();
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
