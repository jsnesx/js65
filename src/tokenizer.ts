
// SPDX-License-Identifier: MPL-2.0

import {Buffer} from './buffer.ts';
import {type Token} from './token.ts'
import * as Tokens from './token.ts';
import { SourceContents } from './tokenstream.ts';
import { ErrorCollector } from './assembler.ts';

const NEWLINE = /^(\r\n|\n|\r)/;

export class Tokenizer implements Tokens.Source {
  readonly buffer: Buffer;

  constructor(str: string,
              readonly file = 'input.s',
              readonly opts: Options = {},
              readonly sourceContents?: SourceContents,
              readonly errorCollector?: ErrorCollector) {
    this.buffer = new Buffer(str);
    this.sourceContents?.data?.set(file, str);
  }

  async next(): Promise<Token[]|undefined> {
    return this.nextSync();
  }

  protected nextSync(): Token[]|undefined {
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
           this.buffer.token(/^;.*/) ||
           (this.opts.lineContinuations && this.buffer.token(/^\\(\r\n|\n|\r)/))) {
            // intentionally empty
           }
  }

  /** `%` is a binary literal prefix in ca65, but used for special `%O` and `%S` flags in linkercfg. */
  protected numberRegex(): RegExp { return /^[$%]?[0-9a-z_]+/i; }

  protected operatorRegex(): RegExp {
    return /^(:=|:|\++|-+|&&?|\|\|?|[#*/,=~!^]|<[<>=]?|>[>=]?)/;
  }

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
      if (this.opts.generateDebugInfo) {
        tok.source = source;
      }
      return tok;
    } catch (err:any) {
      // Add a `near` part to the message if we know what the last token was
      const last = this.buffer.group();
      const located = new Tokens.SourceError(
          `${err.message}${last ? ` near '${last}'` : ''}`, source);
      located.stack = err.stack;
      throw located;
    }
  }

  protected tokenInternal(): Token {
    if (this.buffer.newline()) return {token: 'eol'};
    if (this.buffer.token(/^@+[a-z0-9_]*/i) ||
        this.buffer.token(/^((::)?[a-z_][a-z0-9_]*)+/i)) {
      return this.strTok('ident');
    }
    if (this.buffer.token(/^\.[a-z][a-z0-9]*/i)) return this.csTok();
    if (this.buffer.token(/^:([+-]\d+|[-+]+|<+rts|>*rts)/)) return this.strTok('ident');
    if (this.buffer.token(this.operatorRegex())) {
      const op = this.strTok('op');
      // the := is just like = but it marks it as a label in the dbg file.
      // which we don't support so just treat it as = for now.
      if ((op as Tokens.StringToken).str === ':=') return {token: 'op', str: '='};
      return op;
    }
    if (this.buffer.token('[')) return {token: 'lb'};
    if (this.buffer.token('{')) return {token: 'lc'};
    if (this.buffer.token('(')) return {token: 'lp'};
    if (this.buffer.token(']')) return {token: 'rb'};
    if (this.buffer.token('}')) return {token: 'rc'};
    if (this.buffer.token(')')) return {token: 'rp'};
    if (this.buffer.token(/^["']/)) return this.tokenizeStr();
    if (this.buffer.token(this.numberRegex())) return this.tokenizeNum();
    throw new Error(`Syntax error`);
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
      if (b.token(/^\\u([0-9a-f]{4})/i)) {
        str += String.fromCodePoint(parseInt(b.group(1)!, 16));
      } else if (b.token(/^\\x([0-9a-f]{2})/i)) {
        str += String.fromCharCode(parseInt(b.group(1)!, 16));
      } else if (b.token(/^\\(.)/)) {
        str += b.group(1)!;
      } else {
        b.token(/^./);
        str += b.group(0)!;
      }
    }
    b.token(end);
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

/**
 * Options for assembly and linking
 *
 * includePaths: when a file is included, the file path will be appended to each include path
 *               and will attempt to be loaded from the FS callbacks.
 *
 * lineContinuations: if enabled, the assembler will allow the `\` to escape a newline to continue
 *               a single line declaration across multiple lines.
 *
 * numberSeparators: if enabled, you can use the single quote `'` character as an arbitrary number separator
 *
 * generateDebugInfo: when enabled, information from the source files are stored for linking in a `SourceContents`
 *               class. Passing this class into the linker will allow it to generate a `mlb` file
 *               with symbols for linking
 */
export interface Options {
  includePaths?: string[];
  /** Search path for `.incbin`.*/
  binIncludePaths?: string[];
  // caseInsensitive?: boolean; // handle elsewhere?
  lineContinuations?: boolean;
  numberSeparators?: boolean;
  generateDebugInfo?: boolean;
}

