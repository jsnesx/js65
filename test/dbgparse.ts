/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Reader, syntax checker and normalizer for ld65 `.dbg` files.
// Format notes are in ai_docs/dbgfile-format.md.

export class DbgError extends Error {}

export type Attrs = [key: string, value: string][];
export interface RawRecord { keyword: string; line: number; attrs: Attrs; }

export interface DbgSeg {
  id: number; name: string; start: number; size: number; addrsize: string;
  type: string; oname?: string; ooffs?: number;
}
export interface DbgFile {
  id: number; name: string; size: number; mtime: number; mods: number[];
}
export interface DbgLib { id: number; name: string; }
export interface DbgMod { id: number; name: string; file: number; lib?: number; }
export interface DbgSpan {
  id: number; seg: number; start: number; size: number; type?: number;
}
export interface DbgLine {
  id: number; file: number; line: number; type: number; count: number;
  spans: number[];
}
export interface DbgScope {
  id: number; name: string; mod: number; type?: string; size: number;
  parent?: number; sym?: number; spans: number[];
}
export interface DbgSym {
  id: number; name: string; addrsize: string; size: number;
  scope?: number; parent?: number; defs: number[]; refs: number[];
  kind: 'imp' | 'lab' | 'equ'; exp?: number; val?: number; seg?: number;
}
export interface DbgCSym {
  id: number; name: string; scope: number; type: number; sc: string;
  offs: number; sym?: number;
}
export interface DbgType { id: number; val: string; }

export interface DbgModel {
  major: number; minor: number;
  info: Map<string, number>;
  segs: DbgSeg[]; files: DbgFile[]; libs: DbgLib[]; mods: DbgMod[];
  spans: DbgSpan[]; lines: DbgLine[]; scopes: DbgScope[]; syms: DbgSym[];
  csyms: DbgCSym[]; types: DbgType[];
}

const KEYWORDS = ['version', 'info', 'csym', 'file', 'lib', 'line', 'mod',
                  'seg', 'span', 'scope', 'sym', 'type'];

/** Splits text into records. Strings end at the next quote and may hold commas. */
export function parseRaw(text: string): RawRecord[] {
  const out: RawRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const keyword = (tab < 0 ? line : line.slice(0, tab)).trim();
    const rec: RawRecord = {keyword, line: i + 1, attrs: []};
    if (!KEYWORDS.includes(keyword)) {
      throw new DbgError(`line ${i + 1}: unknown record "${keyword}"`);
    }
    let p = tab < 0 ? line.length : tab + 1;
    while (p < line.length) {
      const eq = line.indexOf('=', p);
      if (eq < 0) throw new DbgError(`line ${i + 1}: attribute without "="`);
      const key = line.slice(p, eq).trim();
      let end: number;
      if (line[eq + 1] === '"') {
        const close = line.indexOf('"', eq + 2);
        if (close < 0) throw new DbgError(`line ${i + 1}: unterminated string`);
        end = close + 1;
      } else {
        end = line.indexOf(',', eq + 1);
        if (end < 0) end = line.length;
      }
      rec.attrs.push([key, line.slice(eq + 1, end)]);
      if (end < line.length && line[end] !== ',') {
        throw new DbgError(`line ${i + 1}: expected "," after "${key}"`);
      }
      p = end + 1;
    }
    out.push(rec);
  }
  return out;
}

function toNum(rec: RawRecord, key: string, v: string): number {
  let n: number;
  if (/^[+-]?0x[0-9a-f]+$/i.test(v)) n = parseInt(v, 16);
  else if (/^[+-]?0[0-7]+$/.test(v)) n = parseInt(v, 8);
  else if (/^[+-]?\d+$/.test(v)) n = parseInt(v, 10);
  else throw new DbgError(`line ${rec.line}: bad number "${v}" for "${key}"`);
  return n;
}

function toStr(rec: RawRecord, key: string, v: string): string {
  if (v.length < 2 || v[0] !== '"' || v[v.length - 1] !== '"') {
    throw new DbgError(`line ${rec.line}: "${key}" must be a string`);
  }
  return v.slice(1, -1);
}

function toList(rec: RawRecord, key: string, v: string): number[] {
  return v.split('+').map(x => toNum(rec, key, x));
}

