
// SPDX-License-Identifier: MPL-2.0

/**
 * Parser for ld65 linker configuration files compatibility.
 *
 * Parses the ld65 scripts into the existing segment definition
 * that we use for linking in js65.
 */

import {type Expr} from './expr.ts';
import * as Exprs from './expr.ts';
import {type Token} from './token.ts';
import * as Tokens from './token.ts';
import {Tokenizer} from './tokenizer.ts';
import {ErrorCollector} from './assembler.ts';

export type AreaType = 'ro' | 'rw';
export type SegmentType = AreaType | 'bss' | 'zp' | 'overwrite';

const AREA_TYPES: readonly string[] = ['ro', 'rw'];
const SEGMENT_TYPES: readonly string[] = ['ro', 'rw', 'bss', 'zp', 'overwrite'];

export type CfgSymbols = Map<string, number>;

export interface MemoryArea {
  name: string;
  start: Expr;
  size: Expr;
  type: AreaType;
  /** `file =`; undefined means the area's bytes are not written anywhere. */
  file?: string;
  fill: boolean;
  fillval: number;
  bank?: Expr;
  /** Creates the symbols START/SIZE/LAST/FILEOFFS */
  define: boolean;
  /** ld65 orders output by the order its declared so we need to track that. */
  index: number;
}

export interface SegmentDef {
  name: string;
  load: string;
  run: string;
  /** Optional in the config. Defaults to the *load* area's type. */
  type: SegmentType;
  // Unlike the MEMORY section, every numeric SEGMENTS attribute is a plain number
  align?: number;
  alignLoad?: number;
  start?: number;
  offset?: number;
  fillval?: number;
  /** Creates the symbols LOAD/RUN/SIZE */
  define: boolean;
  optional: boolean;
  /** ld65 orders output by the order its declared so we need to track that. */
  index: number;
}

export interface FileDef {
  name: string;
  format: string;
}

/**
 * `export` defines the symbol outright
 * `weak` defines it only if no object file already exported it
 * `import` requires that some object file define it, and must not have a value set.
 */
export interface SymbolDef {
  name: string;
  type: 'export' | 'import' | 'weak';
  value?: Expr;
}

export interface LinkerConfig {
  memory: MemoryArea[];
  segments: SegmentDef[];
  files: FileDef[];
  symbols: SymbolDef[];
}

/**
 * Custom tokenizer using our existing tokenizer but with specific overrides
 * to adapt it for the ld65 file differences. So things like `;` meaning terminator
 * instead of comment. This does mean putting weird stuff in the ld65 script that
 * errors out could cause some strange error messages if they overlap with js65
 * tokens, but that should be rare enough to not matter.
 */
export class CfgTokenizer extends Tokenizer {
  /**
   * Value substituted for `%S`, passed into the cli as ld65's `-S` or FEATURES STARTADDRESS.
   */
  startAddr?: number;

