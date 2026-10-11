// SPDX-License-Identifier: MPL-2.0

/**
 * Documentation for the ld65 dbg format by @pinobatch pulled from this repository
 * 
 * https://github.com/pinobatch/full-quiet-oss/blob/5b7edb7767308b39f627616e092079e378ce85cf/tools/ld65dbg.py
 * 
 * Keys in a "file" entry
 * "id": used by lines to refer to this file
 * "name": name of file in quotation marks
 *
 * Keys in a "line" entry
 * "id": used by ??? to refer to this line of code
 * "file": ID of file containing this line of code
 * "line": line number
 * "mtime": modification date as a UNIX timestamp
 * "mod": +-separated list of translation units containing this file
 * "span": +-separated list of spans that contain this line if any
 *     (may be multiple if macros are involved)
 *
 * Keys in a "seg" entry
 * "id": used by syms to refer to this segment
 * "name": name of segment in quotation marks
 * "oname": ROM file to which segment was written
 * "ooffs": starting address in the ROM file if any
 * "start": starting address in address space
 * "size": size in bytes
 * "type": "ro" for ROM, "rw" for RAM
 *
 * Keys in a "span" entry (things concatenated to make a segment;
 *     don't know if they can overlap)
 * "id": used by ??? to refer to this span
 * "seg": ID of the section containing it
 * "start": offset in some sense (from start of segment?)
 * "size": size in bytes
 *
 * Keys in a "scope" entry
 * "id":
 * "mod": translation unit defining this scope
 * "name": scope name in quotation marks, or "" for a TU's top level
 * "type": scope, struct, or (absent)
 * "parent": ID of enclosing scope if not top level
 * "sym": ID of symbol if this is a .proc
 * "span": spans related to this scope (don't know how .pushseg is treated)
 * "size": ?
 *
 * Keys in a "sym" entry
 * "id": used by other things to refer to this symbol
 * "name": name of symbol in quotation marks
 * "val": value of symbol
 * "addrsize": size of address (zeropage, absolute, far)
 * "seg": associated segment
 * "type": "equ" for an equate, "lab" for a label, or "imp" for
 *     something from another TU accessed via .import or .importzp
 * "exp": If type=imp, the ID of the sym being imported
 *     (a type=imp with no EXP is the unused __SIZE__ label of
 *     a segment with define=yes)
 * "scope": ID of a scope
 * "def": ID of lines where defined (if used in a macro, this is
 *     a +-separated list)
 * "ref": +-separated list of lines where used (may be duplicates if
 *     used in .rept)
 * "size": size in bytes
 *
 * Keys in a "type" entry
 * id and val, where val appears to be some hex bitfield
 * 
 * 
 * My own short summary goes like this:
 * 
 * DBG files has a list of files with their own IDS and each file has a list of lines each with their own ID
 * From there, it breaks the code into seg, span, scope, and syms.
 *
 * Segs are the general layout of the output, matching with the ld65 segment definition.
 *
 * Spans are runs of code/data that land inside a segment. A span cannot cross multiple segments.
 * 
 * Lines have multiple spans which is every location that a single source line appears in the output
 * (for basic lines, this is 1:1, but for macros or repeats, one line may appear in multiple spans)
 * 
 * Scopes have multiple spans to give the "containing" scope name for those ranges in the output.
 * Scopes can be nested, so they have an optional ID for the parent scope.
 * 
 * Syms are the actual labels/imports/equates. These can be in a scope and are associated to a single segment.
 * 
 */

import type { Expr } from './expr.ts';
import type { DebugSym, Module } from './module.ts';

export interface DbgSegment {
  name: string;
  /** Run address. */
  start: number;
  size: number;
  addrsize: string;
  readOnly: boolean;
  /** Set only for a segment written to a file. */
  oname?: string;
  ooffs?: number;
}

/** Chunk bytes `[start, start + size)` land at `segStart` within `seg`. */
export interface DbgChunk {
  seg: number;
  start: number;
  size: number;
  segStart: number;
}

export interface DbgModule {
  module: Module;
  pieces: DbgChunk[][];
}

export interface DbgLink {
  segments: DbgSegment[];
  modules: DbgModule[];
  /** Value of a module's expression, and the segment it points into. */
  resolve(module: number, expr: Expr): {value: number, seg?: number}|undefined;
  /** Index of the module exporting `name`, undefined for linker symbols. */
  exporter(name: string): number|undefined;
}

/** ca65 numbers its default segments first so we match that if they are defined */
const CA65_SEGMENTS = ['CODE', 'RODATA', 'BSS', 'DATA', 'ZEROPAGE', 'NULL'];

/** `[seg, start, size, type]`, with type -1 when untyped. */
type Range = [seg: number, start: number, size: number, type: number];

const hex = (n: number, width = 0) =>
    '0x' + (n < 0 ? n >>> 0 : n).toString(16).toUpperCase().padStart(width, '0');

