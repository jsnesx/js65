
// SPDX-License-Identifier: MPL-2.0

import {Buffer} from './buffer.ts';
import {type Token} from './token.ts'
import * as Tokens from './token.ts';
import { SourceContents } from './tokenstream.ts';
import { ErrorCollector } from './error.ts';
import { reportLint, SUSPICIOUS_LINE_CONTINUATION } from './lint.ts';
import { type TokenizerOptions } from './options.ts';

export type { TokenizerOptions as Options };

const NEWLINE = /(\r\n|\n|\r)/y;

// Each of these regexes use the `y` flag to mark the regex as sticky.
// This means if you run the regex with the same input multiple times,
// it will start scanning from the last found index. This saves SO much
// time as it will not need to start from the beginning of the string,
// nor do we need to reallocate the string with a slice.
const RE_COMMENT = /;.*/y;
const RE_LINE_CONT = /\\(\r\n|\n|\r)/y;
const RE_BLOCK_COMMENT = /\/\*[^]*?\*\//y;
const RE_BLOCK_COMMENT_OPEN = /\/\*/y;
const RE_REST_OF_FILE = /[^]*/y;
const RE_AT_IDENT = /@+[a-z0-9_]*/iy;
// Notably missing from the IDENT is the scope :: qualifier, since this
// is actually treated as a separate token in ca65. We glue it back together
// later in the preprocessor with mergeScopePrefix
const RE_IDENT = /[a-z_][a-z0-9_]*/iy;
// Allow _ in here for user defined directives
const RE_CS = /\.[a-z_][a-z0-9_]*/iy;
const RE_LOCAL_LABEL = /:([+-]\d+|[-+]+|<+rts|>*rts)/y;
const RE_OPERATOR = /(::|:=|:|\++|-+|&&?|\|\|?|[#*/,=~!^]|<[<>=]?|>[>=]?)/y;
const RE_STRING_START = /["']/y;
const RE_UNICODE_ESC = /\\u([0-9a-f]{4})/iy;
const RE_HEX_ESC = /\\x([0-9a-f]{2})/iy;
const RE_CHAR_ESC = /\\(.)/y;
const RE_ANY = /./y;
// Used to check if we have a \ with a space before a newline `\ \n` which is a lint warning
const RE_SEP_AT_EOL = /[ \t]*(;[^\n\r]*)?(\r\n|\n|\r|$)/y;

/** Anything a numeric literal can be written with, used to spot a bad digit. */
function isNumberChar(c: number): boolean {
  return c >= 0x30 /* 0 */ && c <= 0x39 /* 9 */ ||
      c >= 0x61 /* a */ && c <= 0x7a /* z */ ||
      c >= 0x41 /* A */ && c <= 0x5a /* Z */ ||
      c === 0x5f /* _ */;
}

function isDecDigit(c: number): boolean {
  return c >= 0x30 /* 0 */ && c <= 0x39 /* 9 */;
}

/** Hex is written in either case, `$ff` and `$FF`. */
function isHexDigit(c: number): boolean {
  if (c >= 0x30 /* 0 */ && c <= 0x39 /* 9 */) return true;
  c |= 0x20; // ASCII lowercase
  return c >= 0x61 /* a */ && c <= 0x66 /* f */;
}

function isBinDigit(c: number): boolean {
  return c === 0x30 /* 0 */ || c === 0x31 /* 1 */;
}

export class Tokenizer implements Tokens.Source {
  readonly buffer: Buffer;

  constructor(str: string,
              readonly file = 'input.s',
              readonly opts: TokenizerOptions = {},
              readonly sourceContents?: SourceContents,
              readonly errorCollector?: ErrorCollector) {
    this.buffer = new Buffer(str);
    this.sourceContents?.data?.set(file, str);
  }

  next(): Token[]|undefined {
    return this.nextSync();
  }

  protected nextSync(): Token[]|undefined {
    // We want to recover from any weird tokenizer errors if we have an error collector.
    // note that the linker config expects to throw here annoyingly, we need to fix that later.
    for (;;) {
      try {
        return this.nextLine();
      } catch (err) {
        if (!this.recoversFromTokenErrors || !this.errorCollector ||
            !(err instanceof Tokens.SourceError)) {
          throw err;
        }
        this.errorCollector.addFromException(err);
        // exit when we reach EOF
        if (!this.skipLine()) return undefined;
      }
    }
  }

  /** Hacky workaround to keep the linker config throwing on error */
  protected get recoversFromTokenErrors(): boolean { return true; }

  /**
   * Discard what is left of the current source line after a token error.
   * Returns false once the buffer is exhausted.
   */
  private skipLine(): boolean {
    // We have to use the tokenizer here since we can't assume the end of the line
    // is the end of the token line (for instance multiline comments/line continuations/etc)
    while (!this.buffer.eof()) {
      const pos = this.buffer.pos;
      try {
        if (Tokens.eq(this.token(), Tokens.EOL)) return !this.buffer.eof();
      } catch (err) {
        if (!(err instanceof Tokens.SourceError)) throw err;
      }
      // if the tokenizer didn't make progress, its probably something else bad on the line
      // so we just consume the next line and keep rolling.
      if (this.buffer.pos === pos) this.buffer.token(RE_ANY);
    }
    return false;
  }

  private nextLine(): Token[]|undefined {
    let tok = this.token();
    while (Tokens.eq(tok, Tokens.EOL)) {
      // Skip EOLs at beginning of line.
      tok = this.token();
    }
    // Group curly brace groups into a single effective Tokens.
    const stack: Token[][] = [[]];
    let depth = 0;
    while (!Tokens.eq(tok, Tokens.EOL) && !Tokens.eq(tok, Tokens.EOF)) {
      if (Tokens.eq(tok, Tokens.LC)) {
        stack[depth++].push(tok);
        stack.push([]);
      } else if (Tokens.eq(tok, Tokens.RC)) {
        if (!depth) {
          // Missing open curly - record error and skip the close brace
          this.errorCollector?.add('error', `Missing open curly`, tok.source);
        } else {
          const inner = stack.pop()!;
          const source = stack[--depth].pop()!.source;
          const token: Token = {token: 'grp', inner};
          if (source) token.source = source;
          stack[depth].push(token);
        }
      } else {
        stack[depth].push(tok);
      }
      tok = this.token();
    }
    // Auto-close any unclosed braces at EOL
    while (depth > 0) {
      const open = stack[depth - 1].pop()!;
      this.errorCollector?.add('error', `Missing close curly`, open.source);
      const inner = stack.pop()!;
      const source = open.source;
      const token: Token = {token: 'grp', inner};
      if (source) token.source = source;
      stack[--depth].push(token);
    }
    return stack[0].length ? stack[0] : undefined;
  }

  /**
   * Overridable because a linker config uses `;` as a line terminator, so
   * what gets ignored is different between the two.
   */
  protected skipIgnored(): void {
    const buf = this.buffer;
    for (;;) {
      // Nothing is skippable unless it starts with one of these, and most tokens
      // don't, so dispatch on the character instead of trying each pattern.
      switch (buf.content.charCodeAt(buf.pos)) {
        case 0x20 /* space */: case 0x09 /* tab */:
          buf.space();
          continue;
        case 0x3b /* ; */:
          buf.token(RE_COMMENT);
          if (this.opts.lintPragmas) {
            const comment = buf.match()!;
            this.opts.lintPragmas.record(this.file, comment.line, comment[0]);
          }
          continue;
        case 0x5c /* \ */:
          if (this.opts.lineContinuations && buf.token(RE_LINE_CONT)) continue;
          return;
        case 0x2f /* / */:
          if (this.opts.cComments && this.blockComment()) continue;
          return;
        default:
          return;
      }
    }
  }

  private blockComment(): boolean {
    if (!this.buffer.lookingAt(RE_BLOCK_COMMENT_OPEN)) return false;
    const source = {
      file: this.file,
      line: this.buffer.line,
      column: this.buffer.column,
    };
    if (this.buffer.token(RE_BLOCK_COMMENT)) return true;
    // No closing `*/`. Swallow the rest of the file rather than tokenizing the
    // comment body as code, and report where the comment started.
    this.buffer.token(RE_REST_OF_FILE);
    this.unterminated(`Unterminated comment, expected */`, source);
    return true;
  }

  /** Handle hex/bin/dec prefixed numeric types and separators while we are at it.
   * needs to be overridable for linker configs where theres no binary `%`
   */
  protected matchNumber(): Token|undefined {
    const s = this.buffer.content;
    const start = this.buffer.pos;
    const sep = this.opts.numberSeparators;
    let p = start;
    let digits = 0;
    switch (s.charCodeAt(p)) {
      case 0x24 /* $ */: {
        for (p++;; p++) {
          const c = s.charCodeAt(p);
          if (isHexDigit(c)) digits++;
          else if (!(sep && c === 0x5f /* _ */)) break;
        }
        if (p === start + 1 && !isNumberChar(s.charCodeAt(p))) return undefined;
        const text = this.numDigits(start, start + 1, p, digits, 'hex');
        return {token: 'num', num: +('0x' + text), width: Math.ceil(digits / 2), radix: 16};
      }
      case 0x25 /* % */: {
        for (p++;; p++) {
          const c = s.charCodeAt(p);
          if (isBinDigit(c)) digits++;
          else if (!(sep && c === 0x5f /* _ */)) break;
        }
        if (p === start + 1 && !isNumberChar(s.charCodeAt(p))) return undefined;
        const text = this.numDigits(start, start + 1, p, digits, 'binary');
        return {token: 'num', num: +('0b' + text), width: Math.ceil(digits / 8), radix: 2};
      }
      default: {
        for (;; p++) {
          const c = s.charCodeAt(p);
          if (isDecDigit(c)) digits++;
          else if (!(sep && c === 0x5f /* _ */)) break;
        }
        const text = this.numDigits(start, start, p, digits, 'decimal');
        return {token: 'num', num: +text, radix: 10};
      }
    }
  }

  /**
   * Creates the actual substring that was holding the number and preps it for
   * converting into an actual value by replacing separators and so on.
   */
  private numDigits(start: number, digitsAt: number, end: number, count: number,
                    name: string): string {
    const buf = this.buffer;
    const s = buf.content;
    if (count && !isNumberChar(s.charCodeAt(end))) {
      const str = s.substring(start, end);
      buf.punct(str);
      const text = digitsAt === start ? str : s.substring(digitsAt, end);
      return count === end - digitsAt ? text : text.replaceAll('_', '');
    }
    // Take the rest of the run as well, so the error quotes the whole of what
    // was written where a number belonged.
    let p = end;
    while (isNumberChar(s.charCodeAt(p))) p++;
    const str = s.substring(start, p);
    buf.punct(str);
    // The message quotes the literal as it was read, minus any separators.
    throw new Error(
        `Bad ${name} number: ${this.opts.numberSeparators ? str.replaceAll('_', '') : str}`);
  }

  protected matchOperator(): Token|undefined {
    return this.buffer.token(RE_OPERATOR) ? this.strTok('op') : undefined;
  }

  protected matchAddrSize(c: number): Token|undefined {
    // we already know it starts with a/z/f we just want to know if its a:: for a scope
    const buf = this.buffer;
    if (buf.content.charCodeAt(buf.pos + 1) !== 0x3a /* : */) return undefined;
    if (buf.content.charCodeAt(buf.pos + 2) === 0x3a /* : */) return undefined;
    const str = c === 0x61 /* a */ || c === 0x41 /* A */ ? 'a:' :
        c === 0x7a /* z */ || c === 0x5a /* Z */ ? 'z:' : 'f:';
    buf.punct(str);
    return {token: 'op', str};
  }

  /** `a`, `x` and `y` name registers, in either case. */
  protected isRegister(c: number): boolean {
    c |= 0x20; // ASCII lowercase
    return c === 0x61 /* a */ || c === 0x78 /* x */ || c === 0x79 /* y */;
  }

  // Base case when a token "matched" something but failed to get processed.
  // In the base class we error out, but linkercfg can use this to handle %o
  protected tokenOther(_c: number): Token {
    // Get the raw text so the error says what it choked on.
    const ch = this.buffer.content[this.buffer.pos];
    throw new Error(`Syntax error${ch ? `: unexpected '${ch}'` : ''}`);
  }

  protected token(): Token {
    // skip whitespace
    this.skipIgnored();
    if (this.buffer.eof()) return Tokens.EOF;

    // remember position of non-whitespace
    const source: Tokens.SourceInfo = {
      file: this.file,
      line: this.buffer.line,
      column: this.buffer.column,
    };
    try {
      const tok = this.tokenInternal();
      if (this.opts.generateDebugInfo) {
        // Record the end position for the last token which is useful for the LSP
        source.endLine = this.buffer.line;
        source.endColumn = this.buffer.column;
      }
      tok.source = source;
      return tok;
    } catch (err:any) {
      // Add a `near` part to the message if we know what the last token was.
      // But only if the line matches so we don't blame an innocent line if
      // the error was so crazy that ruined the rest of the line.
      const match = this.buffer.match();
      const last = match && match.line === source.line &&
          match.column === source.column ? match[0] : undefined;
      const located = new Tokens.SourceError(
          `${err.message}${last ? ` near '${last}'` : ''}`, source);
      located.stack = err.stack;
      throw located;
    }
  }

  /** Checks the first character of each token to determine how to process it. */
  protected tokenInternal(): Token {
    const buf = this.buffer;
    const c = buf.content.charCodeAt(buf.pos);
    if (c >= 0x61 /* a */ && c <= 0x7a /* z */ ||
        c >= 0x41 /* A */ && c <= 0x5a /* Z */ ||
        c === 0x5f /* _ */) {
      return this.tokenIdent(c);
    }
    if (c >= 0x30 /* 0 */ && c <= 0x39 /* 9 */ ||
        c === 0x24 /* $ */ || c === 0x25 /* % */) {
      return this.matchNumber() ?? this.tokenOther(c);
    }
    switch (c) {
      case 0x0a /* \n */:
      case 0x0d /* \r */:
        buf.newline();
        return {token: 'eol'};
      case 0x40 /* @ */:
        // An `@` ident can never be a register, so there is no case to normalize.
        buf.token(RE_AT_IDENT);
        return this.strTok('ident');
      case 0x2e /* . */:
        // A `.` that starts no directive is a stray, as in `.2`.
        if (buf.token(RE_CS)) return this.csTok();
        return this.tokenOther(c);
      case 0x22 /* " */: case 0x27 /* ' */:
        buf.token(RE_STRING_START);
        return this.tokenizeStr();
      case 0x5b /* [ */: buf.punct('['); return {token: 'lb'};
      case 0x7b /* { */: buf.punct('{'); return {token: 'lc'};
      case 0x28 /* ( */: buf.punct('('); return {token: 'lp'};
      case 0x5d /* ] */: buf.punct(']'); return {token: 'rb'};
      case 0x7d /* } */: buf.punct('}'); return {token: 'rc'};
      case 0x29 /* ) */: buf.punct(')'); return {token: 'rp'};
      case 0x5c /* \ */:
        // `skipIgnored` takes a backslash that continues a line, and only with the
        // feature on, so whatever reaches here either ends a statement or is stray.
        if (this.opts.backslashSeparator) return this.separator('\\');
        throw new Error(this.opts.lineContinuations ?
            `Expected a line break after '\\'` :
            `Unexpected '\\'; line_continuations is off`);
      case 0x60 /* ` */:
        if (this.opts.backtickSeparator) return this.separator('`');
        return this.tokenOther(c);
      case 0x3a /* : */:
        // A local label (`:+`, `:-`, `:rts`) outranks the `:` operator.
        if (buf.token(RE_LOCAL_LABEL)) return this.strTok('ident');
        // fall through to check for `:=` `::` etc
      case 0x2b /* + */:
      case 0x2d /* - */:
      case 0x26 /* & */:
      case 0x7c /* | */:
      case 0x23 /* # */:
      case 0x2a /* * */:
      case 0x2f /* / */:
      case 0x2c /* , */:
      case 0x3d /* = */:
      case 0x7e /* ~ */:
      case 0x21 /* ! */:
      case 0x5e /* ^ */:
      case 0x3c /* < */:
      case 0x3e /* > */:
        return this.matchOperator() ?? this.tokenOther(c);
    }
    return this.tokenOther(c);
  }

  private separator(ch: string): Token {
    const buf = this.buffer;
    const source = {file: this.file, line: buf.line, column: buf.column};
    buf.punct(ch);
    // Check to see if we have a `\ \n` pattern which is too close to a line
    // continuation, and it may be a mistake.
    if (ch === '\\')
      this.separatorAtEol(source);
    return {token: 'eol'};
  }

  private separatorAtEol(source: Tokens.SourceInfo): void {
    RE_SEP_AT_EOL.lastIndex = this.buffer.pos;
    const rest = RE_SEP_AT_EOL.exec(this.buffer.content);
    if (!rest) return;
    // `skipIgnored` does not reach this line's comment until after the
    // separator is returned, so a pragma there is not recorded yet.
    if (rest[1])
      this.opts.lintPragmas?.record(this.file, source.line, rest[1]);
    reportLint(SUSPICIOUS_LINE_CONTINUATION,
               this.opts.lineContinuations ?
                   '`\\` must be followed immediately by a line break to ' +
                   'continue a line. The whitespace after it makes this a ' +
                   'statement separator, so the next line is a separate ' +
                   'statement. Remove the whitespace to continue the line.' :
                   'this `\\` is a statement separator at the end of a line, ' +
                   'so it separates nothing and can be removed.',
               source, this.errorCollector, this.opts.lint, this.opts.lintPragmas);
  }

  private tokenIdent(c: number): Token {
    // Check first for addrSize since that takes priority over labels
    if (c === 0x61 /* a */ || c === 0x7a /* z */ || c === 0x66 /* f */ ||
        c === 0x41 /* A */ || c === 0x5a /* Z */ || c === 0x46 /* F */) {
      const addrSize = this.matchAddrSize(c);
      if (addrSize) return addrSize;
    }
    this.buffer.token(RE_IDENT);
    const tok = this.strTok('ident') as Tokens.StringToken;
    if (tok.str.length === 1 && this.isRegister(c)) {
      tok.str = tok.str.toLowerCase();
    }
    return tok;
  }

  private tokenizeStr(): Token {
    const b = this.buffer;
    const m = b.match()!;
    const end = m[0];
    let str = '';
    while (!b.lookingAt(end)) {
      // Strings don't span lines, so running into a newline (or the end of the
      // file) means the terminator is missing. Report it and pretend the string
      // ended here, leaving the newline in the buffer so the rest of the file
      // still tokenizes normally.
      if (b.eof() || b.lookingAt(NEWLINE)) {
        this.unterminated(`Unterminated string, expected ${end}`,
                          {file: this.file, line: m.line, column: m.column});
        return this.makeStrToken(end, str);
      }
      if (b.token(RE_UNICODE_ESC)) {
        str += String.fromCodePoint(parseInt(b.group(1)!, 16));
      } else if (b.token(RE_HEX_ESC)) {
        str += String.fromCharCode(parseInt(b.group(1)!, 16));
      } else if (b.token(RE_CHAR_ESC)) {
        str += b.group(1)!;
      } else {
        b.token(RE_ANY);
        str += b.group(0)!;
      }
    }
    b.tokenStr(end);
    return this.makeStrToken(end, str);
  }

  /** mark single quoted strings as 'char' so they can be used as numeric literals later */
  private makeStrToken(quote: string, str: string): Token {
    return quote === `'` ? {token: 'str', str, char: true} : {token: 'str', str};
  }

  /**
   * Records a missing string terminator. If we have an error collector, then treat
   * it as a recoverable error by marking the end of line as the end of the string,
   * and continue processing.
   */
  private unterminated(message: string, source: Tokens.SourceInfo): void {
    if (!this.errorCollector) throw new Tokens.SourceError(message, source);
    this.errorCollector.add('error', message, source);
  }

  protected strTok(token: Tokens.StringToken['token']): Token {
    return {token, str: this.buffer.group()!};
  }

  private csTok(): Token {
    let grp = this.buffer.group()!;
    const lower = grp.toLowerCase();
    if (this.opts.leadingDotInIdentifiers && !Tokens.CS_KEYWORDS.has(lower)) {
      return {token: 'ident', str: lower};
    }
    return {
      token: 'cs', 
      str: Tokens.CS_TOKEN_ALIAS_MAP.get(grp.toLowerCase()) ?? grp.toLowerCase(),
      rawStr: grp,
    };
  }

}