  protected override skipIgnored(): void {
    while (this.buffer.space() || this.buffer.newline() ||
           this.buffer.token(/^(#|\/\/).*/)) {
             // intentionally empty
           }
  }

  /** change the default meaning of `%` since here its for `%O`/`%S` filename placeholders */
  protected override numberRegex(): RegExp { return /^\$?[0-9a-z_]+/i; }

  /** added a new `;` token for line ending so we need to add it to the operator list */
  protected override operatorRegex(): RegExp {
    return /^([;,=:]|\++|-+|&&?|\|\|?|[*/~^]|<[<=]?|>[>=]?)/;
  }

  /** Handle the %o / %s tokens as well */
  protected override tokenInternal(): Token {
    if (this.buffer.token(/^%[a-z0-9_]*/i)) {
      if (this.buffer.group() === '%S' && this.startAddr != null) {
        return {token: 'num', num: this.startAddr};
      }
      return this.strTok('str');
    }
    return super.tokenInternal();
  }

  /** Reads in the entire file */
  tokens(): Token[] {
    return this.nextSync() ?? [];
  }
}

/**
 * Attributes of a single `name: key = value, ...;` statement.  The value tokens
 * are kept so every diagnostic can point at the offending value.
 */
class Attrs {
  private readonly values = new Map<string, Token[]>();
  private readonly keys = new Map<string, Token>();

  constructor(args: Token[][], private readonly at: Token) {
    for (const arg of args) {
      const keyTok = arg[0];
      const key = Tokens.expectIdentifier(keyTok, at).toLowerCase();
      Tokens.expect(Tokens.ASSIGN, arg[1], keyTok);
      const value = arg.slice(2);
      if (!value.length) Tokens.fail(`Missing value for '${key}'`, arg[1]);
      if (this.values.has(key)) Tokens.fail(`Duplicate attribute: ${key}`, keyTok);
      this.values.set(key, value);
      this.keys.set(key, keyTok);
    }
  }

  checkKnown(known: readonly string[], block: string): void {
    for (const key of this.values.keys()) {
      if (known.includes(key)) continue;
      Tokens.fail(`Unknown ${block} attribute '${key}', expected one of: ${
          known.join(', ')}`, this.keys.get(key));
    }
  }

  expr(key: string): Expr|undefined {
    const value = this.values.get(key);
    if (!value) return undefined;
    try {
      return Exprs.traversePost(Exprs.parseOnly(value), Exprs.evaluate);
    } catch (err) {
      throw Tokens.SourceError.locate(err, value[0].source);
    }
  }

  reqExpr(key: string): Expr {
    const expr = this.expr(key);
    if (!expr) Tokens.fail(`Missing required attribute '${key}'`, this.at);
    return expr;
  }

  num(key: string): number|undefined {
    const expr = this.expr(key);
    if (!expr) return undefined;
    if (expr.op !== 'num' || expr.num == null) {
      Tokens.fail(`Value of '${key}' must be a constant${
          describeUnresolved(expr)}`, this.values.get(key)![0]);
    }
    return expr.num;
  }

  reqNum(key: string): number {
    const value = this.num(key);
    if (value == null) Tokens.fail(`Missing required attribute '${key}'`, this.at);
    return value;
  }

  keyword(key: string, allowed: readonly string[]): string|undefined {
    const value = this.values.get(key);
    if (!value) return undefined;
    if (value.length !== 1 || value[0].token !== 'ident' ||
        !allowed.includes(value[0].str.toLowerCase())) {
      Tokens.fail(`Value of '${key}' must be one of: ${allowed.join(', ')}`,
                  value[0]);
    }
    return value[0].str.toLowerCase();
  }

  bool(key: string, dflt: boolean): boolean {
    const value = this.keyword(key, ['yes', 'no', 'true', 'false']);
    if (value == null) return dflt;
    return value === 'yes' || value === 'true';
  }

  /**
   * 
   */
  name(key: string): string|undefined {
    const value = this.values.get(key);
    if (!value) return undefined;
    const tok = value[0];
    if (value.length !== 1 || (tok.token !== 'ident' && tok.token !== 'str')) {
      Tokens.fail(`Value of '${key}' must be a name`, tok);
    }
    return tok.str;
  }

  reqName(key: string): string {
    const value = this.name(key);
    if (value == null) Tokens.fail(`Missing required attribute '${key}'`, this.at);
    return value;
  }
}

function unresolvedNames(expr: Expr): string[] {
  const out = new Set<string>();
  Exprs.traverse(expr, (e, rec) => {
    if (e.sym) out.add(e.sym);
    if (e.str) out.add(e.str);
    return rec(e);
  });
  return [...out];
}

/** ` (FOO is not defined)` -- appended to a "not constant" diagnostic. */
function describeUnresolved(expr: Expr): string {
  const names = unresolvedNames(expr);
  if (!names.length) return '';
  return ` (${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} not defined)`;
}

/**
 * Resolves a deferred config expression against the symbols known so far.
 * All sections have specific order that they are processed, and theres no
 * loops for things that haven't been discovered. So no "real" forward
 * references, but sections are parsed in the following order to kinda fake it.
 *
 * -> SYMBOLS 
 * -> MEMORY resolves `start`
 * -> MEMORY if `define`ed, creates __START__
 * -> MEMORY resolves `size`
 * -> Resolve all SEGMENTs that on the MEMORY to define RUN/LOAD/SIZE
 * -> and finally the rest of the MEMORY defines SIZE/LAST/FILEOFFS
 * 
 * So a later MEMORYs `start` can reference an earlier MEMORYs SEGMENT defines
 *
 * what param is the original description of the value used for the error message.
 */
export function resolveCfgExpr(expr: Expr, symbols: CfgSymbols,
                               what: string): number {
  const resolved = Exprs.traverse(expr, (e, rec) => {
    if (e.op === 'sym' && e.sym != null) {
      const value = symbols.get(e.sym);
      if (value != null) return {op: 'num', num: value};
    }
    return Exprs.evaluate(rec(e));
  });
  if (resolved.op !== 'num' || resolved.num == null) {
    Tokens.fail(`${what} is not constant${describeUnresolved(resolved)}`, expr);
  }
  return resolved.num;
}

export function configSymbols(cfg: LinkerConfig,
                              objectExports: ReadonlySet<string> = new Set()): CfgSymbols {
  const out: CfgSymbols = new Map();
  for (const sym of cfg.symbols) {
    if (sym.value == null) continue;
    if (sym.type === 'weak' && objectExports.has(sym.name)) continue;
    try {
      out.set(sym.name, resolveCfgExpr(sym.value, out, `Value of '${sym.name}'`));
    } catch {
      // Not constant, but don't create an error here.
      // We can make a better error message later with more context than we could here.
    }
  }
  return out;
}

function statements(grp: Token[], at: Token): Token[][] {
  const out: Token[][] = [];
  let start = 0;
  for (;;) {
    const semi = Tokens.find(grp, Tokens.SEMI, start);
    if (semi < 0) break;
    if (semi > start) out.push(grp.slice(start, semi));
    start = semi + 1;
  }
  if (start < grp.length) {
    Tokens.fail(`Expected ';' after statement`, grp[grp.length - 1] ?? at);
  }
  return out;
}

/**
 * Splits the attributes into name = value pairs where the `,` can be optionally
 * excluded because why does ld65 that have that?
 */
function splitAttrs(stmt: Token[], start: number): Token[][] {
  const out: Token[][] = [];
  let cur: Token[]|undefined;
  let depth = 0;
  for (let i = start; i < stmt.length; i++) {
    const tok = stmt[i];
    if (!depth && tok.token === 'ident' &&
        Tokens.eq(stmt[i + 1], Tokens.ASSIGN)) {
      out.push(cur = [tok]);
      continue;
    }
    if (Tokens.eq(tok, Tokens.LP)) depth++;
    else if (Tokens.eq(tok, Tokens.RP)) depth--;
    else if (!depth && Tokens.eq(tok, Tokens.COMMA)) continue;
    if (!cur) {
      Tokens.fail(`Expected an attribute name: ${Tokens.nameOf(tok)}`, tok);
    }
    cur.push(tok);
  }
  return out;
}

function statementName(stmt: Token[]): string {
  const tok = stmt[0];
  if (tok.token !== 'ident' && tok.token !== 'str') {
    Tokens.fail(`Expected a name: ${Tokens.nameOf(tok)}`, tok);
  }
  Tokens.expect(Tokens.COLON, stmt[1], tok);
  return tok.str;
}

const MEMORY_ATTRS = [
  'bank', 'define', 'file', 'fill', 'fillval', 'size', 'start', 'type',
];
const SEGMENT_ATTRS = [
  'align', 'align_load', 'define', 'fillval', 'load', 'offset', 'optional',
  'run', 'start', 'type',
];

function parseMemory(grp: Token[], at: Token, out: MemoryArea[]): void {
  for (const stmt of statements(grp, at)) {
    const name = statementName(stmt);
    const attrs = new Attrs(splitAttrs(stmt, 2), stmt[0]);
    attrs.checkKnown(MEMORY_ATTRS, 'MEMORY');
    // file = "" means "do not write" so put it as undefined to mark that
    const file = attrs.name('file') || undefined;
    const bank = attrs.expr('bank');
    out.push({
      name,
      start: attrs.reqExpr('start'),
      size: attrs.reqExpr('size'),
      type: (attrs.keyword('type', AREA_TYPES) ?? 'rw') as AreaType,
      ...(file != null ? {file} : {}),
      fill: attrs.bool('fill', false),
      fillval: attrs.num('fillval') ?? 0,
      ...(bank != null ? {bank} : {}),
      define: attrs.bool('define', false),
      index: out.length,
    });
  }
}

function parseSegments(grp: Token[], at: Token, out: RawSegmentDef[]): void {
  for (const stmt of statements(grp, at)) {
    const name = statementName(stmt);
    const attrs = new Attrs(splitAttrs(stmt, 2), stmt[0]);
    attrs.checkKnown(SEGMENT_ATTRS, 'SEGMENTS');
    const load = attrs.name('load');
    const run = attrs.name('run');
    if (load == null && run == null) {
      Tokens.fail(`Segment '${name}' needs at least one of 'load' or 'run'`,
                  stmt[0]);
    }
    out.push({
      name,
      load: (load ?? run)!,
      run: (run ?? load)!,
      type: attrs.keyword('type', SEGMENT_TYPES) as SegmentType|undefined,
      align: attrs.num('align'),
      alignLoad: attrs.num('align_load'),
      start: attrs.num('start'),
      offset: attrs.num('offset'),
      fillval: attrs.num('fillval'),
      define: attrs.bool('define', false),
      optional: attrs.bool('optional', false),
      index: out.length,
      at: stmt[0],
    });
  }
}

/** A SegmentDef before its `type` default has been resolved from its load area. */
interface RawSegmentDef extends Omit<SegmentDef, 'type'> {
  type?: SegmentType;
  at: Token;
}

function parseFiles(grp: Token[], at: Token, out: FileDef[]): void {
  for (const stmt of statements(grp, at)) {
    const name = statementName(stmt);
    const attrs = new Attrs(splitAttrs(stmt, 2), stmt[0]);
    attrs.checkKnown(['format'], 'FILES');
    // we don't support some of these, but we accept them as input. Probably should issue
    // a warning but its too much effort for now.
    const format = attrs.keyword('format', ['bin', 'binary', 'o65', 'atari']);
    out.push({name, format: format === 'binary' ? 'bin' : (format ?? 'bin')});
  }
}

function parseSymbols(grp: Token[], at: Token, out: SymbolDef[]): void {
  for (const stmt of statements(grp, at)) {
    const name = statementName(stmt);
    const attrs = new Attrs(splitAttrs(stmt, 2), stmt[0]);
    attrs.checkKnown(['type', 'value', 'addrsize'], 'SYMBOLS');
    const type = (attrs.keyword('type', ['export', 'import', 'weak']) ??
                  Tokens.fail(`Symbol '${name}' needs a 'type'`,
                              stmt[0])) as SymbolDef['type'];
    const value = attrs.expr('value');
    if (type === 'import') {
      if (value != null) {
        Tokens.fail(`Imported symbol '${name}' must not have a value`, stmt[0]);
      }
    } else if (value == null) {
      Tokens.fail(`Symbol '${name}' of type '${type}' needs a 'value'`, stmt[0]);
    }
    out.push({name, type, ...(value != null ? {value} : {})});
  }
}

// TODO: allow passing in startAddr from CLI / libasm
export interface ParseOptions {
  startAddr?: number;
}

export function parseLinkerConfig(text: string, file = 'linker.cfg',
                                  opts: ParseOptions = {}): LinkerConfig {
  const errors = new ErrorCollector();
  const tokenizer = new CfgTokenizer(text, file, {generateDebugInfo: true},
                                     undefined, errors);
  tokenizer.startAddr = opts.startAddr;
  const toks = tokenizer.tokens();
  const firstError = errors.getMessages().find(m => m.level === 'error');
  if (firstError) throw new Tokens.SourceError(firstError.message, firstError.source);

  const memory: MemoryArea[] = [];
  const rawSegments: RawSegmentDef[] = [];
  const files: FileDef[] = [];
  const symbols: SymbolDef[] = [];

  for (let i = 0; i < toks.length; i += 2) {
    const nameTok = toks[i];
    const name = Tokens.expectIdentifier(nameTok, toks[i - 1]).toUpperCase();
    const grp = toks[i + 1];
    if (!grp || grp.token !== 'grp') {
      Tokens.fail(`Expected '{' after ${name}`, grp ?? nameTok);
    }
    switch (name) {
      case 'MEMORY': parseMemory(grp.inner, nameTok, memory); break;
      case 'SEGMENTS': parseSegments(grp.inner, nameTok, rawSegments); break;
      case 'FILES': parseFiles(grp.inner, nameTok, files); break;
      case 'SYMBOLS': parseSymbols(grp.inner, nameTok, symbols); break;
      // TODO implement these cfg features
      case 'FEATURES': case 'FORMATS': break;
      default: Tokens.fail(`Unknown linker config block: ${name}`, nameTok);
    }
  }

  const areas = new Map(memory.map(a => [a.name, a]));
  const segments = rawSegments.map(raw => {
    const {at, ...rest} = raw;
    for (const key of ['load', 'run'] as const) {
      if (!areas.has(rest[key])) {
        Tokens.fail(`Segment '${rest.name}' has ${key} = ${rest[key]
            }, which is not a MEMORY area`, at);
      }
    }
    // ld65 defaults a segment's type to that of the area it loads into.
    return {...rest, type: rest.type ?? areas.get(rest.load)!.type} as SegmentDef;
  });

  return {memory, segments, files, symbols};
}
