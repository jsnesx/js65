
// SPDX-License-Identifier: MPL-2.0

import {vsprintf} from './sprintf.ts';
import {Define} from './define.ts';
import type { Expr } from './expr.ts';
import * as Exprs from './expr.ts';
import {Macro} from './macro.ts';
import type { Token } from './token.ts';
import * as Tokens from './token.ts';
import {TokenStream} from './tokenstream.ts';
import { ErrorCollector, FatalError, RecoverableError, SourceError } from './error.ts';
import type {MacroIndex} from './lspindex.ts';

// TODO - figure out how to actually keep track of stack depth?
//  - might need to insert a special token at the end of an expansion
//    to know when to release the frame?
const MAX_STACK_DEPTH = 100;

/** Token types that finish off a value so a `::` after one qualifies it. */
const VALUE_END: ReadonlySet<string> = new Set(['num', 'str', 'rb', 'rp', 'rc', 'grp']);

/**
 * Value reported by `.version`, encoded the way ca65 does it:
 * `(major << 8) | minor`.
 */
const JS65_VERSION = 0x0213; // matches ca65 version 2.19

/**
 * Value reported by `.cpu`.
 * The set of instruction sets the current CPU supports, using ca65's bit numbering
 * where bit 0 is the base 6502 set and bit 1 the undocumented "6502X" opcodes
 * We always compile with 6502x as the default.
 */
const JS65_CPU_ISET = 0x03;

/**
 * Value reported by `.asize` and `.isize`.  js65 assembles for the 6502, whose
 * accumulator and index registers are always 8 bits wide.
 */
