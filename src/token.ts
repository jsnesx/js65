
// SPDX-License-Identifier: MPL-2.0

import {assertNever} from './util.ts';
import {at, fail, type SourceInfo} from './error.ts';

// The error machinery used to live here, and rather than refactor
// it all just reexport it until i decide if its important.
export * from './error.ts';

export interface Source {
  next(): Token[]|undefined;
}

export function pullLines(source: Source,
                          step: (line: Token[]|undefined) => boolean): void {
  for (;;) {
    const line = source.next();
    if (!step(line)) return;
  }
}

export type GroupTok = 'grp';
export type StringTok = 'ident' | 'op' | 'cs' | 'str';
export type NumberTok = 'num';
export type NullTok = 'lb' | 'lc' | 'lp' | 'rb' | 'rc' | 'rp' | 'eol' | 'eof';

// NOTE: This is not tokenized initially, but is added *very* early for
// curly-brace groups since basically everything wants to skip over them
// in a single go.  We don't treat any other grouping operators as strongly.
export interface GroupToken {
  token: GroupTok;
  inner: Token[];
  source?: SourceInfo;
}
export interface StringToken {
  token: StringTok;
  str: string; // Canonical form for CS tokens
  rawStr?: string; // Original possibly aliased form for CS tokens
  char?: boolean; // marks a difference between char single quotes and string double quotes.
  source?: SourceInfo;
  /**
   * Set on a label the preprocessor split off a line that still had content, so
   * the assembler can attribute that line's data to the label for `.sizeof`.
   */
  labelsData?: boolean;
  /** Marks when an .if/.elseif/etc statement is delayed till the latepass */
  deferred?: boolean;
}
export interface NumberToken {
  token: NumberTok;
  num: number;
  source?: SourceInfo;
  width?: number; // number of bytes in literal
  radix?: number; // radix the literal was written in: 16, 10, or 2
}
export interface NullaryToken {
  token: NullTok;
  source?: SourceInfo;
}

export type Token = GroupToken | StringToken | NumberToken | NullaryToken;

// Grouping tokens
export const LB: Token = {token: 'lb'};
export const LC: Token = {token: 'lc'};
export const LP: Token = {token: 'lp'};
export const RB: Token = {token: 'rb'};
export const RC: Token = {token: 'rc'};
export const RP: Token = {token: 'rp'};
export const EOL: Token = {token: 'eol'};
export const EOF: Token = {token: 'eof'};
// Important macro expansion tokens
export const DEFINE: Token = {token: 'cs', str: '.define'};
export const DOT_EOL: Token = {token: 'cs', str: '.eol'};
export const ELSE: Token = {token: 'cs', str: '.else'};
export const ELSEIF: Token = {token: 'cs', str: '.elseif'};
export const ENDIF: Token = {token: 'cs', str: '.endif'};
export const ENDMACRO: Token = {token: 'cs', str: '.endmacro'};
export const ENDREPEAT: Token = {token: 'cs', str: '.endrepeat'};
export const ENDPROC: Token = {token: 'cs', str: '.endproc'};
export const ENDSCOPE: Token = {token: 'cs', str: '.endscope'};
export const LOCAL: Token = {token: 'cs', str: '.local'};
export const MACRO: Token = {token: 'cs', str: '.macro'};
export const REPEAT: Token = {token: 'cs', str: '.repeat'};
export const SET: Token = {token: 'cs', str: '.set'};
export const SKIP: Token = {token: 'cs', str: '.skip'};

// Tokens we match
export const BYTE: Token = {token: 'cs', str: '.byte'};
export const BYTESTR: Token = {token: 'cs', str: '.bytestr'};
export const WORD: Token = {token: 'cs', str: '.word'};

