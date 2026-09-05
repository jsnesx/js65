
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
import type { SourceInfo } from './error.ts';
import type {InactiveRegionIndex, MacroIndex} from './lspindex.ts';

// TODO - figure out how to actually keep track of stack depth?
//  - might need to insert a special token at the end of an expansion
//    to know when to release the frame?
const MAX_STACK_DEPTH = 100;

/** Token types that finish off a value so a `::` after one qualifies it. */
const VALUE_END: ReadonlySet<string> = new Set(['num', 'str', 'rb', 'rp', 'rc', 'grp']);

/** Expr ops that only need a symbol's segment identity, not its value. */
const BANK_QUERY_OPS: ReadonlySet<string> = new Set(['^', '.bankbyte', '.addrsize']);

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

/**
 * Which substitutions a walk over a line performs.
 * `DEFINES` is for the C-like textual substitutions that run for all inputs 
 * `FUNCTIONS` is the token functions like .ident
 * We split this so that when reading in preprocessor blocks, we can continue
 * running `define` substitution without expanding the functions like `.ident`
 */
const enum Layer {
  DEFINES = 1,
  FUNCTIONS = 2,
  ALL = DEFINES | FUNCTIONS,
}

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
  /** Sink for the conditional branches this run skipped. Only set by the LSP. */
  readonly inactiveRegionIndex?: InactiveRegionIndex;

  /** Depth marker for nesting blocks that need to be expanded raw */
  private rawMode = 0;

  constructor(readonly stream: TokenStream, readonly env: Env,
              parent?: Preprocessor,
              readonly errorCollector?: ErrorCollector,
              macroIndex?: MacroIndex,
              inactiveRegionIndex?: InactiveRegionIndex) {
    this.macros = parent ? parent.macros : new Map();
    if (!errorCollector && parent?.errorCollector) {
      this.errorCollector = parent.errorCollector;
    }
    // Nested preprocessors share the parent's index, the same way they share
    // the macro map itself.
    this.macroIndex = macroIndex ?? parent?.macroIndex;
    this.inactiveRegionIndex = inactiveRegionIndex ?? parent?.inactiveRegionIndex;
  }


  next(): Token[] | undefined {
    while (true) {
      // Drain any output already produced for a previous source line.
      if (this.outQueue.length) return this.outQueue.shift();
      let more: boolean;
      try {
        more = this.pump();
      } catch (err) {
        this.recover(err);
        continue;
      }
      if (!more) return undefined; // EOF
    }
  }

  /**
   * Decide what to do with an error thrown while processing a line: return to
   * abandon the rest of that line and keep going, throw to stop the run.
   */
  private recover(err: unknown): void {
    if (err instanceof RecoverableError) {
      // Error already recorded; abandon the rest of the current line but
      // keep any output it produced before the error, then continue.
      return;
    }
    // `.fatal`, cancellation and the error cap stop the whole run.
    if (err instanceof FatalError) throw err;
    // Try to recover if we have an error collector by skipping the rest of the line
    if (err instanceof SourceError && this.errorCollector) {
      if (!err.recorded) {
        err.recorded = true;
        this.errorCollector.addFromException(err);
      }
      return;
    }
    throw err;
  }

  // Read and process the next source line, pushing zero or more output lines
  // onto `outQueue`. Returns false at EOF, true otherwise.
  private pump(): boolean {
    const line = this.readLine();
    if (line == null) return false; // EOF
    return this.pumpLine(line);
  }

  private pumpLine(line: Token[]): boolean {
    while (line.length) {
      const front = line[0];
      switch (front.token) {
        case 'ident': {
          // Possibilities: (1) label, (2) instruction/assign, (3) macro
          // Labels get split out.  We don't distinguish assigns yet.
          const callable = this.isCallable(front.str);
          if (!callable && Tokens.eq(line[1], Tokens.COLON)) {
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
          } else if (!callable && this.env.allowsLabelWithoutColon()) {
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
        }

        case 'cs': {
          const ran = this.tryRunDirective(line);
          if (!ran) this.outQueue.push(line);
          return true;
        }

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
  private readLine(): Token[]|undefined {
    const line = this.stream.next();
    if (line == null) return line;
    return this.expandLine(line);
  }

  ////////////////////////////////////////////////////////////////
  // EXPANSION

  private expandDefines(line: Token[], pos = 0): Token[] {
    return this.expandLayers(line, Layer.DEFINES, pos);
  }

  private expandLine(line: Token[], pos = 0): Token[] {
    // Only expand functions when we aren't processing a function body
    // like a macro, .if block, etc
    const layers = this.rawMode ? Layer.DEFINES : Layer.ALL;
    return this.expandLayers(line, layers, pos);
  }

  private inRawMode<T>(f: () => T): T {
    this.rawMode++;
    try {
      return f();
    } finally {
      this.rawMode--;
    }
  }

  /** Stream with defines applied and returns the define replacements in the stream */
  private readonly defineExpanded: Tokens.Source = {
    next: () => {
      const line = this.stream.next();
      return line == null ? line : this.expandDefines(line);
    },
  };

  private collectBody<T>(f: (source: Tokens.Source) => T): T {
    return this.inRawMode(() => f(this.defineExpanded));
  }

  /** Branch tests are evaluated live, so they need the functions back. */
  private outsideRawMode<T>(f: () => T): T {
    const saved = this.rawMode;
    this.rawMode = 0;
    try {
      return f();
    } finally {
      this.rawMode = saved;
    }
  }

  private expandLayers(line: Token[], layers: Layer, pos: number): Token[] {
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
      pos = this.expandToken(line, pos, layers);
    }
    return line;
  }

  /** Whether a name is an instruction or a `.macro`, and so can't be a scope. */
  private isCallable(name: string): boolean {
    return this.macros.get(name) instanceof Macro || this.env.isMnemonic(name);
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
  private expandToken(line: Token[], pos: number,
                      layers: Layer = Layer.ALL): number {
    const front = line[pos]!;
    if (front.token === 'ident') {
      if (!(layers & Layer.DEFINES)) return pos + 1;
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
      // mergeScopePrefix shares this cursor with Define.expand so must stay
      // in the define layer
      return this.mergeScopePrefix(line, pos) + 1;
    } else if (front.token === 'cs') {
      return this.expandDirective(front.str, line, pos, layers);
    } else if (front.token === 'grp') {
      // Expand the { ... } lists immediately instead of passing it
      // down to the callee
      this.expandLayers(front.inner, layers, 0);
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

  private expandDirective(directive: string, line: Token[], i: number,
                          layers: Layer = Layer.ALL): number {
    // Handling for the DEFINES layer
    switch (directive) {
      case '.define':
      case '.delmacro':
      case '.ifdef':
      case '.ifndef':
      case '.undefine':
        return this.skipIdentifier(line, i);
      case '.skip': return this.skip(line, i, layers);
      case '.noexpand': return this.noexpand(line, i);
    }
    if (!(layers & Layer.FUNCTIONS)) return i + 1;
    // Handling for the FUNCTIONS layer
    switch (directive) {
      case '.tcount': return this.parseArgs(line, i, 1, this.tcount, layers);
      case '.match': return this.parseArgs(line, i, 2, this.matchTokens, layers);
      case '.xmatch': return this.parseArgs(line, i, 2, this.xmatchTokens, layers);
      case '.left': return this.parseArgs(line, i, 2, this.left, layers);
      case '.right': return this.parseArgs(line, i, 2, this.right, layers);
      case '.mid': return this.parseArgs(line, i, 3, this.mid, layers);
      case '.ident': return this.parseArgs(line, i, 1, this.ident, layers);
      case '.string': return this.parseArgs(line, i, 1, this.string, layers);
      case '.concat': return this.parseArgs(line, i, 0, this.concat, layers);
      case '.sprintf': return this.parseArgs(line, i, 0, this.sprintf, layers);
      case '.cond': return this.parseArgs(line, i, 3, this.cond, layers);
      case '.blank':
        return this.parseArgs(line, i, 1, this.blank, layers);
      case '.const':
        return this.parseArgs(line, i, 1, this.constExpr, layers);
      case '.defined':
        return this.parseArgs(line, i, 1, this.definedSymbol, layers);
      case '.definedmacro':
        return this.parseArgs(line, i, 1, this.definedMacro, layers);
      case '.definedsymbol':
        return this.parseArgs(line, i, 1, this.definedSymbol, layers);
      case '.ismnemonic':
        return this.parseArgs(line, i, 1, this.isMnemonic, layers);
      case '.constantsymbol':
        return this.parseArgs(line, i, 1, this.constantSymbol, layers);
      case '.referencedsymbol':
        return this.parseArgs(line, i, 1, this.referencedSymbol, layers);
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
  private skip(line: Token[], i: number, layers: Layer = Layer.ALL): number {
    // expand i + 1, then splice self out
    line.splice(i, 1);
    const skipped = line[i];
    if (skipped?.token === 'grp') {
      this.expandToken(skipped.inner, 0, layers);
    } else {
      this.expandToken(line, i + 1, layers);
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
                         ...args: Token[][]) => Token[],
                    layers: Layer = Layer.ALL): number {
    const cs = line[i];
    Tokens.expect(Tokens.LP, line[i + 1], cs);
    const end = Tokens.findBalanced(line, i + 1);
    const args =
        Tokens.parseArgList(line, i + 2, end).map(ts => {
          if (ts.length === 1 && ts[0].token === 'grp') ts = ts[0].inner;
          return this.expandLayers(ts, layers, 0);
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

  tryRunDirective(line: Token[]): boolean {
    const first = line[0];
    if (first.token !== 'cs') throw new Error(`impossible`);
    const handler = this.runDirectives[first.str];
    if (!handler) return false;
    handler(line);
    return true;
  }

  /**
   * Resolve the expression, reducing constant expressions along the way.
   * @param addresses Whether `*` and labels may stand in for their address value
   * `.const` needs them as labels, but other callers want them as addresses.
   */
  private reduceConst(expr: Expr, addresses: boolean): {value: number}|{reduced: Expr} {
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
    if (v !== undefined) return {value: v};
    return {reduced: Exprs.traversePost(expr, evalWrapper)};
  }

  private failNotConstant(reduced: Expr, source?: Token): never {
    const desc = reduced.op === 'sym' ? `symbol ${reduced.sym}` : `${reduced.op} expression`;
    Tokens.fail(`Expected a constant: ${desc}`, reduced.source ?? source);
  }

  evaluateConst(expr: Expr, source?: Token, addresses = true): number {
    const r = this.reduceConst(expr, addresses);
    if ('value' in r) return r.value;
    this.failNotConstant(r.reduced, source);
  }

  evaluateConstOrDefer(expr: Expr, source?: Token): {value: number}|{deferred: true} {
    const r = this.reduceConst(expr, true);
    if ('value' in r) return r;
    if (this.canDefer(r.reduced)) return {deferred: true};
    this.failNotConstant(r.reduced, source);
  }

  /** Returns true when the expression is possibly known at link time */
  private canDefer(ex: Expr): boolean {
    if (ex.op === 'num' && !ex.meta?.rel) return true;
    if (ex.op === 'im' && ex.sym != null) return true;
    if (ex.meta?.rel && ex.meta?.chunk != null) return true;
    if (ex.op === 'sym' && ex.sym != null) return this.env.definedSymbol(ex.sym);
    if (!ex.args?.length) return false;
    // For bank ops, we can allow deferring since they only care about the bank list not actual bank num
    if (BANK_QUERY_OPS.has(ex.op) && ex.args.length === 1 &&
        ex.args[0].op === 'sym' && ex.args[0].sym != null) {
      return true;
    }
    return ex.args.every(arg => this.canDefer(arg));
  }

  private readonly runDirectives:
      Record<string, (ts: Token[]) => void> = {
    '.define': (line) => this.parseDefine(line),
    '.delmacro': (line) => this.parseDelMacro(line),
    '.undefine': (line) => this.parseUndefine(line),
    '.else': (line) => isDeferredMarker(line[0]) ? this.outQueue.push(line) : badClose('.if', line[0]),
    '.elseif': (line) => isDeferredMarker(line[0]) ? this.outQueue.push(line) : badClose('.if', line[0]),
    '.endif': (line) => isDeferredMarker(line[0]) ? this.outQueue.push(line) : badClose('.if', line[0]),
    '.endmacro': ([cs]) => badClose('.macro', cs),
    '.endrepeat': (line) => this.parseEndRepeat(line),
    '.exitmacro': ([, a]) => { noGarbage(a); this.stream.exit(); },
    '.if': (line) => {
      if (isDeferredMarker(line[0])) { this.outQueue.push(line); return; }
      const [cs, ...args] = line;
      const expr = parseOneExpr(args, cs, this.env.encodeChar);
      this.parseIf(() => {
        const r = this.evaluateConstOrDefer(expr, cs);
        return 'deferred' in r ? r : {value: !!r.value};
      }, line);
    },
    '.ifdef': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: this.parseIfDef(args, cs)}), line);
    },
    '.ifndef': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: !this.parseIfDef(args, cs)}), line);
    },
    '.ifblank': (line) => this.parseIf(() => ({value: line.length <= 1}), line),
    '.ifnblank': (line) => this.parseIf(() => ({value: line.length > 1}), line),
    '.ifref': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: this.env.referencedSymbol(parseOneIdent(args, cs))}), line);
    },
    '.ifnref': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: !this.env.referencedSymbol(parseOneIdent(args, cs))}), line);
    },
    '.ifsym': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: this.env.definedSymbol(parseOneIdent(args, cs))}), line);
    },
    '.ifnsym': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: !this.env.definedSymbol(parseOneIdent(args, cs))}), line);
    },
    '.ifconst': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: this.env.constantSymbol(parseOneIdent(args, cs))}), line);
    },
    '.ifnconst': (line) => {
      const [cs, ...args] = line;
      this.parseIf(() => ({value: !this.env.constantSymbol(parseOneIdent(args, cs))}), line);
    },
    // NOTE: If support for any other CPUs is added, these will need to be un-stubbed.
    '.ifp02': (line) => this.parseIf(() => ({value: true}), line),
    '.ifp4510': (line) => this.parseIf(() => ({value: false}), line),
    '.ifp816': (line) => this.parseIf(() => ({value: false}), line),
    '.ifpc02': (line) => this.parseIf(() => ({value: false}), line),
    '.ifpdtv': (line) => this.parseIf(() => ({value: false}), line),
    '.ifpsc02': (line) => this.parseIf(() => ({value: false}), line),
    '.incbin': (line) => this.parseIncbin(line),
    '.include': (line) => this.parseInclude(line),
    '.macpack': (line) => this.parseMacpack(line),
    '.macro': (line) => this.parseMacro(line),
    '.repeat': (line) => this.parseRepeat(line),
  };

  private parseInclude(line: Token[]) {
    const [cs, ...rest] = line;
    const path = Tokens.expectString(rest[0], cs);
    Tokens.expectEol(rest[1], 'a single string');
    this.stream.include(path, cs);
  }

  private parseMacpack(line: Token[]) {
    const [cs, ident, eol] = line;
    const pack = Tokens.expectIdentifier(ident, cs).toLowerCase();
    Tokens.expectEol(eol);
    this.stream.macpack(pack, cs);
  }

  /**
   * `.incbin "file"[, offset[, length]]` reads the bytes now and hands the
   * assembler a `.bytestr` line.
   */
  private parseIncbin(line: Token[]) {
    const cs = line[0];
    const args = Tokens.parseArgList(line, 1);
    const [file, ...rest] = args;
    const path = Tokens.expectString(file[0], cs);
    Tokens.expectEol(file[1], 'a single string');
    if (rest.length > 2) Tokens.fail(`Too many arguments for .incbin`, cs);
    const [offset, length] = rest.map(
        arg => this.evaluateConst(parseOneExpr(arg, cs, this.env.encodeChar), cs));
    const bin = this.stream.incbin(path, offset ?? 0, length, cs);
    const bytestr: Token = cs.source ? {...Tokens.BYTESTR, source: cs.source}
                                     : Tokens.BYTESTR;
    this.outQueue.push([bytestr, {token: 'str', str: bin}]);
  }

  parseDefine(line: Token[]) {
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
  }

  private parseUndefine(line: Token[]) {
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
  }

  /** `.delmacro` deletes a classic `.macro` the counterpart of `.undefine`. */
  private parseDelMacro(line: Token[]) {
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
  }

  private parseMacro(line: Token[]): void {
    const name = Tokens.expectIdentifier(line[1], line[0]);
    const macro = this.collectBody(source => Macro.from(line, source));
    const prev = this.macros.get(name);
    if (prev) Tokens.fail(`Already defined: ${name}`, line[1]);
    this.macros.set(name, macro);
    this.macroIndex?.record(name, 'macro', macro, macro.definition?.source);
  }

  private parseRepeat(line: Token[]): void {
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
    let last = line;
    this.collectBody(source => Tokens.pullLines(source, next => {
      last = next ?? Tokens.fail(`.repeat with no .endrep`, start);
      if (Tokens.eq(last[0], Tokens.REPEAT)) depth++;
      if (Tokens.eq(last[0], Tokens.ENDREPEAT)) depth--;
      lines.push(last);
      return depth > 0;
    }));
    this.repeats.push([lines, times, -1, ident]);
    this.parseEndRepeat(last);
  }

  private parseEndRepeat(line: Token[]) {
    Tokens.expectEol(line[1]);
    const top = this.repeats.pop();
    if (!top) Tokens.fail(`.endrep with no .repeat`, line[0]);
    if (++top[2] >= top[1]) return;
    this.repeats.push(top);
    this.stream.unshift(...top[0].map(line => line.map(token => {
      if (token.token !== 'ident' || token.str !== top[3]) return token;
      const t: Token = {token: 'num', num: top[2]};
      if (token.source) t.source = token.source;
      return t;
    })));
  }

  /**
   * Evaluate a conditional's test, treating a failure as false, which
   * lets us still properly parse the `.if` itself.
   * Process the args in a callable so that we can catch any errors
   * inside the `.if` block and recover.
   */
  private condition(test: () => {value: boolean}|{deferred: true}, at?: Token):
      {value: boolean}|{deferred: true} {
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
      return {value: false};
    }
  }

  private parseIf(test: () => {value: boolean}|{deferred: true}, line: Token[]): void {
    const at = line[0];
    const raw: Token[][] = [line];
    const markerIdx: number[] = [0];
    const outcome = this.condition(test, at);
    let deferred = 'deferred' in outcome;
    let cond = deferred ? false : (outcome as {value: boolean}).value;
    let depth = 1;
    let done = false;
    const result: Token[][] = [];
    // The LSP greys out the branches this run drops. Branch markers themselves
    // (`.if`, `.elseif`, `.else`, `.endif`) stay lit, so switching branches
    // ends the run rather than extending it across the directive line.
    const dead = this.inactiveRegionIndex;
    this.collectBody(source => Tokens.pullLines(source, line => {
      // Report missing endif at the site of the starting .if
      if (!line) Tokens.fail(`EOF looking for .endif`, at);
      raw.push(line);
      const front = line[0];
      if (Tokens.eq(front, Tokens.ENDIF)) {
        depth--;
        if (!depth) {
          markerIdx.push(raw.length - 1);
          if (!deferred) dead?.flush();
          return false;
        }
      } else if (front.token === 'cs' && front.str.startsWith('.if')) {
        depth++;
      } else if (depth === 1 && !done) {
        if (!deferred && cond && (Tokens.eq(front, Tokens.ELSE) ||
                     Tokens.eq(front, Tokens.ELSEIF))) {
          // if true ... else .....
          markerIdx.push(raw.length - 1);
          cond = false;
          done = true;
          return true;
        } else if (Tokens.eq(front, Tokens.ELSEIF)) {
          // if false ... else if .....
          markerIdx.push(raw.length - 1);
          if (deferred) return true; // chain already deferred so stop evaluating
          dead?.flush();
          const elseOutcome = this.condition(() => this.outsideRawMode(() => {
            const r = this.evaluateConstOrDefer(
                parseOneExpr(this.expandLine(line.slice(1)), front, this.env.encodeChar),
                front);
            return 'deferred' in r ? r : {value: !!r.value};
          }), front);
          if ('deferred' in elseOutcome) { deferred = true; return true; }
          cond = elseOutcome.value;
          return true;
        } else if (Tokens.eq(front, Tokens.ELSE)) {
          // if false ... else .....
          markerIdx.push(raw.length - 1);
          if (deferred) return true;
          dead?.flush();
          cond = true;
          return true;
        }
      }
      // anything else on the line
      if (deferred) return true;
      if (cond) {
        result.push(line);
        // Only this level's verdict is final. A line inside a nested `.if` is
        // re-decided when that block is unshifted and parsed in turn, so
        // calling it live here would override the inner branch that drops it.
        if (depth === 1) dead?.keepLine(sourceOfLine(line));
      } else {
        dead?.skipLine(sourceOfLine(line));
      }
      return true;
    }));
    if (deferred) {
      // Tag this depth's own markers so the late pass sends them straight
      // through instead of re-entering `parseIf`
      for (const i of markerIdx) {
        const [marker, ...rest] = raw[i];
        const tagged: Tokens.StringToken = {...(marker as Tokens.StringToken), deferred: true};
        raw[i] = [tagged, ...rest];
      }
      this.stream.unshift(...raw);
      return;
    }
    dead?.flush();
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

function sourceOfLine(line: Token[]): SourceInfo | undefined {
  for (const t of line) {
    if (t.source) return t.source;
  }
  return undefined;
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

function isDeferredMarker(tok: Token): boolean {
  return tok.token === 'cs' && !!tok.deferred;
}