/** Reads the attributes of one record against its table of expected keys. */
class Reader {
  private vals = new Map<string, string>();
  constructor(private rec: RawRecord, allowed: string[]) {
    for (const [k, v] of rec.attrs) {
      if (!allowed.includes(k)) continue;
      if (this.vals.has(k)) {
        throw new DbgError(`line ${rec.line}: duplicate "${k}"`);
      }
      this.vals.set(k, v);
    }
  }
  has(k: string) { return this.vals.has(k); }
  num(k: string): number {
    const v = this.need(k);
    return toNum(this.rec, k, v);
  }
  optNum(k: string): number | undefined {
    return this.has(k) ? this.num(k) : undefined;
  }
  str(k: string): string { return toStr(this.rec, k, this.need(k)); }
  optStr(k: string): string | undefined {
    return this.has(k) ? this.str(k) : undefined;
  }
  word(k: string): string { return this.need(k); }
  optWord(k: string): string | undefined {
    return this.has(k) ? this.need(k) : undefined;
  }
  list(k: string): number[] {
    return this.has(k) ? toList(this.rec, k, this.need(k)) : [];
  }
  private need(k: string): string {
    const v = this.vals.get(k);
    if (v === undefined) {
      throw new DbgError(`line ${this.rec.line}: ${this.rec.keyword}: required attribute "${k}" missing`);
    }
    return v;
  }
}

function checkDense(kind: string, ids: number[]) {
  ids.forEach((id, i) => {
    if (id !== i) {
      throw new DbgError(`${kind}: ids must be dense from 0, found ${id} at position ${i}`);
    }
  });
}

function checkRef(kind: string, what: string, id: number | undefined, n: number) {
  if (id !== undefined && (id < 0 || id >= n)) {
    throw new DbgError(`${kind}: ${what} id ${id} out of range (${n})`);
  }
}

/** Parses a .dbg file, enforcing what the cc65 reader enforces. Throws DbgError. */
export function parseDbg(text: string): DbgModel {
  const recs = parseRaw(text);
  if (!recs.length || recs[0].keyword !== 'version') {
    throw new DbgError('first record must be "version"');
  }
  const m: DbgModel = {
    major: 0, minor: 0, info: new Map(),
    segs: [], files: [], libs: [], mods: [], spans: [], lines: [],
    scopes: [], syms: [], csyms: [], types: [],
  };
  for (const rec of recs) {
    switch (rec.keyword) {
      case 'version': {
        const r = new Reader(rec, ['major', 'minor']);
        m.major = r.num('major');
        m.minor = r.num('minor');
        break;
      }
      case 'info':
        for (const [k, v] of rec.attrs) m.info.set(k, toNum(rec, k, v));
        break;
      case 'seg': {
        const r = new Reader(rec, ['id', 'name', 'start', 'size', 'addrsize',
                                   'type', 'oname', 'ooffs']);
        m.segs.push({
          id: r.num('id'), name: r.str('name'), start: r.num('start'),
          size: r.num('size'), addrsize: r.word('addrsize'),
          type: r.word('type'), oname: r.optStr('oname'),
          ooffs: r.optNum('ooffs'),
        });
        break;
      }
      case 'file': {
        const r = new Reader(rec, ['id', 'name', 'size', 'mtime', 'mod']);
        m.files.push({
          id: r.num('id'), name: r.str('name'), size: r.num('size'),
          mtime: r.num('mtime'), mods: r.list('mod'),
        });
        if (!r.has('mod')) throw new DbgError(`line ${rec.line}: file: "mod" missing`);
        break;
      }
      case 'lib': {
        const r = new Reader(rec, ['id', 'name']);
        m.libs.push({id: r.num('id'), name: r.str('name')});
        break;
      }
      case 'mod': {
        const r = new Reader(rec, ['id', 'name', 'file', 'lib']);
        m.mods.push({
          id: r.num('id'), name: r.str('name'), file: r.num('file'),
          lib: r.optNum('lib'),
        });
        break;
      }
      case 'span': {
        const r = new Reader(rec, ['id', 'seg', 'start', 'size', 'type']);
        m.spans.push({
          id: r.num('id'), seg: r.num('seg'), start: r.num('start'),
          size: r.num('size'), type: r.optNum('type'),
        });
        break;
      }
      case 'line': {
        const r = new Reader(rec, ['id', 'file', 'line', 'type', 'count', 'span']);
        m.lines.push({
          id: r.num('id'), file: r.num('file'), line: r.num('line'),
          type: r.optNum('type') ?? 0, count: r.optNum('count') ?? 0,
          spans: r.list('span'),
        });
        break;
      }
      case 'scope': {
        const r = new Reader(rec, ['id', 'name', 'mod', 'type', 'size',
                                   'parent', 'sym', 'span']);
        m.scopes.push({
          id: r.num('id'), name: r.str('name'), mod: r.num('mod'),
          type: r.optWord('type'), size: r.optNum('size') ?? 0,
          parent: r.optNum('parent'), sym: r.optNum('sym'),
          spans: r.list('span'),
        });
        break;
      }
      case 'sym': {
        const r = new Reader(rec, ['id', 'name', 'addrsize', 'size', 'scope',
                                   'parent', 'def', 'ref', 'val', 'seg',
                                   'type', 'exp']);
        if (r.has('scope') === r.has('parent')) {
          throw new DbgError(`line ${rec.line}: sym: exactly one of "parent", "scope" must be specified`);
        }
        const kind = r.optWord('type') ?? 'lab';
        if (kind !== 'imp' && kind !== 'lab' && kind !== 'equ') {
          throw new DbgError(`line ${rec.line}: sym: bad type "${kind}"`);
        }
        m.syms.push({
          id: r.num('id'), name: r.str('name'), addrsize: r.word('addrsize'),
          size: r.optNum('size') ?? 0, scope: r.optNum('scope'),
          parent: r.optNum('parent'), defs: r.list('def'), refs: r.list('ref'),
          kind, exp: r.optNum('exp'), val: r.optNum('val'),
          seg: r.optNum('seg'),
        });
        break;
      }
      case 'csym': {
        const r = new Reader(rec, ['id', 'name', 'scope', 'type', 'sc',
                                   'offs', 'sym']);
        const sc = r.word('sc');
        if (!['auto', 'reg', 'static', 'ext'].includes(sc)) {
          throw new DbgError(`line ${rec.line}: csym: invalid storage class "${sc}"`);
        }
        if (sc === 'auto' && r.has('sym')) {
          throw new DbgError(`line ${rec.line}: csym: only non auto symbols can have a symbol attached`);
        }
        m.csyms.push({
          id: r.num('id'), name: r.str('name'), scope: r.num('scope'),
          type: r.num('type'), sc, offs: r.optNum('offs') ?? 0,
          sym: r.optNum('sym'),
        });
        break;
      }
      case 'type': {
        const r = new Reader(rec, ['id', 'val']);
        const val = r.str('val');
        if (!/^([0-9A-Fa-f]{2})*$/.test(val)) {
          throw new DbgError(`line ${rec.line}: type: bad type string "${val}"`);
        }
        m.types.push({id: r.num('id'), val});
        break;
      }
    }
  }
  checkModel(m);
  return m;
}