// Important operator tokens
export const COLON: Token = {token: 'op', str: ':'};
export const DCOLON: Token = {token: 'op', str: '::'};
export const COMMA: Token = {token: 'op', str: ','};
export const AND: Token = {token: 'op', str: '&'};
/** Statement terminator in an ld65 linker config. We don't use this for asm */
export const SEMI: Token = {token: 'op', str: ';'};
export const STAR: Token = {token: 'op', str: '*'};
export const IMMEDIATE: Token = {token: 'op', str: '#'};
export const ASSIGN: Token = {token: 'op', str: '='};
export const ASSIGN_LABEL: Token = {token: 'op', str: ':='};

// CS -> CS token alias map
export const CS_TOKEN_ALIAS_MAP = new Map([
  // NOTE: Only synonymous so long as 16-bit is not supported
  ['.addr', '.word'],
  // NOTE: Only synonymous so long as js65's .bankbyte differs from ca65's
  ['.bank', '.bankbyte'],
  ['.byt', '.byte'],
  ['.def', '.defined'],
  ['.delmac', '.delmacro'],
  ['.endmac', '.endmacro'],
  ['.endrep', '.endrepeat'],
  ['.exitmac', '.exitmacro'],
  ['.fopt', '.fileopt'],
  // NOTE: js65's linker always links every module fully, so forceimport
  // does nothing. Just alias it to .import for compatibility.
  ['.forceimport', '.import'],
  ['.ismnem', '.ismnemonic'],
  ['.mac', '.macro'],
  ['.ref', '.referencedsymbol'],
  ['.referenced', '.referencedsymbol'],
  ['.undef', '.undefine'],
]);

// All reserved leading dot directives that take priority over user leading dot directives
export const CS_KEYWORDS: ReadonlySet<string> = new Set([
  '.a16', '.a8', '.addr', '.addrsize', '.align', '.and', '.asciiz',
  '.asize', '.assert', '.autoimport', '.bank', '.bankbyte', '.bankbytes',
  '.bitand', '.bitnot', '.bitor', '.bitxor', '.blank', '.bss', '.byt',
  '.byte', '.byteat', '.bytestr', '.case', '.charmap', '.code', '.concat',
  '.cond', '.condes', '.const', '.constantsymbol', '.constructor',
  '.cpu', '.data', '.dbg', '.dbyt', '.debuginfo', '.def', '.define',
  '.defined', '.definedmacro', '.definedsymbol', '.delmac', '.delmacro',
  '.destructor', '.dword', '.else', '.elseif', '.end', '.endenum',
  '.endif', '.endmac', '.endmacro', '.endproc', '.endrep', '.endrepeat',
  '.endscope', '.endstruct', '.endunion', '.enum', '.eol', '.error',
  '.exitmac', '.exitmacro', '.export', '.exportzp', '.faraddr', '.fatal',
  '.feature', '.fileopt', '.fopt', '.forceimport', '.forceword', '.free',
  '.global', '.globalzp', '.hibyte', '.hibytes', '.hiword', '.i16',
  '.i8', '.ident', '.if', '.ifblank', '.ifconst', '.ifdef', '.ifnblank',
  '.ifnconst', '.ifndef', '.ifnref', '.ifnsym', '.ifp02', '.ifp4510',
  '.ifp816', '.ifpc02', '.ifpdtv', '.ifpsc02', '.ifref', '.ifsym',
  '.import', '.importzp', '.incbin', '.include', '.interruptor', '.isize',
  '.ismnem', '.ismnemonic', '.left', '.linecont', '.list', '.listbytes',
  '.literal', '.lobyte', '.lobytes', '.local', '.localchar', '.loword',
  '.mac', '.macpack', '.macro', '.match', '.max', '.mid', '.min',
  '.mod', '.move', '.noexpand', '.not', '.null', '.or', '.org', '.out',
  '.p02', '.p4510', '.p816', '.pagelen', '.pagelength', '.paramcount',
  '.pc02', '.pdtv', '.popcharmap', '.popcpu', '.popseg', '.proc',
  '.psc02', '.pushcharmap', '.pushcpu', '.pushseg', '.ref', '.referenced',
  '.referencedsymbol', '.referto', '.refto', '.reloc', '.repeat',
  '.res', '.right', '.rodata', '.scope', '.segment', '.segmentprefix',
  '.set', '.setcpu', '.shl', '.shr', '.sizeof', '.skip', '.smart',
  '.sprintf', '.strat', '.string', '.strlen', '.strmap', '.struct',
  '.tag', '.tcount', '.time', '.undef', '.undefine', '.union', '.version',
  '.warning', '.word', '.wordat', '.xmatch', '.xor', '.zeropage',
]);