const basename = (p: string) => p.substring(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/** Sorts by segment and start, joining touching ranges if asked. A join loses its type. */
function mergeRanges(ranges: Range[], rank: (seg: number) => number, join: boolean): Range[] {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0] - b[0] || a[1] - b[1]);
  if (!join) return ranges;
  // Ranges are shared between lines, so a join makes a new one.
  const out: Range[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && last[0] === r[0] && last[1] + last[2] >= r[1]) {
      out[out.length - 1] =
          [last[0], last[1], Math.max(last[2], r[1] + r[2] - last[1]), -1];
    } else {
      out.push(r);
    }
  }
  return out;
}

export function writeDbg(link: DbgLink): string {
  const files: Array<{name: string, size: number, mtime: number, mods: number[]}> = [];
  const fileIds = new Map<string, number>();
  const types: string[] = [];
  const typeIds = new Map<string, number>();
  const typeId = (val: string) => {
    let id = typeIds.get(val);
    if (id === undefined) {
      typeIds.set(val, id = types.length);
      types.push(val);
    }
    return id;
  };
  const fileId = (name: string, size: number, mtime: number, mod: number) => {
    const key = `${name}\0${size}\0${mtime}`;
    let id = fileIds.get(key);
    if (id === undefined) {
      fileIds.set(key, id = files.length);
      files.push({name, size, mtime, mods: []});
    }
    const mods = files[id].mods;
    if (mods[mods.length - 1] !== mod) mods.push(mod);
    return id;
  };

  // Every module's base ids first, since an import names the export's sym.
  const bases: Array<{line: number, scope: number, sym: number, csym: number}> = [];
  let line = 0, scope = 0, sym = 0, csym = 0;
  for (const {module} of link.modules) {
    bases.push({line, scope, sym, csym});
    line += module.debug?.lines.length ?? 0;
    scope += module.debug?.scopes.length ?? 0;
    sym += module.debug?.syms.length ?? 0;
    csym += module.debug?.hll.length ?? 0;
  }
  const exportIds = new Map<number, Map<string, number>>();
  const exportId = (name: string): number|undefined => {
    const m = link.exporter(name);
    const debug = m !== undefined ? link.modules[m].module.debug : undefined;
    if (m === undefined || !debug) return undefined;
    let ids = exportIds.get(m);
    if (!ids) {
      exportIds.set(m, ids = new Map());
      debug.syms.forEach((s, i) => {
        if (s.export && (!ids!.has(s.name) || s.scope === 0)) ids!.set(s.name, i);
      });
    }
    const i = ids.get(name);
    return i !== undefined ? bases[m].sym + i : undefined;
  };

  const out = {
    csym: [] as string[], line: [] as string[], mod: [] as string[],
    span: [] as string[], scope: [] as string[], sym: [] as string[],
  };
  let spanBase = 0;
  link.modules.forEach(({module, pieces}, m) => {
    const debug = module.debug;
    const base = bases[m];
    const name = module.name ?? `module_${m}`;
    const modFiles = debug ?
        debug.files.map(f => fileId(f.name, f.size, f.mtime, m)) :
        [fileId(name, 0, 0, m)];
    out.mod.push(`mod\tid=${m},name="${basename(name)}",file=${modFiles[0]}`);
    // skip modules which weren't compiled with -g
    if (!debug) return;

    const rankOf = new Map<number, number>();
    pieces.forEach((list, chunk) => {
      for (const p of list) {
        if (rankOf.has(p.seg)) continue;
        const fixed = CA65_SEGMENTS.indexOf(link.segments[p.seg].name);
        rankOf.set(p.seg, fixed >= 0 ? fixed : CA65_SEGMENTS.length + chunk);
      }
    });
    const rank = (seg: number) => rankOf.get(seg) ?? Infinity;

    const spans: Range[] = [];
    /** Per segment, span ids keyed by start and size. */
    const spanIds = new Map<number, Map<number, number>>();
    // One span per byte range, typed if any user typed it.
    const spanList = (ranges: Range[] | undefined, join = true): number[] => {
      if (!ranges) return [];
      return mergeRanges(ranges, rank, join).map(r => {
        let ids = spanIds.get(r[0]);
        if (!ids) spanIds.set(r[0], ids = new Map());
        const key = r[1] * 0x1000000 + r[2];
        let id = ids.get(key);
        if (id === undefined) {
          ids.set(key, id = spans.length);
          spans.push([r[0], r[1], r[2], r[3]]);
        } else if (spans[id][3] < 0) {
          spans[id][3] = r[3];
        }
        return spanBase + id;
      });
    };
    const place = (chunk: number, offset: number, size: number, type: number,
                   to: (r: Range) => void) => {
      for (const p of pieces[chunk] ?? []) {
        const s = Math.max(offset, p.start);
        const e = Math.min(offset + size, p.start + p.size);
        if (e <= s) continue;
        const whole = s === offset && e === offset + size;
        to([p.seg, p.segStart + s - p.start, e - s,
            whole && type >= 0 ? typeId(debug.types[type]) : -1]);
      }
    };

    // A statement's own line gets a span each; enclosing lines join theirs.
    const own: Array<Range[]|undefined> = [];
    const outer: Array<Range[]|undefined> = [];
    module.chunks?.forEach((chunk, c) => {
      for (const [set, offset, size, type] of chunk.debugRuns ?? []) {
        const lines = debug.lineSets[set];
        place(c, offset, size, type, r => {
          (own[lines[0]] ??= []).push(r);
          for (let k = 1; k < lines.length; k++) (outer[lines[k]] ??= []).push(r);
        });
      }
    });
    debug.lines.forEach((l, i) => {
      let rec = `line\tid=${base.line + i},file=${modFiles[l.file]},line=${l.line}`;
      if (l.type) rec += `,type=${l.type}`;
      if (l.count) rec += `,count=${l.count}`;
      const mine = spanList(own[i], false);
      const around = spanList(outer[i]);
      const ids = around.length ? [...new Set(mine.concat(around))] : mine;
      if (ids.length) rec += `,span=${ids.join('+')}`;
      out.line.push(rec);
    });

    debug.scopes.forEach((s, i) => {
      const ranges: Range[] = [];
      for (const [chunk, offset, size] of s.runs) {
        place(chunk, offset, size, -1, r => ranges.push(r));
      }
      const ids = spanList(ranges);
      // ld65 copies the size of the scope's first span.
      const size = ids.length && s.type !== 'enum' ? spans[ids[0] - spanBase][2] : s.size;
      let rec = `scope\tid=${base.scope + i},name="${s.name}",mod=${m}`;
      if (s.parent !== undefined) rec += `,type=${s.type ?? 'scope'}`;
      if (size) rec += `,size=${size}`;
      if (s.parent !== undefined) rec += `,parent=${base.scope + s.parent}`;
      if (s.label !== undefined) rec += `,sym=${base.sym + s.label}`;
      if (ids.length) rec += `,span=${ids.join('+')}`;
      out.scope.push(rec);
    });

    debug.syms.forEach((s, i) => out.sym.push(symRecord(s, base.sym + i)));

    debug.hll.forEach((c, i) => {
      let rec = `csym\tid=${base.csym + i},name="${c.name}",scope=${base.scope + c.scope},${
          ''}type=${typeId(c.type)},sc=${c.sc}`;
      if (c.offs) rec += `,offs=${c.offs}`;
      if (c.sym !== undefined && (c.sc === 'static' || c.sc === 'ext')) {
        rec += `,sym=${base.sym + c.sym}`;
      }
      out.csym.push(rec);
    });

    for (let i = 0; i < spans.length; i++) {
      const [seg, start, size, type] = spans[i];
      out.span.push(`span\tid=${spanBase + i},seg=${seg},start=${start},size=${size}${
          type >= 0 ? `,type=${type}` : ''}`);
    }
    spanBase += spans.length;

    function symRecord(s: DebugSym, id: number): string {
      let rec = `sym\tid=${id},name="${s.name}",addrsize=${s.addrsize}`;
      if (s.size) rec += `,size=${s.size}`;
      rec += s.parent !== undefined ? `,parent=${base.sym + s.parent}` :
          `,scope=${base.scope + (s.scope ?? 0)}`;
      if (s.defs?.length) rec += `,def=${s.defs.map(l => base.line + l).join('+')}`;
      if (s.refs?.length) rec += `,ref=${s.refs.map(l => base.line + l).join('+')}`;
      if (s.kind === 'imp') {
        const exp = exportId(s.expr?.sym ?? s.name);
        return rec + (exp !== undefined ? `,type=imp,exp=${exp}` : ',type=imp');
      }
      const val = s.expr && link.resolve(m, s.expr);
      rec += `,val=${hex(val?.value ?? 0)}`;
      if (val?.seg !== undefined) rec += `,seg=${val.seg}`;
      return rec + `,type=${s.kind}`;
    }
  });

  const segs = link.segments.map((s, i) => {
    let rec = `seg\tid=${i},name="${s.name}",start=${hex(s.start, 6)},size=${
        hex(s.size, 4)},addrsize=${s.addrsize},type=${s.readOnly ? 'ro' : 'rw'}`;
    if (s.oname !== undefined) rec += `,oname="${s.oname}",ooffs=${s.ooffs ?? 0}`;
    return rec;
  });
  const fileRecs = files.map((f, i) =>
      `file\tid=${i},name="${f.name}",size=${f.size},mtime=${hex(f.mtime, 8)},mod=${
          f.mods.join('+')}`);
  const typeRecs = types.map((t, i) => `type\tid=${i},val="${t}"`);

  return [
    'version\tmajor=2,minor=0',
    `info\tcsym=${out.csym.length},file=${files.length},lib=0,line=${out.line.length},${
        ''}mod=${out.mod.length},scope=${out.scope.length},seg=${segs.length},${
        ''}span=${out.span.length},sym=${out.sym.length},type=${types.length}`,
    ...out.csym, ...fileRecs, ...out.line, ...out.mod, ...segs, ...out.span,
    ...out.scope, ...out.sym, ...typeRecs,
  ].join('\n') + '\n';
}
