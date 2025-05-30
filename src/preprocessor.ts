
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {vsprintf} from 'sprintf-js';
import {Define} from './define.ts';
import type { Expr } from './expr.ts';
import * as Exprs from './expr.ts';
import {Macro} from './macro.ts';
import type { Token } from './token.ts';
import * as Tokens from './token.ts';
import {TokenStream} from './tokenstream.ts';

// TODO - figure out how to actually keep track of stack depth?
//  - might need to insert a special token at the end of an expansion
//    to know when to release the frame?
const MAX_STACK_DEPTH = 100;

// interface TokenSource {
//   next(): Token[];
//   include(file: string): Promise<void>;
//   unshift(...lines: Token[][]): void;
//   enter(): void;
//   exit(): void;
//   //options(): Tokenizer.Options;
// }

// Since the Env is most closely tied to the Assembler, we tie the
// unique ID generation to it as well, without adding additional
// constraints on the Assembler API.
const ID_MAP = new WeakMap<Env, {next(): number}>();
function idGen(env: Env): {next(): number} {
  let id = ID_MAP.get(env);
  if (!id) ID_MAP.set(env, id = (num => ({next: () => num++}))(0));
  return id;
}

interface Env {
  // These need to come from Processor and will depend on scope...
  definedSymbol(sym: string): boolean;
  constantSymbol(sym: string): boolean;
  referencedSymbol(sym: string): boolean;
  evaluate(expr: Expr): number|undefined;
  assignSym(line: Token[]): void;
  setSym(line: Token[]): void;
  // also want methods to apply shunting yard to token list?
  //  - turn it into a json tree...?
}

// export abstract class Abstract implements Source {
//   // TODO - move pump() into here, refactor Preprocessor as a TokenSource
//   // TODO - rename Processor into Assembler, fix up the clunky methods
//   //      - add line(Token[]), tokens(TokenSource) and asyncTokens(ATS)
//   //        the latter returns Promise<void> and must be awaited.
//   // Delegate the 

//   abstract pump(): Generator<Token[]|undefined>;
// }

export class Preprocessor implements Tokens.Source {
  private readonly macros: Map<string, Define|Macro|string>;
  private sink: AsyncGenerator<Token[]|undefined>|undefined;

  // builds up repeating tokens...
  private repeats: Array<[Token[][], number, number, string?]> = [];
  // NOTE: there is no scope here... - not for macros
  //  - only symbols have scope
  // TODO - evaluate constants...

  constructor(readonly stream: TokenStream, readonly env: Env,
              parent?: Preprocessor) {
    this.macros = parent ? parent.macros : new Map();
  }

  
  async tokens() {
    const tokens = [];
    let tok;
    while ((tok = await this.next())) {
      tokens.push(tok);
    }
    return tokens;
  }

  async next(): Promise<Token[] | undefined> {
    while (true) {
      if (!this.sink) this.sink = await this.pump();
      const {value, done} = await this.sink.next();
      if (!done) return value;
      this.sink = undefined;
    }
  }

  // For use as a token source in the next stage.
  async * pump(): AsyncGenerator<Token[]|undefined> {
    const line = await this.readLine();
    if (line == null) return void (yield line); // EOF
    while (line.length) {
      const front = line[0];
      switch (front.token) {
        case 'ident':
          // Possibilities: (1) label, (2) instruction/assign, (3) macro
          // Labels get split out.  We don't distinguish assigns yet.
          if (Tokens.eq(line[1], Tokens.COLON)) {
            yield line.splice(0, 2);
            break;
          }
          if (Tokens.eq(line[1], Tokens.ASSIGN)) {
            this.env.assignSym(line);
          } else if (Tokens.eq(line[1], Tokens.SET)) {
            this.env.setSym(line);
          }
          if (!this.tryExpandMacro(line)) yield line;
          return;

        case 'cs':
          if (!(await this.tryRunDirective(line))) yield line;
          return;

        case 'op':
          // Probably an anonymous label...
          if (/^[-+]+$/.test(front.str)) {
            const label: Token[] = [front];
            const second = line[1];
            if (second && Tokens.eq(second, Tokens.COLON)) {
              label.push(second);
              line.splice(0, 2);
            } else {
              label.push({token: 'op', str: ':'});
              line.splice(0, 1);
            }
            yield label;
            break;
          } else if (front.str === ':') {
            yield line.splice(0, 1);
            break;
          }
          /* fallthrough */
        default:
          throw new Error(`Unexpected: ${Tokens.nameAt(line[0])}`);
      }
    }
  }