export function match(left: Token, right: Token): boolean {
  if (left.token !== right.token) return false;
  if (left.token === 'num' || left.token === 'str') return true;
  if ((left as StringToken).str !== (right as StringToken).str) return false;
  // NOTE: don't compare num because 'num' already early-returned.
  return true;
}

export function eq(left: Token|undefined, right: Token|undefined): boolean {
  if (!left || !right) return false;
  if (left.token !== right.token) return false;
  if (left.token === 'grp') return false; // don't check groups.
  if ((left as StringToken).str !== (right as StringToken).str) return false;
  if ((left as NumberToken).num !== (right as NumberToken).num) return false;
  return true;
}

export function name(arg: Token): string {
  switch (arg.token) {
    case 'num': return `NUM[$${arg.num.toString(16)}]`;
    case 'str': return `STR[$${arg.str}]`;
    case 'lb': return `[`;
    case 'rb': return `]`;
    case 'grp': return `{`;
    case 'lc': return `{`;
    case 'rc': return `}`;
    case 'lp': return `(`;
    case 'rp': return `)`;
    case 'eol': return `EOL`;
    case 'eof': return `EOF`;
    case 'ident':
      return arg.str;
    case 'cs':
    case 'op':
      return `${(arg.rawStr ?? arg.str).toLowerCase()}`;
    default:
      assertNever(arg);
  }
}

/**
 * Renders a token together with its location. Only for *secondary* locations inside a
 * message ("previously defined at ...")
 * Most every kind of error should use `nameOf` instead since the source location should
 * be a part of the SourceError instead of the message text where this puts it.
 * 
 * TODO: we should expand the errors section to add a list of `notes` for handling these
 * cases better.
 */
export function nameAt(arg: {source?: SourceInfo}|undefined): string {
  if (!arg) return 'at unknown';
  const token = arg as Token;
  return (token.token ? name(token) : '') + at(arg);
}

export function nameOf(arg: {source?: SourceInfo}|undefined): string {
  if (!arg) return 'unknown';
  const token = arg as Token;
  return token.token ? name(token) : 'unknown';
}

export function expectEol(token: Token|undefined, name = 'end of line') {
  if (token) fail(`Expected ${name}: ${nameOf(token)}`, token);
}

export function expect(want: Token, token: Token, prev?: Token) {
  if (!token) {
    if (!prev) throw new Error(`Expected ${name(want)}`);
    fail(`Expected ${name(want)} after ${nameOf(prev)}`, prev);
  }
  if (!eq(want, token)) {
    fail(`Expected ${name(want)}: ${nameOf(token)}`, token);
  }
}

export function expectIdentifier(token: Token|undefined,
  prev?: Token): string {
return expectStringToken('ident', 'identifier', token, prev);
}

export function optionalIdentifier(token: Token|undefined): string|undefined {
return optionalStringToken('ident', 'identifier', token);
}

export function expectString(token: Token|undefined, prev?: Token): string {
  return expectStringToken('str', 'constant string', token, prev);
}

export function optionalString(token: Token|undefined): string|undefined {
  return optionalStringToken('str', 'constant string', token);
}