function checkModel(m: DbgModel) {
  for (const list of [m.segs, m.files, m.libs, m.mods, m.spans, m.lines,
                      m.scopes, m.syms, m.csyms, m.types]) {
    list.sort((a, b) => a.id - b.id);
  }
  if (m.major !== 2) throw new DbgError(`unsupported major version ${m.major}`);
  checkDense('seg', m.segs.map(x => x.id));
  checkDense('file', m.files.map(x => x.id));
  checkDense('lib', m.libs.map(x => x.id));
  checkDense('mod', m.mods.map(x => x.id));
  checkDense('span', m.spans.map(x => x.id));
  checkDense('line', m.lines.map(x => x.id));
  checkDense('scope', m.scopes.map(x => x.id));
  checkDense('sym', m.syms.map(x => x.id));
  checkDense('csym', m.csyms.map(x => x.id));
  checkDense('type', m.types.map(x => x.id));

  const nf = m.files.length, nm = m.mods.length, ns = m.segs.length;
  const nsp = m.spans.length, nl = m.lines.length, nsc = m.scopes.length;
  const ny = m.syms.length;
  for (const x of m.files) for (const id of x.mods) checkRef('file', 'mod', id, nm);
  for (const x of m.mods) {
    checkRef('mod', 'file', x.file, nf);
    checkRef('mod', 'lib', x.lib, m.libs.length);
  }
  for (const x of m.spans) checkRef('span', 'seg', x.seg, ns);
  for (const x of m.lines) {
    checkRef('line', 'file', x.file, nf);
    for (const id of x.spans) checkRef('line', 'span', id, nsp);
  }
  for (const x of m.scopes) {
    checkRef('scope', 'mod', x.mod, nm);
    checkRef('scope', 'parent', x.parent, nsc);
    checkRef('scope', 'sym', x.sym, ny);
    for (const id of x.spans) checkRef('scope', 'span', id, nsp);
  }
  for (const x of m.syms) {
    checkRef('sym', 'scope', x.scope, nsc);
    checkRef('sym', 'parent', x.parent, ny);
    checkRef('sym', 'seg', x.seg, ns);
    checkRef('sym', 'exp', x.exp, ny);
    for (const id of x.defs) checkRef('sym', 'def line', id, nl);
    for (const id of x.refs) checkRef('sym', 'ref line', id, nl);
  }
  for (const x of m.csyms) {
    checkRef('csym', 'scope', x.scope, nsc);
    checkRef('csym', 'type', x.type, m.types.length);
    checkRef('csym', 'sym', x.sym, ny);
  }
  for (const x of m.spans) checkRef('span', 'type', x.type, m.types.length);
  // A module with scopes needs a root, or the reader cannot attach them.
  const withScopes = new Set(m.scopes.map(s => s.mod));
  for (const mod of withScopes) {
    if (!m.scopes.some(s => s.mod === mod && s.parent === undefined)) {
      throw new DbgError(`mod ${mod}: scopes without a root scope`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Syntax check                                                        */
/* ------------------------------------------------------------------ */

const DEC = /^(0|[1-9]\d*)$/;
const SDEC = /^-?(0|[1-9]\d*)$/;
const HEX = /^0x(0|[1-9A-F][0-9A-F]*)$/;
const LIST = /^(0|[1-9]\d*)(\+(0|[1-9]\d*))*$/;
const STR = /^"[^"]*"$/;
const oneOf = (...xs: string[]) => (v: string) => xs.includes(v);
const re = (r: RegExp) => (v: string) => r.test(v);
const hexMin = (digits: number) => (v: string) =>
    /^0x[0-9A-F]+$/.test(v) && v.length - 2 >= digits;
const ADDRSIZE = oneOf('default', 'zeropage', 'absolute', 'far', 'long');

interface AttrSpec { key: string; ok: (v: string) => boolean; optional?: boolean; }
const A = (key: string, ok: (v: string) => boolean, optional = false): AttrSpec =>
    ({key, ok, optional});

/** Expected attribute order per record. A sym's tail is handled apart. */
const SPECS: Record<string, AttrSpec[]> = {
  version: [A('major', re(DEC)), A('minor', re(DEC))],
  info: ['csym', 'file', 'lib', 'line', 'mod', 'scope', 'seg', 'span', 'sym',
         'type'].map(k => A(k, re(DEC))),
  csym: [A('id', re(DEC)), A('name', re(STR)), A('scope', re(DEC)),
         A('type', re(DEC)), A('sc', oneOf('auto', 'reg', 'static', 'ext')),
         A('offs', re(SDEC), true), A('sym', re(DEC), true)],
  file: [A('id', re(DEC)), A('name', re(STR)), A('size', re(DEC)),
         A('mtime', hexMin(8)), A('mod', re(LIST))],
  lib: [A('id', re(DEC)), A('name', re(STR))],
  line: [A('id', re(DEC)), A('file', re(DEC)), A('line', re(DEC)),
         A('type', v => v !== '0' && /^[1-9]\d*$/.test(v), true),
         A('count', v => v !== '0' && /^[1-9]\d*$/.test(v), true),
         A('span', re(LIST), true)],
  mod: [A('id', re(DEC)), A('name', re(STR)), A('file', re(DEC)),
        A('lib', re(DEC), true)],
  seg: [A('id', re(DEC)), A('name', re(STR)), A('start', hexMin(6)),
        A('size', hexMin(4)), A('addrsize', ADDRSIZE),
        A('type', oneOf('ro', 'rw')), A('oname', re(STR), true),
        A('ooffs', re(DEC), true)],
  span: [A('id', re(DEC)), A('seg', re(DEC)), A('start', re(DEC)),
         A('size', re(DEC)), A('type', re(DEC), true)],
  scope: [A('id', re(DEC)), A('name', re(STR)), A('mod', re(DEC)),
          A('type', oneOf('global', 'scope', 'struct', 'enum'), true),
          A('size', v => v !== '0' && /^[1-9]\d*$/.test(v), true),
          A('parent', re(DEC), true), A('sym', re(DEC), true),
          A('span', re(LIST), true)],
  type: [A('id', re(DEC)), A('val', v => STR.test(v) &&
                                         /^"([0-9A-F]{2})*"$/.test(v))],
};

const SYM_HEAD: AttrSpec[] = [
  A('id', re(DEC)), A('name', re(STR)), A('addrsize', ADDRSIZE),
  A('size', v => v !== '0' && /^[1-9]\d*$/.test(v), true),
];
const SYM_LOC: AttrSpec[] = [
  A('scope', re(DEC), true), A('parent', re(DEC), true),
  A('def', re(LIST), true), A('ref', re(LIST), true),
];
const SYM_IMP: AttrSpec[] = [
  A('type', oneOf('imp')), A('exp', re(DEC), true),
];
const SYM_DEF: AttrSpec[] = [
  A('val', re(HEX)), A('seg', re(DEC), true), A('type', oneOf('lab', 'equ')),
];

function matchSpec(rec: RawRecord, specs: AttrSpec[], from: number,
                   errors: string[]): number {
  let i = from;
  for (const s of specs) {
    const at = rec.attrs[i];
    if (at && at[0] === s.key) {
      if (!s.ok(at[1])) {
        errors.push(`line ${rec.line}: ${rec.keyword}.${s.key}: bad format "${at[1]}"`);
      }
      i++;
    } else if (!s.optional) {
      errors.push(`line ${rec.line}: ${rec.keyword}: expected "${s.key}" at position ${i}, found "${at ? at[0] : 'end of line'}"`);
      return rec.attrs.length;
    }
  }
  return i;
}

/** Checks record order, attribute order and number formats on the raw text. */
export function checkDbgSyntax(text: string): string[] {
  const errors: string[] = [];
  let recs: RawRecord[];
  try {
    recs = parseRaw(text);
  } catch (e) {
    return [(e as Error).message];
  }
  if (/\r/.test(text)) errors.push('file contains CR characters');
  let lastKind = -1;
  for (const rec of recs) {
    const kind = KEYWORDS.indexOf(rec.keyword);
    if (kind < lastKind) {
      errors.push(`line ${rec.line}: "${rec.keyword}" record out of order`);
    }
    lastKind = Math.max(lastKind, kind);
    let end: number;
    if (rec.keyword === 'sym') {
      let i = matchSpec(rec, SYM_HEAD, 0, errors);
      i = matchSpec(rec, SYM_LOC, i, errors);
      const hasScope = rec.attrs.some(a => a[0] === 'scope');
      const hasParent = rec.attrs.some(a => a[0] === 'parent');
      if (hasScope === hasParent) {
        errors.push(`line ${rec.line}: sym: needs exactly one of scope or parent`);
      }
      const imp = rec.attrs[i] && rec.attrs[i][0] === 'type';
      end = matchSpec(rec, imp ? SYM_IMP : SYM_DEF, i, errors);
    } else {
      end = matchSpec(rec, SPECS[rec.keyword], 0, errors);
    }
    if (end < rec.attrs.length) {
      errors.push(`line ${rec.line}: ${rec.keyword}: unexpected "${rec.attrs[end][0]}"`);
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Normalizer                                                          */
/* ------------------------------------------------------------------ */

export interface NormRecord { kind: string; key: string; attrs: string; }

export interface NormalizeOptions {
  /** Keep addresses and span positions. Off compares structure only. */
  placement?: boolean;
}

const slash = (s: string) => s.replace(/\\/g, '/');

/** ca65 keeps `dir/../x.s` as written; js65 collapses it. Compare collapsed. */
function filePath(name: string): string {
  const out: string[] = [];
  for (const part of slash(name).split('/')) {
    if (part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Rewrites a model with stable keys in place of ids, sorted, and without
 * mtime. Records sharing a key are kept as a multiset.
 */
export function normalizeDbgRecords(m: DbgModel,
                                    opts: NormalizeOptions = {}): NormRecord[] {
  const placement = !!opts.placement;
  const out: NormRecord[] = [];
  const fileKey = (id: number) => filePath(m.files[id].name);
  const segKey = (id: number) => m.segs[id].name;
  const modKey = (id: number) => slash(m.mods[id].name);

  const scopeKeys: string[] = [];
  const scopeKey = (id: number): string => {
    if (scopeKeys[id] !== undefined) return scopeKeys[id];
    const s = m.scopes[id];
    const path = [s.name];
    for (let p = s.parent; p !== undefined; p = m.scopes[p].parent) {
      path.unshift(m.scopes[p].name);
    }
    return scopeKeys[id] = `${modKey(s.mod)}|${path.join('::')}`;
  };

  const symKeys: string[] = [];
  const symKey = (id: number): string => {
    if (symKeys[id] !== undefined) return symKeys[id];
    const s = m.syms[id];
    const owner = s.scope !== undefined ? scopeKey(s.scope) :
        `${symKey(s.parent!)}/`;
    return symKeys[id] = `${owner}::${s.name}`;
  };

  const spanKey = (id: number): string => {
    const s = m.spans[id];
    const t = s.type !== undefined ? `:${m.types[s.type].val}` : '';
    return placement ? `${segKey(s.seg)}:${s.start}+${s.size}${t}` :
        `${segKey(s.seg)}:${s.size}${t}`;
  };
  const lineKey = (id: number): string => {
    const l = m.lines[id];
    return `${fileKey(l.file)}:${l.line}:${l.type}:${l.count}`;
  };
  const list = (ids: number[], f: (id: number) => string) =>
      ids.map(f).sort().join('+');
  const push = (kind: string, key: string, attrs: string[]) =>
      out.push({kind, key, attrs: attrs.filter(a => a).join(' ')});

  for (const s of m.segs) {
    push('seg', s.name, [
      placement ? `start=${s.start}` : '', placement ? `size=${s.size}` : '',
      `addrsize=${s.addrsize}`, `type=${s.type}`,
      placement && s.oname ? `oname=${slash(s.oname)}` : '',
      placement && s.ooffs !== undefined ? `ooffs=${s.ooffs}` : '',
    ]);
  }
  // Two spellings of one path become one file, as js65 sees it.
  const files = new Map<string, Set<string>>();
  for (const f of m.files) {
    const key = `${filePath(f.name)}\0${f.size}`;
    const mods = files.get(key) ?? new Set();
    for (const id of f.mods) mods.add(modKey(id));
    files.set(key, mods);
  }
  for (const [key, mods] of files) {
    const [name, size] = key.split('\0');
    push('file', name, [`size=${size}`, `mod=${[...mods].sort().join('+')}`]);
  }
  for (const l of m.libs) push('lib', slash(l.name), []);
  for (const x of m.mods) {
    push('mod', modKey(x.id), [
      `file=${fileKey(x.file)}`,
      x.lib !== undefined ? `lib=${slash(m.libs[x.lib].name)}` : '']);
  }
  for (const s of m.spans) push('span', spanKey(s.id), []);
  for (const l of m.lines) {
    push('line', lineKey(l.id), [
      l.spans.length ? `span=${list(l.spans, spanKey)}` : '']);
  }
  for (const s of m.scopes) {
    push('scope', scopeKey(s.id), [
      s.type ? `type=${s.type}` : '', s.size ? `size=${s.size}` : '',
      s.sym !== undefined ? `sym=${symKey(s.sym)}` : '',
      s.spans.length ? `span=${list(s.spans, spanKey)}` : '']);
  }
  for (const s of m.syms) {
    const tail = s.kind === 'imp' ?
        [`type=imp`, s.exp !== undefined ? `exp=${symKey(s.exp)}` : ''] :
        [placement ? `val=${s.val}` : '',
         s.seg !== undefined ? `seg=${segKey(s.seg)}` : '', `type=${s.kind}`];
    push('sym', symKey(s.id), [
      `addrsize=${s.addrsize}`, s.size ? `size=${s.size}` : '',
      s.defs.length ? `def=${list(s.defs, lineKey)}` : '',
      s.refs.length ? `ref=${list(s.refs, lineKey)}` : '', ...tail]);
  }
  for (const c of m.csyms) {
    push('csym', `${scopeKey(c.scope)}::${c.name}`, [
      `type=${m.types[c.type].val}`, `sc=${c.sc}`,
      c.offs ? `offs=${c.offs}` : '',
      c.sym !== undefined ? `sym=${symKey(c.sym)}` : '']);
  }
  for (const t of m.types) push('type', t.val, []);

  const order = KEYWORDS;
  out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) ||
                     (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
                     (a.attrs < b.attrs ? -1 : a.attrs > b.attrs ? 1 : 0));
  return out;
}

/** The normalized model as text that diffs line by line. */
export function normalizeDbg(m: DbgModel, opts: NormalizeOptions = {}): string {
  return normalizeDbgRecords(m, opts)
      .map(r => `${r.kind}\t${r.key}${r.attrs ? '\t' + r.attrs : ''}`)
      .join('\n') + '\n';
}