  // Expand a single line of tokens from the front of toks.
  private async readLine(): Promise<Token[]|undefined> {
    // Apply .define expansions as necessary.
    const line = await this.stream.next();
    if (line == null) return line;
    return this.expandLine(line);
  }

  ////////////////////////////////////////////////////////////////
  // EXPANSION

  private expandLine(line: Token[], pos = 0): Token[] {
    const front = line[0];
    let depth = 0;
    let maxPos = 0;
    while (pos < line.length) {
      if (pos > maxPos) {
        maxPos = pos;
        depth = 0;
      } else if (depth++ > MAX_STACK_DEPTH) {
        throw new Error(`Maximum expansion depth reached: ${
                         line.map(Tokens.name).join(' ')}${Tokens.at(front)}`);
      }
      pos = this.expandToken(line, pos);
    }
    return line;
  }

  /** Returns the next position to expand. */
  private expandToken(line: Token[], pos: number): number {
    const front = line[pos]!;
    if (front.token === 'ident') {
      const define = this.macros.get(front.str);
      if (define instanceof Define) {
        const overflow = define.expand(line, pos);
//console.log('post-expand', line);
        if (overflow) {
          if (overflow.length) this.stream.unshift(...overflow)
          return pos;
        }
      }
    } else if (front.token === 'cs') {
      return this.expandDirective(front.str, line, pos);
    }
    return pos + 1;
  }

  tryExpandMacro(line: Token[]): boolean {
    const [first] = line;
    if (first.token !== 'ident') throw new Error(`impossible`);
    const macro = this.macros.get(first.str);
    if (!(macro instanceof Macro)) return false;
    const expansion = macro.expand(line, idGen(this.env));
    this.stream.enter();
    this.stream.unshift(...expansion); // process them all over again...
    return true;
  }

  private expandDirective(directive: string, line: Token[], i: number): number {
    switch (directive) {
      case '.define': 
      case '.ifdef':  
      case '.ifndef': 
      case '.undefine':
        return this.skipIdentifier(line, i);
      case '.skip': return this.skip(line, i);
      case '.noexpand': return this.noexpand(line, i);
      case '.tcount': return this.parseArgs(line, i, 1, this.tcount);
      case '.ident': return this.parseArgs(line, i, 1, this.ident);
      case '.string': return this.parseArgs(line, i, 1, this.string);
      case '.concat': return this.parseArgs(line, i, 0, this.concat);
      case '.sprintf': return this.parseArgs(line, i, 0, this.sprintf);
      case '.cond': return this.parseArgs(line, i, 0, this.cond);
      case '.blank':
        return this.parseArgs(line, i, 1, this.blank);
      case '.defined':
        return this.parseArgs(line, i, 1, this.definedSymbol);
      case '.definedsymbol':
        return this.parseArgs(line, i, 1, this.definedSymbol);
      case '.constantsymbol':
        return this.parseArgs(line, i, 1, this.constantSymbol);
      case '.referencedsymbol':
        return this.parseArgs(line, i, 1, this.referencedSymbol);
    }
    return i + 1;
  }

  // QUESTION - does skip descend into groups?
  //          - seems like it should...
  private skip(line: Token[], i: number): number {
    // expand i + 1, then splice self out
    line.splice(i, 1);
    const skipped = line[i];
    if (skipped?.token === 'grp') {
      this.expandToken(skipped.inner, 0);
    } else {
      this.expandToken(line, i + 1);
    }
    return i;
  }

  private noexpand(line: Token[], i: number): number {
    const skip = line[i + 1];
    if (skip.token === 'grp') {
      line.splice(i, 2, ...skip.inner);
      i += skip.inner.length - 1;
    } else {
      line.splice(i, 1);
    }
    return i + 1;
  }

  private parseArgs(line: Token[], i: number, argCount: number,
                    fn: (this: this, cs: Token,
                         ...args: Token[][]) => Token[]): number {
    const cs = line[i];
    Tokens.expect(Tokens.LP, line[i + 1], cs);
    const end = Tokens.findBalanced(line, i + 1);
    const args =
        Tokens.parseArgList(line, i + 2, end).map(ts => {
          if (ts.length === 1 && ts[0].token === 'grp') ts = ts[0].inner;
          return this.expandLine(ts);
        });
    if (argCount && args.length !== argCount) {
      throw new Error(`Expected ${argCount} parameters: ${Tokens.nameAt(cs)}`);
    }
    const expansion = fn.call(this, cs, ...args);
    line.splice(i, end + 1 - i, ...expansion);
    return i; // continue expansion from same spot
  }