function expectStringToken(want: StringTok,
                            name: string,
                            token: Token|undefined,
                            prev?: Token): string {
  if (!token) {
    if (!prev) throw new Error(`Expected ${name}`);
    fail(`Expected ${name} after ${nameOf(prev)}`, prev);
  }
  if (token.token !== want) {
    fail(`Expected ${name}: ${nameOf(token)}`, token);
  }
  return token.str;
}

function optionalStringToken(want: StringTok,
                            name: string,
                            token: Token|undefined): string|undefined {
  if (!token) {
    return undefined;
  }
  if (token.token !== want) {
    fail(`Expected ${name}: ${nameOf(token)}`, token);
  }
  return token.str;
}

/**
 * Given a comma-separated list of identifiers, return the
 * identifiers as a list of strings.  Throws an error if
 * the input is not actually a comma-separated list.
 */
export function identsFromCList(list: Token[]): string[] {
  if (!list.length) return [];
  const out: string[] = [];
  for (let i = 0; i <= list.length; i += 2) {
    const ident = list[i];
    if (ident?.token !== 'ident') {
      if (ident) fail(`Expected identifier: ${nameOf(ident)}`, ident);
      const last = list[list.length - 1];
      fail(`Expected identifier after ${nameOf(last)}`, last);
    } else if (i + 1 < list.length && !eq(list[i + 1], COMMA)) {
      const sep = list[i + 1];
      fail(`Expected comma: ${nameOf(sep)}`, sep);
    }
    out.push(ident.str);
  }
  return out;
}

/** Finds a balanced paren/bracket: returns its index, or -1. */
export function findBalanced(tokens: Token[], i: number): number {
  const open = tokens[i++].token;
  if (open !== 'lp' && open !== 'lb') throw new Error(`non-grouping token`);
  const close = open === 'lp' ? 'rp' : 'rb';
  let depth = 1;
  for (; i < tokens.length; i++) {
    const tok = tokens[i].token;
    depth += Number(tok === open) - Number(tok === close);
    if (!depth) return i;
  }
  return -1;
}

/**
 * Splits on commas not enclosed in balanced parens. Braces are
 * ignored/not allowed at this point. This is intended for arithmetic.
 */
export function parseArgList(tokens: Token[],
                              start = 0, end = tokens.length): Token[][] {
  let arg: Token[] = [];
  const args = [arg];
  let parens = 0;
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (!parens && eq(token, COMMA)) {
      args.push(arg = []);
    } else {
      arg.push(token);
      if (eq(token, LP)) parens++;
      if (eq(token, RP)) {
        if (--parens < 0) fail(`Unbalanced paren`, token);
      }
    }
  }
  return args;
}

export function parseAttrList(tokens: Token[],
                              start: number): Map<string, Token[]> {
  // Expect a colon...
  // TODO - allow colon inside balanced parens? allow a single group?
  //   .segment "foo" :bar {foo:bar} :baz
  const out = new Map<string, Token[]>();
  let key: string|undefined;
  let val: Token[] = [];
  if (start >= tokens.length) return out;
  if (!eq(tokens[start], COLON)) {
    fail(`Unexpected: ${nameOf(tokens[start])}`, tokens[start]);
  }
  for (let i = start + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (eq(tok, COLON)) {
      if (key == null) fail(`Missing key`, tok);
      out.set(key, val);
      key = undefined;
      val = [];
    } else if (key == null) {
      key = expectIdentifier(tok);
    } else {
      val.push(tok);
    }
  }
  if (key != null) {
    out.set(key, val);
  } else {
    expectIdentifier(undefined, tokens[tokens.length - 1]);
  }
  return out;
}

/** Finds a comma or EOL. */
export function findComma(tokens: Token[], start: number): number {
  const index = find(tokens, COMMA, start);
  return index < 0 ? tokens.length : index;
}

/** Finds a token, or -1 if not found. */
export function find(tokens: Token[], want: Token, start: number): number {
  for (let i = start; i < tokens.length; i++) {
    if (eq(tokens[i], want)) return i;
  }
  return -1;
}

