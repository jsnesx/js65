
// SPDX-License-Identifier: MPL-2.0

import {Buffer} from './buffer.ts';
import {type Token} from './token.ts'
import * as Tokens from './token.ts';
import { SourceContents } from './tokenstream.ts';
import { ErrorCollector } from './error.ts';
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
const RE_CS = /\.[a-z][a-z0-9]*/iy;
const RE_ADDR_SIZE = /[azf]:(?!:)/iy;
/** Non-sticky as it tests a whole identifier, not a slice of the buffer. */
const RE_REGISTER = /^[axy]$/i;
const RE_LOCAL_LABEL = /:([+-]\d+|[-+]+|<+rts|>*rts)/y;
const RE_NUMBER = /[$%]?[0-9a-z_]+/iy;
const RE_OPERATOR = /(::|:=|:|\++|-+|&&?|\|\|?|[#*/,=~!^]|<[<>=]?|>[>=]?)/y;
const RE_STRING_START = /["']/y;
const RE_UNICODE_ESC = /\\u([0-9a-f]{4})/iy;
const RE_HEX_ESC = /\\x([0-9a-f]{2})/iy;
const RE_CHAR_ESC = /\\(.)/y;
const RE_ANY = /./y;

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

  async next(): Promise<Token[]|undefined> {
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
    while (this.buffer.space() ||
           this.buffer.token(RE_COMMENT) ||
           (this.opts.lineContinuations && this.buffer.token(RE_LINE_CONT)) ||
           (this.opts.cComments && this.blockComment())) {
            // intentionally empty
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

  /** `%` is a binary literal prefix in ca65, but used for special `%O` and `%S` flags in linkercfg. */
  protected numberRegex(): RegExp { return RE_NUMBER; }

  protected operatorRegex(): RegExp { return RE_OPERATOR; }
  protected addressSizeRegex(): RegExp|undefined { return RE_ADDR_SIZE; }
  protected registerRegex(): RegExp|undefined { return RE_REGISTER; }

  protected token(): Token {
    // skip whitespace
    this.skipIgnored();
    if (this.buffer.eof()) return Tokens.EOF;

    // remember position of non-whitespace
    const source = {
      file: this.file,
      line: this.buffer.line,
      column: this.buffer.column,
    };
    try {
      const tok = this.tokenInternal();
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

  protected tokenInternal(): Token {
    if (this.buffer.newline()) return {token: 'eol'};
    const addrSize = this.addressSizeRegex();
    if (addrSize && this.buffer.token(addrSize)) {
      return {token: 'op', str: this.buffer.group()!.toLowerCase()};
    }
    if (this.buffer.token(RE_AT_IDENT) ||
        this.buffer.token(RE_IDENT)) {
      const tok = this.strTok('ident') as Tokens.StringToken;
      // normalize the case for A/X/Y registers as they can be mixed Upper and lower case.
      if (this.registerRegex()?.test(tok.str)) tok.str = tok.str.toLowerCase();
      return tok;
    }
    if (this.buffer.token(RE_CS)) return this.csTok();
    if (this.buffer.token(RE_LOCAL_LABEL)) return this.strTok('ident');
    if (this.buffer.token(this.operatorRegex())) {
      return this.strTok('op');
    }
    if (this.buffer.tokenStr('[')) return {token: 'lb'};
    if (this.buffer.tokenStr('{')) return {token: 'lc'};
    if (this.buffer.tokenStr('(')) return {token: 'lp'};
    if (this.buffer.tokenStr(']')) return {token: 'rb'};
    if (this.buffer.tokenStr('}')) return {token: 'rc'};
    if (this.buffer.tokenStr(')')) return {token: 'rp'};
    if (this.buffer.token(RE_STRING_START)) return this.tokenizeStr();
    if (this.buffer.token(this.numberRegex())) return this.tokenizeNum();
    // Couldn't find any relevant type of token, so get the raw text as the error
    const ch = this.buffer.content[this.buffer.pos];
    throw new Error(`Syntax error${ch ? `: unexpected '${ch}'` : ''}`);
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
    return {
      token: 'cs', 
      str: Tokens.CS_TOKEN_ALIAS_MAP.get(grp.toLowerCase()) ?? grp.toLowerCase(),
      rawStr: grp,
    };
  }

  protected tokenizeNum(str: string = this.buffer.group()!): Token {
    if (this.opts.numberSeparators) str = str.replace(/_/g, '');
    if (str[0] === '$') return parseHex(str.substring(1));
    if (str[0] === '%') return parseBin(str.substring(1));
    return parseDec(str);
  }
}

function parseHex(str: string): Token {
  if (!/^[0-9a-f]+$/i.test(str)) throw new Error(`Bad hex number: $${str}`);
  return {token: 'num', num: Number.parseInt(str, 16), width: Math.ceil(str.length / 2)};
}

function parseDec(str: string): Token {
  if (!/^[0-9]+$/.test(str)) throw new Error(`Bad decimal number: ${str}`);
  return {token: 'num', num: Number.parseInt(str, 10)};
}

function parseBin(str: string): Token {
  if (!/^[01]+$/.test(str)) throw new Error(`Bad binary number: %${str}`);
  return {token: 'num', num: Number.parseInt(str, 2), width: Math.ceil(str.length / 8)};
}