  private tcount(cs: Token, arg: Token[]) : Token[] {
    return [{token: 'num', num: Tokens.count(arg), source: cs.source}];
  }

  private ident(cs: Token, arg: Token[]) : Token[] {
    const str = Tokens.expectString(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single token');
    return [{token: 'ident', str, source: arg[0].source}];
  }

  private string(cs: Token, arg: Token[]) : Token[] {
    const str = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single token');
    return [{token: 'str', str, source: arg[0].source}];
  }
    
  private concat(cs: Token, ...args: Token[][]) : Token[] {
    const strs = args.map(ts => {
      const str = Tokens.expectString(ts[0]);
      Tokens.expectEol(ts[1], 'a single string');
      return str;
    });
    return [{token: 'str', str: strs.join(''), source: cs.source}];
  }

  private sprintf(cs: Token, fmtToks: Token[], ..._args: Token[][]) : Token[] {
    // NOTE: ca65 supports /^%(%|[-+ #0]*\d*(\.\d*)?[diouXxsc])/ but sprintf-js does not support '+ #'.
    // Also note: ca65 should work with a value assigned to a variable with = but js65 does not.
    const fmtRe = /^%(%|-?0?\d*(\.\d+)?[diouXxsc])/;

    const fmt = Tokens.expectString(fmtToks[0], cs);
    let sprintfFmt = '';
    const sprintfArgs: (string | number)[] = [];
    let prevTok: Token = fmtToks.slice(-1)[0];
    let offs = 0, argIdx = 0;
    while (offs < fmt.length) {
      // Break up the format string by literal text and format spec segments
      let pctOffs = fmt.indexOf('%', offs);
      if (pctOffs < 0)
        pctOffs = fmt.length;

      if (pctOffs != offs) {
        // Text segment
        sprintfFmt += fmt.slice(offs, pctOffs);
        offs = pctOffs;
      }
      else {
        // Format spec
        const match = fmtRe.exec(fmt.substring(offs));
        if (!match)
          throw new Error("invalid format string");
        
        const specType = match[0].slice(-1);
        if (specType != '%') {
          const argToks = _args[argIdx];
          let arg: string | number = 0;
          if (specType == 's')
            arg = Tokens.expectString(argToks[0], prevTok);
          else
            arg = this.evaluateConst(parseOneExpr(argToks, prevTok));

          sprintfArgs.push(arg);
          argIdx++;
          prevTok = argToks.slice(-1)[0];
        }

        sprintfFmt += match[0];
        offs += match[0].length;
      }
    }

    return [{token: 'str', str: vsprintf(sprintfFmt, sprintfArgs), source: cs.source}];
  }

  private cond(_cs: Token, ..._args: Token[][]) : Token[] {
    throw new Error('unimplemented');
  }

  private blank(cs: Token, arg: Token[]) : Token[] {
    return [{token: 'num', num: arg.length === 0 ? 1 : 0}];
  }

  private definedSymbol(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [{token: 'num', num: this.env.definedSymbol(ident) ? 1 : 0}];
  }

  private constantSymbol(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [{token: 'num', num: this.env.constantSymbol(ident) ? 1 : 0}];
  }

  private referencedSymbol(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [{token: 'num', num: this.env.referencedSymbol(ident) ? 1 : 0}];
  }

  // TODO - does .byte expand its strings into bytes here?
  //   -- maybe not...
  //   -- do we need to handle string exprs at all?
  //   -- maybe not - maybe just tokens?

  /**
   * If the following is an identifier, skip it.  This is used when
   * expanding .define, .undefine, .defined, .ifdef, and .ifndef.
   * Does not skip scoped identifiers, since macros can't be scoped.
   */
  private skipIdentifier(line: Token[], i: number): number {
    return line[i + 1]?.token === 'ident' ? i + 2 : i + 1;
  }

  ////////////////////////////////////////////////////////////////
  // RUN DIRECTIVES

  async tryRunDirective(line: Token[]): Promise<boolean> {
    const first = line[0];
    if (first.token !== 'cs') throw new Error(`impossible`);
    const handler = this.runDirectives[first.str];
    if (!handler) return false;
    await handler(line);
    return true;
  }

  evaluateConst(expr: Expr): number {
    // Attempt to look up a symbol and see if its a constant value
    const evalWrapper = (ex: Expr) => {
      if (ex.op === 'sym' && this.env.definedSymbol(ex.sym!)) {
        // HACK? If its defined but not set, default it to zero?
        const num = this.env.evaluate(ex);
        if (num === undefined) throw new Error(`Symbol ${ex.sym} is undefined`);
        return Exprs.evaluate({op: 'num', num, meta: Exprs.size(num, undefined)});
      }
      return Exprs.evaluate(ex);
    }
    expr = Exprs.traversePost(expr, evalWrapper);
    if (expr.op === 'num' && !expr.meta?.rel) return expr.num!;
    const at = Tokens.at(expr);
    throw new Error(`Expected a constant: ${at} : ${expr}`);
  }

  private readonly runDirectives: Record<string, (ts: Token[]) => Promise<void>> = {
    '.define': (line) => this.parseDefine(line),
    '.undefine': (line) => this.parseUndefine(line),
    '.else': ([cs]) => badClose('.if', cs),
    '.elseif': ([cs]) => badClose('.if', cs),
    '.endif': ([cs]) => badClose('.if', cs),
    '.endmacro': ([cs]) => badClose('.macro', cs),
    '.endrepeat': (line) => this.parseEndRepeat(line),
    '.exitmacro': async ([, a]) => { noGarbage(a); this.stream.exit(); 
      return await Promise.resolve(); },
    '.if': ([cs, ...args]) =>
        this.parseIf(!!this.evaluateConst(parseOneExpr(args, cs))),
    '.ifdef': ([cs, ...args]) =>
        this.parseIf(this.parseIfDef(args, cs)),
    '.ifndef': ([cs, ...args]) =>
        this.parseIf(!this.parseIfDef(args, cs)),
    '.ifblank': ([, ...args]) => this.parseIf(!args.length),
    '.ifnblank': ([, ...args]) => this.parseIf(!!args.length),
    '.ifref': ([cs, ...args]) =>
        this.parseIf(this.env.referencedSymbol(parseOneIdent(args, cs))),
    '.ifnref': ([cs, ...args]) =>
        this.parseIf(!this.env.referencedSymbol(parseOneIdent(args, cs))),
    '.ifsym': ([cs, ...args]) =>
        this.parseIf(this.env.definedSymbol(parseOneIdent(args, cs))),
    '.ifnsym': ([cs, ...args]) =>
        this.parseIf(!this.env.definedSymbol(parseOneIdent(args, cs))),
    '.ifconst': ([cs, ...args]) =>
        this.parseIf(this.env.constantSymbol(parseOneIdent(args, cs))),
    '.ifnconst': ([cs, ...args]) =>
        this.parseIf(!this.env.constantSymbol(parseOneIdent(args, cs))),
    // NOTE: If support for any other CPUs is added, these will need to be un-stubbed.
    '.ifp02': ([CSS, ...args]) => this.parseIf(true),
    '.ifp4510': ([CSS, ...args]) => this.parseIf(false),
    '.ifp816': ([CSS, ...args]) => this.parseIf(false),
    '.ifpc02': ([CSS, ...args]) => this.parseIf(false),
    '.ifpdtv': ([CSS, ...args]) => this.parseIf(false),
    '.ifpsc02': ([CSS, ...args]) => this.parseIf(false),
    '.macro': (line) => this.parseMacro(line),
    '.repeat': (line) => this.parseRepeat(line),
  };

  private async parseDefine(line: Token[]) {
    const name = Tokens.expectIdentifier(line[1], line[0]);
    const define = Define.from(line);
    const prev = this.macros.get(name);
    if (prev instanceof Define) {
      prev.append(define);
    } else if (prev) {
      throw new Error(`Already defined: ${name}`);
    } else {
      this.macros.set(name, define);
    }
    return await Promise.resolve();
  }

  private async parseUndefine(line: Token[]) {
    const [cs, ident, eol] = line;
    const name = Tokens.expectIdentifier(ident, cs);
    Tokens.expectEol(eol);
    if (!this.macros.has(name)) {
      throw new Error(`Not defined: ${Tokens.nameAt(ident)}`);
    }
    this.macros.delete(name);
    return await Promise.resolve();
  }

  private async parseMacro(line: Token[]) {
    const name = Tokens.expectIdentifier(line[1], line[0]);
    const macro = await Macro.from(line, this.stream);
    const prev = this.macros.get(name);
    if (prev) throw new Error(`Already defined: ${name}`);
    this.macros.set(name, macro);
  }

  private async parseRepeat(line: Token[]) {
    const [expr, end] = Exprs.parse(line, 1);
    const at = line[1] || line[0];
    if (!expr) throw new Error(`Expected expression: ${Tokens.nameAt(at)}`);
    const times = this.evaluateConst(expr);
    if (times == null) throw new Error(`Expected a constant${Tokens.at(expr)}`);
    let ident: string|undefined;
    if (end < line.length) {
      if (!Tokens.eq(line[end], Tokens.COMMA)) {
        throw new Error(`Expected comma: ${Tokens.nameAt(line[end])}`);
      }
      ident = Tokens.expectIdentifier(line[end + 1]);
      Tokens.expectEol(line[end + 2]);
    }
    const lines: Token[][] = [];
    let depth = 1;
    while (depth > 0) {
      line = await this.stream.next() ?? fail(`.repeat with no .endrep`);
      if (Tokens.eq(line[0], Tokens.REPEAT)) depth++;
      if (Tokens.eq(line[0], Tokens.ENDREPEAT)) depth--;
      lines.push(line);
    }
    this.repeats.push([lines, times, -1, ident]);
    this.parseEndRepeat(line);
  }

  private async parseEndRepeat(line: Token[]) {
    Tokens.expectEol(line[1]);
    const top = this.repeats.pop();
    if (!top) throw new Error(`.endrep with no .repeat${Tokens.at(line[0])}`);
    if (++top[2] >= top[1]) return await Promise.resolve();
    this.repeats.push(top);
    this.stream.unshift(...top[0].map(line => line.map(token => {
      if (token.token !== 'ident' || token.str !== top[3]) return token;
      const t: Token = {token: 'num', num: top[2]};
      if (token.source) t.source = token.source;
      return t;
    })));
    return await Promise.resolve();
  }

  private async parseIf(cond: boolean) {
    let depth = 1;
    let done = false;
    const result: Token[][] = [];
    while (depth > 0) {
      const line = await this.stream.next();
      if (!line) throw new Error(`EOF looking for .endif`); // TODO: start?
      const front = line[0];
      if (Tokens.eq(front, Tokens.ENDIF)) {
        depth--;
        if (!depth) break;
      } else if (front.token === 'cs' && front.str.startsWith('.if')) {
        depth++;
      } else if (depth === 1 && !done) {
        if (cond && (Tokens.eq(front, Tokens.ELSE) ||
                     Tokens.eq(front, Tokens.ELSEIF))) {
          // if true ... else .....
          cond = false;
          done = true;
          continue;
        } else if (Tokens.eq(front, Tokens.ELSEIF)) {
          // if false ... else if .....
          cond = !!this.evaluateConst(parseOneExpr(this.expandLine(line.slice(1)), front));
          continue;
        } else if (Tokens.eq(front, Tokens.ELSE)) {
          // if false ... else .....
          cond = true;
          continue;
        }
      }
      // anything else on the line
      if (cond) result.push(line);
    }
    // result has the expansion: unshift it
    this.stream.unshift(...result);
  }

  private parseIfDef(args: Token[], cs: Token) {
    return this.macros.has(parseOneIdent(args, cs)) ||
      this.env.definedSymbol(parseOneIdent(args, cs));
  }

      // if (front.str === '.define' || front.str === '.undefine') {
      //   const next = line[pos + 1];
      //   if (next?.token === 'cs') {
      //     this.expandToken(line, pos + 1);
      //     return pos;
      //   } else if (next?.token === 'ident') {
      //     return pos + 2; // skip the identifier
      //   }
      // } else if (front.str === '.skip') {
      //   const rest = line.splice(pos + 2, line.length - pos - 2);
      //   line.pop();
      //   this.expandToken(rest, 0);
      //   line.push(...rest);
      //   return pos;
      // } else {


  // defined(name: string): boolean {
  //   return this.macros.has(name) ||
  //       this.parent && this.parent.defined(name) ||
  //       false;
  // }

  // undefine(name: string) {
  //   this.macros.delete(name);
  // }

  // // Expands a single line of tokens from the front of toks.
  // // .define macros are expanded inline, but .macro style macros
  // // are left as-is.  Don't expand defines in certain circumstances,
  // // such as when trying to override.
  // private line(toks: Deque<Token>): Deque<Token> {
  //   // find the next end of line
  //   const line = new Deque<Token>();
  //   let curlies = 0;
  //   while (toks.length) {
  //     const tok = toks.shift();
  //     if (Tokens.eq(Tokens.EOL, tok)) break;
  //     if (Tokens.eq(Tokens.LC, tok)) {
  //       curlies++;
  //     } else if (Tokens.eq(Tokens.RC, tok)) {
  //       if (--curlies < 0) throw new Eror(`unbalanced curly`);
  //     }
  //     line.push(tok);
  //   }
  //   if (curlies) throw new Error(`unbalanced curly`);
  //   // now do the early expansions
  //   for (let i = 0; i < line.length; i++) {
  //     const tok = line.get(i)!;
  //     if (Tokens.eq(Tokens.SKIP, tok)) {
  //       const next = line.get(i + 1);
  //       const count = next?.token === 'num' ? next.num : 1;
  //       i += count;
  //       continue;
  //     }
  //     if (tok.token === 'ident') {
  //       const macro = this.macros.get(tok.str);
  //       if (macro?.expandsEarly) {
  //         if (!macro.expand(line, i)) fail(tok, `Could not expand ${tok.str}`);
  //         i = -1; // start back at the beginning
  //         continue;
  //       }
  //     }
  //   }
  //   return line;
  // }

  // * lines(rest: Deque<Token>, depth = 0): Generator<Line> {
  //   if (depth > MAX_STACK_DEPTH) throw new Error(`max recursion depth`);
  //   while (rest.length) {
  //     // lines should have no define-macros in it at this point
  //     let labels = [];
  //     let line = this.line(rest);
  //     while (line.length) {
  //       // look for labels, but could be a mnemonic or macro
  //       const front = line.front()!;
  //       if (front.token === 'ident') {
  //         if (Tokens.eq(Tokens.COLON, line.get(1))) {
  //           // it's a label
  //           labels.push(front.str);
  //           line.splice(0, 2);
  //           continue;
  //         }
  //         // check for a macro
  //         const macro = this.macros.get(front.str);
  //         if (macro) {
  //           if (macro.expandsEarly) throw new Error(`early macro late`);
  //           if (!macro.expand(line)) throw new Error(`bad expansion`);
  //           // by recursing rather than unshifting we can support .exitmacro?
  //           yield * this.lines(line, depth + 1);
  //           break;
  //         }
  //         // it's a regular mnemonic
  //         yield {labels, tokens: [...line]};
  //         break;
  //       } else if (Tokens.eq(Tokens.COLON, front)) { // special label
  //         labels.push(':');
  //         line.shift();
  //         continue;
  //       } else if (front.token === 'op') {
  //         // other special labels
  //         if (/^(\++|-+)$/.test(front.str)) {
  //           labels.push(front.str);
  //           line.shift();
  //           if (Tokens.eq(Tokens.COLON, line.front())) line.shift();
  //           continue;
  //         }
  //         // otherwise... syntax error? any other operator allowed?
  //         throw new Error(`Syntax error: unexpected ${Tokens.nameAt(front)}`);
  //       } else if (front.token === 'cs') {
  //         switch (front.str) {
  //           case '.exitmacro':
  //             line = new Deque(); // no more expansion
  //             break;
  //           case '.ifdef':
  //             // TODO - call helper method? but how? closure?
              
  //             break;
  //           case '.define':
  //             break;
  //           case '.macro':
  //             break;
  //         }
  //       }
  //     }
  //   }
  // }
}

// Handles scoped names, too.
function parseOneIdent(ts: Token[], prev?: Token): string {
  const e = parseOneExpr(ts, prev);
  return Exprs.identifier(e);
}

function parseOneExpr(ts: Token[], prev?: Token): Expr {
  if (!ts.length) {
    if (!prev) throw new Error(`Expected expression`);
    throw new Error(`Expected expression: ${Tokens.nameAt(prev)}`);
  }
  return Exprs.parseOnly(ts);
}

function noGarbage(token: Token|undefined): void {
  if (token) throw new Error(`garbage at end of line: ${Tokens.nameAt(token)}`);
}

// function fail(t: Token, msg: string): never {
//   const s = t.stream;
//   if (s) {
//     msg += `\n  at ${s.file}:${s.line}:${s.column}: Tokens.name(t)`;
//     // TODO - expanded from?
//   }
//   throw new Error(msg);
// }

function badClose(open: string, tok: Token): never {
  throw new Error(`${Tokens.name(tok)} with no ${open}${Tokens.at(tok)}`);
}

function fail(msg: string): never {
  throw new Error(msg);
}