export function count(ts: Token[]): number {
  let total = 0;
  for (const t of ts) {
    if (t.token === 'grp') {
      total += 2 + count(t.inner);
    } else {
      total++;
    }
  }
  return total;
}

export function isRegister(t: Token, reg: 'a'|'x'|'y'): boolean {
  return t.token === 'ident' && t.str.toLowerCase() === reg;
}

/** The address size that a `z:` / `a:` / `f:` operand prefix forces. */
export type AddrSize = 'z'|'a'|'f';

/**
 * The address size `tokens[start]` forces, and the index just past the prefix,
 * if it begins one.
 *
 * The tokenizer lexes the prefix as a single operator token, so `a:+2` and a
 * `.define`d `a` cannot be mistaken for one, but a hand-built token list from
 * the programmatic API may spell it as an identifier followed by a colon.
 */
export function addrSize(tokens: Token[],
                         start: number): {size: AddrSize, next: number}|undefined {
  const front = tokens[start];
  if (!front) return undefined;
  if (front.token === 'op') {
    const match = /^([azf]):$/.exec(front.str);
    if (match) return {size: match[1] as AddrSize, next: start + 1};
  }
  if (front.token === 'ident' && /^[azf]$/i.test(front.str) &&
      eq(tokens[start + 1], COLON)) {
    return {size: front.str.toLowerCase() as AddrSize, next: start + 2};
  }
  return undefined;
}

export function str(t: Token) {
  switch (t.token) {
    case 'cs':
    case 'ident':
    case 'str':
    case 'op':
      return t.str;
  }
  fail(`Non-string token: ${nameOf(t)}`, t);
}

export function strip(t: Token): Token {
  delete t.source;
  return t;
}

export function format(toks: readonly Token[]): string {
  return toks.map(t => {
    switch (t.token) {
      case 'grp': return `{ ${format(t.inner)} }`;
      case 'lb': return '[';
      case 'lc': return '{';
      case 'lp': return '(';
      case 'rb': return ']';
      case 'rc': return '}';
      case 'rp': return ')';
      case 'eol': return '.eol';
      case 'eof': throw new Error(`Cannot format EOF`);
      case 'num': return '$' + t.num.toString(16).padStart(t.num < 256 ? 2 : 4, '0');
      case 'ident': return t.str;
      case 'op': return t.str;
      case 'cs': return t.str;
      case 'str': return `"${t.str.replace(/[\\"]/g, '\\$&')}"`;
      default: return checkExhaustive(t);
    }
  }).join(' ');
}


function checkExhaustive(arg: never): never {
  throw new Error(`was supposed to be exhaustive but got ${arg}`);
}

// interface Expr {
//   // operator, function name, '()', '{}', 'num', 'str', 'ident'
//   op: string;
//   // one arg for a unary, two for binary, or N for comma or function
//   args: Expr[];
//   // if op === 'num'
//   num: number;
//   // if op === 'str' or 'ident'
//   str: string;
// }

export const TOKENFUNCS = new Set([
  '.blank',
  '.const',
  '.defined',
  '.left',
  '.match',
  '.mid',
  '.right',
  '.tcount',
  '.xmatch',
]);

export const DIRECTIVES = [
  '.a8',
  '.define',
  '.else',
  '.elseif',
  '.endif',
  '.endmacro',
  '.endproc',
  '.endscope',
  '.i8',
  '.ident',
  '.if',
  '.ifblank',
  '.ifdef',
  '.ifnblank',
  '.ifndef',
  '.ifnref',
  '.ifp02',
  '.ifp4510',
  '.ifp816',
  '.ifpc02',
  '.ifpdtv',
  '.ifpsc02',
  '.ifref',
  '.incbin',
  '.include',
  '.local',
  '.macpack',
  '.macro',
  '.p02',
  '.proc',
  '.scope',
  '.skip',
] as const;