const REGISTER_SIZE = 8;

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
  /** Whether the name is an opcode mnemonic of the CPU being assembled for. */
  isMnemonic(name: string): boolean;
  /** Whether `* = addr` is accepted */
  allowsPcAssignment(): boolean;
  /** Whether a leading identifier is a label even without a trailing `:` */
  allowsLabelWithoutColon(): boolean;
  evaluate(expr: Expr): number|undefined;
  /** Expression a defined symbol (or `*`) stands for, without interning it. */
  definedValue(sym: string): Expr|undefined;
  assignSym(line: Token[]): void;
  setSym(line: Token[]): void;
  /** Applies the current charmap to a character literal (`'a'`). */
  encodeChar(char: string): number|undefined;
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
  // Output lines produced by pump() but not yet consumed by next(). A single
  // source line can expand into several output lines (e.g. labels split off the
  // front of an instruction), which is why its a list of lists.
  // This replaces the AsyncGenerator which was a pain for any TS compiler project
  // like hermes or perry
  private outQueue: Token[][] = [];

  // builds up repeating tokens...
  private repeats: Array<[Token[][], number, number, string?]> = [];
  // NOTE: there is no scope here... - not for macros
  //  - only symbols have scope
  // TODO - evaluate constants...

  /** Sink for the macros/defines found by the preprocessor. Only set by the LSP. */
  readonly macroIndex?: MacroIndex;

  constructor(readonly stream: TokenStream, readonly env: Env,
              parent?: Preprocessor,
              readonly errorCollector?: ErrorCollector,
              macroIndex?: MacroIndex) {
    this.macros = parent ? parent.macros : new Map();
    if (!errorCollector && parent?.errorCollector) {
      this.errorCollector = parent.errorCollector;
    }
    // Nested preprocessors share the parent's index, the same way they share
    // the macro map itself.
    this.macroIndex = macroIndex ?? parent?.macroIndex;
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
      // Drain any output already produced for a previous source line.
      if (this.outQueue.length) return this.outQueue.shift();
      try {
        const more = await this.pump();
        if (!more) return undefined; // EOF
      } catch (err) {
        if (err instanceof RecoverableError) {
          // Error already recorded; abandon the rest of the current line but
          // keep any output it produced before the error, then continue.
          continue;
        }
        // `.fatal`, cancellation and the error cap stop the whole run.
        if (err instanceof FatalError) throw err;
        // Try to recover if we have an error collector by skipping the rest of the line
        if (err instanceof SourceError && this.errorCollector) {
          if (!err.recorded) {
            err.recorded = true;
            this.errorCollector.addFromException(err);
          }
          continue;
        }
        throw err;
      }
    }
  }

  // Read and process the next source line, pushing zero or more output lines
  // onto `outQueue`. Returns false at EOF, true otherwise.
  private async pump(): Promise<boolean> {
    const line = await this.readLine();
    if (line == null) return false; // EOF
    while (line.length) {
      const front = line[0];
      switch (front.token) {
        case 'ident':
          // Possibilities: (1) label, (2) instruction/assign, (3) macro
          // Labels get split out.  We don't distinguish assigns yet.
          if (Tokens.eq(line[1], Tokens.COLON)) {
            const label = line.splice(0, 2);
            // Remember that data followed the label on its source line, since
            // that's what `.sizeof(label)` measures and the split loses it.
            if (line.length) label[0] = {...front, labelsData: true};
            this.outQueue.push(label);
            break;
          }
          if (Tokens.eq(line[1], Tokens.ASSIGN) ||
              Tokens.eq(line[1], Tokens.ASSIGN_LABEL)) {
            this.env.assignSym(line);
          } else if (Tokens.eq(line[1], Tokens.SET)) {
            this.env.setSym(line);
          } else if (this.isLabelWithoutColon(line)) {
            // Same split as the `foo:` case above, but there isn't a colon,
            // so we just add one here to use the regular label code path.
            line.splice(0, 1);
            const label: Token[] =
                [line.length ? {...front, labelsData: true} : front,
                 {token: 'op', str: ':'}];
            this.outQueue.push(label);
            break;
          }
          if (!this.tryExpandMacro(line)) this.outQueue.push(line);
          return true;

        case 'cs':
          if (!(await this.tryRunDirective(line))) this.outQueue.push(line);
          return true;

        case 'op':
          // `* = $8000`, which is just another spelling of `.org $8000`.
          if (front.str === '*' && Tokens.eq(line[1], Tokens.ASSIGN)) {
            if (!this.env.allowsPcAssignment()) {
              Tokens.fail(
                  `\`*=\` requires the pc_assignment feature`, front);
            }
            // Rewrite it as `.org` and let the loop dispatch it as a directive.
            line.splice(0, 2, {token: 'cs', str: '.org', source: front.source});
            break;
          }
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
            this.outQueue.push(label);
            break;
          } else if (front.str === ':') {
            this.outQueue.push(line.splice(0, 1));
            break;
          }
          /* fallthrough */
        default:
          Tokens.fail(`Unexpected: ${Tokens.nameOf(line[0])}`, line[0]);
      }
    }
    return true;
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
        Tokens.fail(`Maximum expansion depth reached: ${
                      line.map(Tokens.name).join(' ')}`, front);
      }
      pos = this.expandToken(line, pos);
    }
    return line;
  }

  /** Whether a name is an instruction or a `.macro`, and so can't be a scope. */
  private isCallable(name: string): boolean {
    return this.macros.get(name) instanceof Macro || this.env.isMnemonic(name);
  }

  private isLabelWithoutColon(line: Token[]): boolean {
    const front = line[0];
    if (front.token !== 'ident') return false;
    if (!this.env.allowsLabelWithoutColon()) return false;
    return !this.isCallable(front.str);
  }

  /**
   * Differentiate between a `scope :: label` and a `.if :: global` by finding
   * where exactly the "label" starts. In the first case it should roll
   * up everything through the scope, but the second should stop at
   * the `::`. This combines the scope into one big ident token to make it
   * easier to process.
   * In the tokenizer, we keep each part `scope :: label` separate (thats 3
   * tokens) to match how ca65 does it, and then for later handling, we combine
   * that into one label token.
   */
  private mergeScopePrefix(line: Token[], pos: number): number {
    if (pos < 1 || !Tokens.eq(line[pos - 1], Tokens.DCOLON)) return pos;
    const ident = line[pos];
    if (ident.token !== 'ident') return pos;
    const before = pos >= 2 ? line[pos - 2] : undefined;
    if (before && before.token !== 'ident' && VALUE_END.has(before.token)) {
      return pos;
    }
    const scope = before?.token === 'ident' && !this.isCallable(before.str) ?
        before.str : '';
    const start = scope ? pos - 2 : pos - 1;
    line.splice(start, pos - start + 1,
                {token: 'ident', str: `${scope}::${ident.str}`, source: ident.source});
    return start;
  }

  /** Returns the next position to expand. */
  private expandToken(line: Token[], pos: number): number {
    const front = line[pos]!;
    if (front.token === 'ident') {
      // define replacement has to happen first in case the scope has some
      // name that needs replaced before we turn it into a label.
      const define = this.macros.get(front.str);
      if (define instanceof Define) {
        const overflow = define.expand(line, pos);
//console.log('post-expand', line);
        if (overflow) {
          if (overflow.length) this.stream.unshift(...overflow)
          return pos;
        }
      }
      // Whatever it expanded to still has to be joined to the scope in front.
      return this.mergeScopePrefix(line, pos) + 1;
    } else if (front.token === 'cs') {
      return this.expandDirective(front.str, line, pos);
    } else if (front.token === 'grp') {
      // Expand the { ... } lists immediately instead of passing it
      // down to the callee
      this.expandLine(front.inner);
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
      case '.delmacro':
      case '.ifdef':
      case '.ifndef':
      case '.undefine':
        return this.skipIdentifier(line, i);
      case '.skip': return this.skip(line, i);
      case '.noexpand': return this.noexpand(line, i);
      case '.tcount': return this.parseArgs(line, i, 1, this.tcount);
      case '.match': return this.parseArgs(line, i, 2, this.matchTokens);
      case '.xmatch': return this.parseArgs(line, i, 2, this.xmatchTokens);
      case '.left': return this.parseArgs(line, i, 2, this.left);
      case '.right': return this.parseArgs(line, i, 2, this.right);
      case '.mid': return this.parseArgs(line, i, 3, this.mid);
      case '.ident': return this.parseArgs(line, i, 1, this.ident);
      case '.string': return this.parseArgs(line, i, 1, this.string);
      case '.concat': return this.parseArgs(line, i, 0, this.concat);
      case '.sprintf': return this.parseArgs(line, i, 0, this.sprintf);
      case '.cond': return this.parseArgs(line, i, 3, this.cond);
      case '.blank':
        return this.parseArgs(line, i, 1, this.blank);
      case '.const':
        return this.parseArgs(line, i, 1, this.constExpr);
      case '.defined':
        return this.parseArgs(line, i, 1, this.definedSymbol);
      case '.definedmacro':
        return this.parseArgs(line, i, 1, this.definedMacro);
      case '.definedsymbol':
        return this.parseArgs(line, i, 1, this.definedSymbol);
      case '.ismnemonic':
        return this.parseArgs(line, i, 1, this.isMnemonic);
      case '.constantsymbol':
        return this.parseArgs(line, i, 1, this.constantSymbol);
      case '.referencedsymbol':
        return this.parseArgs(line, i, 1, this.referencedSymbol);
      case '.time':
        // Seconds since the epoch, so that source can stamp a build time.
        return this.pseudoVariable(line, i, Math.floor(Date.now() / 1000));
      case '.version':
        return this.pseudoVariable(line, i, JS65_VERSION);
      case '.asize':
      case '.isize':
        return this.pseudoVariable(line, i, REGISTER_SIZE);
      case '.cpu':
        return this.pseudoVariable(line, i, JS65_CPU_ISET);
    }
    return i + 1;
  }

  /**
   * Substitutes a bare pseudo-variable with its value. Unlike
   * the pseudo-functions these take no parentheses at all.
   */
  private pseudoVariable(line: Token[], i: number, num: number): number {
    line.splice(i, 1, {token: 'num', num, source: line[i].source});
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
      Tokens.fail(`Expected ${argCount} parameters: ${Tokens.nameOf(cs)}`, cs);
    }
    const expansion = fn.call(this, cs, ...args);
    line.splice(i, end + 1 - i, ...expansion);
    return i; // continue expansion from same spot
  }

  private tcount(cs: Token, arg: Token[]) : Token[] {
    return [{token: 'num', num: Tokens.count(arg), source: cs.source}];
  }

  // `.match`/`.xmatch` compare two token lists as raw tokens and not values, so
  // they work on things like `#` or register names that aren't expressions.
  // `.match` compares token types only, so any number matches any other number
  // and any identifier matches any other identifier; `.xmatch` also compares
  // the attribute (the number's value, the identifier's or string's text).
  // the exact parameter is used to select between the two.
  private static tokensEqual(a: Token[], b: Token[], exact: boolean): boolean {
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) {
      const x = a[k], y = b[k];
      if (x.token !== y.token) return false;
      switch (x.token) {
        case 'ident': case 'str':
          if (exact && x.str !== (y as typeof x).str) return false;
          break;
        case 'num':
          if (exact && x.num !== (y as typeof x).num) return false;
          break;
        case 'op': case 'cs':
          // Operators and control commands *are* their text, so the text is
          // part of the token type rather than an attribute.
          if (x.str !== (y as typeof x).str) return false;
          break;
        default:
          break; // structural tokens match on type alone
      }
    }
    return true;
  }

  private matchTokens(cs: Token, a: Token[], b: Token[]) : Token[] {
    return [{token: 'num', num: Preprocessor.tokensEqual(a, b, false) ? 1 : 0, source: cs.source}];
  }

  private xmatchTokens(cs: Token, a: Token[], b: Token[]) : Token[] {
    return [{token: 'num', num: Preprocessor.tokensEqual(a, b, true) ? 1 : 0, source: cs.source}];
  }

  private constCount(toks: Token[], cs: Token): number {
    try {
      return this.evaluateConst(parseOneExpr(toks, cs, this.env.encodeChar), cs);
    } catch {
      Tokens.fail(`Expected a constant token count`, cs);
    }
  }

  private left(cs: Token, count: Token[], list: Token[]) : Token[] {
    const n = Math.max(0, this.constCount(count, cs));
    return list.slice(0, n);
  }

  private right(cs: Token, count: Token[], list: Token[]) : Token[] {
    const n = Math.max(0, this.constCount(count, cs));
    return n >= list.length ? list.slice() : list.slice(list.length - n);
  }

  private mid(cs: Token, start: Token[], count: Token[], list: Token[]) : Token[] {
    const s = Math.max(0, this.constCount(start, cs));
    const n = Math.max(0, this.constCount(count, cs));
    return list.slice(s, s + n);
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
            arg = this.evaluateConst(parseOneExpr(argToks, prevTok, this.env.encodeChar));

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

  private cond(cs: Token, cond: Token[], ifTrue: Token[], ifFalse: Token[]) : Token[] {
    const v = this.evaluateConst(parseOneExpr(cond, cs, this.env.encodeChar), cs);
    return v ? ifTrue : ifFalse;
  }

  private blank(cs: Token, arg: Token[]) : Token[] {
    return [{token: 'num', num: arg.length === 0 ? 1 : 0}];
  }

  /** `.const(expr)` is 1 when the expression is already known, 0 otherwise. */
  private constExpr(cs: Token, arg: Token[]) : Token[] {
    const expr = parseOneExpr(arg, cs, this.env.encodeChar);
    let known = true;
    try {
      // `*` and labels have a value here, but it's an address rather than a
      // constant, so `.const` says no to them the way ca65 does.
      this.evaluateConst(expr, cs, false);
    } catch {
      known = false; // `*`, forward references and imports are not constant
    }
    return [{token: 'num', num: known ? 1 : 0, source: cs.source}];
  }

  /**
   * `.definedmacro` checks only for `.macro` and not the c-style `.define` macros
   */
  private definedMacro(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [{token: 'num', num: this.macros.get(ident) instanceof Macro ? 1 : 0,
             source: cs.source}];
  }

  /** Checks if the current CPU setting supports this mnemonic */
  private isMnemonic(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [{token: 'num', num: this.env.isMnemonic(ident) ? 1 : 0,
             source: cs.source}];
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
   * expanding .define, .undefine, .delmacro, .defined, .ifdef, and .ifndef.
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

  /**
   * @param addresses Whether `*` and labels may stand in for their address value
   * `.const` needs them as labels, but other callers want them as addresses.
   */
  evaluateConst(expr: Expr, source?: Token, addresses = true): number {
    // Attempt to look up a symbol and see if its a constant value
    const evalWrapper = (ex: Expr) => {
      if (ex.op === 'sym' && ex.sym) {
        // Substitute the expression rather than a number.
        // Labels and `*` are chunk-relative, and it's the surrounding
        // arithmetic like `* - label` that makes them constant again.
        const val = this.env.definedValue(ex.sym);
        if (val && (addresses || !isAddress(val))) return Exprs.evaluate(val);
      }
      return Exprs.evaluate(ex);
    };
    // Check for short circuiting to see if we should skip the rest of the check
    const truthy = (n: number | undefined) => n === undefined ? undefined : n !== 0;
    const evalNode = (ex: Expr): number | undefined => {
      const isAnd = ex.op === '&&' || ex.op === '.and';
      const isOr = ex.op === '||' || ex.op === '.or';
      if ((isAnd || isOr) && ex.args?.length === 2) {
        const l = truthy(evalNode(ex.args[0]));
        if (isAnd && l === false) return 0;
        if (isOr && l === true) return 1;
        const r = truthy(evalNode(ex.args[1]));
        if (l === undefined || r === undefined) return undefined;
        return (isAnd ? (l && r) : (l || r)) ? 1 : 0;
      }
      const reduced = Exprs.traversePost(ex, evalWrapper);
      return reduced.op === 'num' && !reduced.meta?.rel ? reduced.num : undefined;
    };
    const v = evalNode(expr);
    if (v !== undefined) return v;
    const reduced = Exprs.traversePost(expr, evalWrapper);
    const desc = reduced.op === 'sym' ? `symbol ${reduced.sym}` : `${reduced.op} expression`;
    Tokens.fail(`Expected a constant: ${desc}`, reduced.source ?? source);
  }

  private readonly runDirectives: Record<string, (ts: Token[]) => Promise<void>> = {
    '.define': (line) => this.parseDefine(line),
    '.delmacro': (line) => this.parseDelMacro(line),
    '.undefine': (line) => this.parseUndefine(line),
    '.else': ([cs]) => badClose('.if', cs),
    '.elseif': ([cs]) => badClose('.if', cs),
    '.endif': ([cs]) => badClose('.if', cs),
    '.endmacro': ([cs]) => badClose('.macro', cs),
    '.endrepeat': (line) => this.parseEndRepeat(line),
    '.exitmacro': async ([, a]) => { noGarbage(a); this.stream.exit(); 
      return await Promise.resolve(); },
    '.if': ([cs, ...args]) =>
        this.parseIf(() => !!this.evaluateConst(
            parseOneExpr(args, cs, this.env.encodeChar), cs), cs),
    '.ifdef': ([cs, ...args]) =>
        this.parseIf(() => this.parseIfDef(args, cs), cs),
    '.ifndef': ([cs, ...args]) =>
        this.parseIf(() => !this.parseIfDef(args, cs), cs),
    '.ifblank': ([cs, ...args]) => this.parseIf(() => !args.length, cs),
    '.ifnblank': ([cs, ...args]) => this.parseIf(() => !!args.length, cs),
    '.ifref': ([cs, ...args]) =>
        this.parseIf(() => this.env.referencedSymbol(parseOneIdent(args, cs)), cs),
    '.ifnref': ([cs, ...args]) =>
        this.parseIf(() => !this.env.referencedSymbol(parseOneIdent(args, cs)), cs),
    '.ifsym': ([cs, ...args]) =>
        this.parseIf(() => this.env.definedSymbol(parseOneIdent(args, cs)), cs),
    '.ifnsym': ([cs, ...args]) =>
        this.parseIf(() => !this.env.definedSymbol(parseOneIdent(args, cs)), cs),
    '.ifconst': ([cs, ...args]) =>
        this.parseIf(() => this.env.constantSymbol(parseOneIdent(args, cs)), cs),
    '.ifnconst': ([cs, ...args]) =>
        this.parseIf(() => !this.env.constantSymbol(parseOneIdent(args, cs)), cs),
    // NOTE: If support for any other CPUs is added, these will need to be un-stubbed.
    '.ifp02': ([cs]) => this.parseIf(() => true, cs),
    '.ifp4510': ([cs]) => this.parseIf(() => false, cs),
    '.ifp816': ([cs]) => this.parseIf(() => false, cs),
    '.ifpc02': ([cs]) => this.parseIf(() => false, cs),
    '.ifpdtv': ([cs]) => this.parseIf(() => false, cs),
    '.ifpsc02': ([cs]) => this.parseIf(() => false, cs),
    '.macro': (line) => this.parseMacro(line),
    '.repeat': (line) => this.parseRepeat(line),
  };

  async parseDefine(line: Token[]) {
    const name = Tokens.expectIdentifier(line[1], line[0]);
    const define = Define.from(line);
    const prev = this.macros.get(name);
    if (prev instanceof Define) {
      prev.append(define);
    } else if (prev) {
      Tokens.fail(`Already defined: ${name}`, line[1]);
    } else {
      this.macros.set(name, define);
    }
    // Record the merged entry, so an appended overload keeps the original site.
    const recorded = this.macros.get(name);
    if (recorded instanceof Define) {
      this.macroIndex?.record(name, 'define', recorded, recorded.definition?.source);
    }
    return await Promise.resolve();
  }

  private async parseUndefine(line: Token[]) {
    const [cs, ident, eol] = line;
    const name = Tokens.expectIdentifier(ident, cs);
    Tokens.expectEol(eol);
    const prev = this.macros.get(name);
    if (!prev) {
      Tokens.fail(`Not defined: ${Tokens.nameOf(ident)}`, ident);
    }
    // ca65 only deletes .define-style macros here
    // they should use .delmacro for the classic .macro-style ones.
    if (prev instanceof Macro) {
      Tokens.fail(`Not a .define macro: ${Tokens.nameOf(ident)}`, ident);
    }
    this.macros.delete(name);
    this.macroIndex?.remove(name);
    return await Promise.resolve();
  }

  /** `.delmacro` deletes a classic `.macro` the counterpart of `.undefine`. */
  private async parseDelMacro(line: Token[]) {
    const [cs, ident, eol] = line;
    const name = Tokens.expectIdentifier(ident, cs);
    Tokens.expectEol(eol);
    const prev = this.macros.get(name);
    if (!prev) {
      Tokens.fail(`Not defined: ${Tokens.nameOf(ident)}`, ident);
    }
    if (!(prev instanceof Macro)) {
      Tokens.fail(`Not a .macro: ${Tokens.nameOf(ident)}`, ident);
    }
    this.macros.delete(name);
    this.macroIndex?.remove(name);
    return await Promise.resolve();
  }

  private async parseMacro(line: Token[]) {
    const name = Tokens.expectIdentifier(line[1], line[0]);
    const macro = await Macro.from(line, this.stream);
    const prev = this.macros.get(name);
    if (prev) Tokens.fail(`Already defined: ${name}`, line[1]);
    this.macros.set(name, macro);
    this.macroIndex?.record(name, 'macro', macro, macro.definition?.source);
  }

  private async parseRepeat(line: Token[]) {
    const [expr, end] = Exprs.parse(line, 1, undefined, this.env.encodeChar);
    const at = line[1] || line[0];
    if (!expr) Tokens.fail(`Expected expression: ${Tokens.nameOf(at)}`, at);
    const times = this.evaluateConst(expr);
    if (times == null) Tokens.fail(`Expected a constant`, expr);
    let ident: string|undefined;
    if (end < line.length) {
      if (!Tokens.eq(line[end], Tokens.COMMA)) {
        Tokens.fail(`Expected comma: ${Tokens.nameOf(line[end])}`, line[end]);
      }
      ident = Tokens.expectIdentifier(line[end + 1]);
      Tokens.expectEol(line[end + 2]);
    }
    const lines: Token[][] = [];
    let depth = 1;
    const start = line[0];
    while (depth > 0) {
      line = await this.stream.next() ??
          Tokens.fail(`.repeat with no .endrep`, start);
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
    if (!top) Tokens.fail(`.endrep with no .repeat`, line[0]);
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

  /**
   * Evaluate a conditional's test, treating a failure as false, which
   * lets us still properly parse the `.if` itself.
   * Process the args in a callable so that we can catch any errors
   * inside the `.if` block and recover.
   */
  private condition(test: () => boolean, at?: Token): boolean {
    try {
      return test();
    } catch (err) {
      if (err instanceof FatalError || !(err instanceof SourceError) ||
          !this.errorCollector) {
        throw err;
      }
      if (!err.recorded) {
        err.recorded = true;
        this.errorCollector.addFromException(err, err.source ?? at?.source);
      }
      return false;
    }
  }

  private async parseIf(test: () => boolean, at?: Token) {
    let cond = this.condition(test, at);
    let depth = 1;
    let done = false;
    const result: Token[][] = [];
    while (depth > 0) {
      const line = await this.stream.next();
      // Report missing endif at the site of the starting .if
      if (!line) Tokens.fail(`EOF looking for .endif`, at);
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
          cond = this.condition(() => !!this.evaluateConst(
              parseOneExpr(this.expandLine(line.slice(1)), front, this.env.encodeChar),
              front), front);
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

function isAddress(expr: Expr): boolean {
  return expr.op !== 'num' || expr.meta?.rel === true || expr.meta?.org != null;
}

function parseOneExpr(ts: Token[], prev?: Token, charEncoder?: Exprs.CharEncoder): Expr {
  if (!ts.length) {
    if (!prev) throw new Error(`Expected expression`);
    Tokens.fail(`Expected expression: ${Tokens.nameOf(prev)}`, prev);
  }
  return Exprs.parseOnly(ts, 0, undefined, charEncoder);
}

function noGarbage(token: Token|undefined): void {
  if (token) Tokens.fail(`garbage at end of line: ${Tokens.nameOf(token)}`, token);
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
  Tokens.fail(`${Tokens.name(tok)} with no ${open}`, tok);
}
