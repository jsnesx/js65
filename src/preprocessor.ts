
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
import type {Assembler} from './assembler.ts';

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

// Unique IDs are per Assembler so nested preprocessors share them.
const ID_MAP = new WeakMap<Assembler, {next(): number}>();
function idGen(asm: Assembler): {next(): number} {
  let id = ID_MAP.get(asm);
  if (!id) ID_MAP.set(asm, id = (num => ({next: () => num++}))(0));
  return id;
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

/** `deferred` means only the late pass can decide it. */
type CondResult = {value: boolean}|{deferred: true};

/**
 * An open conditional. `pending` has taken no arm yet, `done` has, and
 * `guessed` is pass 1 skipping to `.else` until the late pass decides.
 */
interface CondFrame {
  /** The `.if*` token, for "missing .endif" errors */
  at: Token;
  state: 'live'|'pending'|'done'|'guessed';
  /** TokenStream depth when opened, so `.exitmacro` can close it */
  depth: number;
}

export class Preprocessor {
  private readonly macros: Map<string, Define|Macro|string>;

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

  private readonly conds: CondFrame[] = [];

  constructor(readonly stream: TokenStream, readonly asm: Assembler,
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


  /** Preprocesses the whole stream, handing each statement to the assembler. */
  run(signal?: { readonly aborted: boolean }): void {
    // Checked before reading so nothing past `.end` is even tokenized.
    while (!this.asm.ended) {
      if (signal?.aborted) throw new FatalError('Compilation cancelled');
      try {
        const line = this.readLine();
        if (line == null) return;
        this.pumpLine(line);
      } catch (err) {
        this.recover(err);
      }
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

  private pumpLine(line: Token[]): void {
    while (line.length) {
      const front = line[0];
      switch (front.token) {
        case 'ident': {
          // Possibilities: (1) label, (2) instruction/assign, (3) macro
          // Labels get split out.
          const callable = this.macros.get(front.str) instanceof Macro ||
              (this.asm.isMnemonic(front.str) &&
               !this.asm.allowsUbiquitousIdents());
          if (!callable && Tokens.eq(line[1], Tokens.COLON)) {
            const label = line.splice(0, 2);
            // Remember that data followed the label on its source line, since
            // that's what `.sizeof(label)` measures and the split loses it.
            if (line.length) label[0] = Tokens.labelsData(front);
            this.asm.line(label);
            break;
          }
          const assigns = Tokens.eq(line[1], Tokens.ASSIGN) ||
              Tokens.eq(line[1], Tokens.ASSIGN_LABEL) || Tokens.eq(line[1], Tokens.SET);
          if (!assigns && !callable && this.asm.allowsLabelWithoutColon()) {
            // Same split as the `foo:` case above, but there isn't a colon,
            // so we just add one here to use the regular label code path.
            line.splice(0, 1);
            const label: Token[] =
                [line.length ? Tokens.labelsData(front) : front, Tokens.COLON];
            this.asm.line(label);
            break;
          }
          if (this.asm.allowsMultiOpsPerLine() &&
              this.startsStatement(front.str)) {
            const split = this.findNextStatement(line);
            if (split > 0) {
              const rest = line.splice(split);
              const macro = this.macros.get(front.str);
              if (macro instanceof Macro) {
                this.stream.unshift(rest);
                this.tryExpandMacro(line);
                return;
              }
              this.asm.line(line);
              line = rest;
              break;
            }
          }
          if (!this.tryExpandMacro(line)) this.asm.line(line);
          return;
        }

        case 'cs': {
          const ran = this.tryRunDirective(line);
          if (!ran) this.asm.line(line);
          return;
        }

        case 'op':
          // `* = $8000`, which is just another spelling of `.org $8000`.
          if (front.str === '*' && Tokens.eq(line[1], Tokens.ASSIGN)) {
            if (!this.asm.allowsPcAssignment()) {
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
            this.asm.line(label);
            break;
          } else if (front.str === ':') {
            this.asm.line(line.splice(0, 1));
            break;
          }
          /* fallthrough */
        default:
          Tokens.fail(`Unexpected: ${Tokens.nameOf(line[0])}`, line[0]);
      }
    }
  }

  // Expand a single line of tokens from the front of toks.
  private readLine(): Token[]|undefined {
    for (;;) {
      const line = this.stream.next();
      if (line == null) return this.endOfInput();
      const n = this.conds.length;
      if (n === 0) return this.expandLine(line);
      const top = this.conds[n - 1];
      if (top.state === 'live') {
        this.inactiveRegionIndex?.keepLine(sourceOfLine(line));
        return this.expandLine(line);
      }
      this.skipDeadLine(line, top);
    }
  }

  private endOfInput(): undefined {
    if (!this.conds.length) return undefined;
    const at = this.conds[0].at;
    this.conds.length = 0;
    Tokens.fail(`EOF looking for .endif`, at);
  }

  /** Drops a line in an untaken arm, acting only on conditionals. */
  private skipDeadLine(line: Token[], top: CondFrame): void {
    const dead = this.inactiveRegionIndex;
    let front = line[0];
    // Defines sit below the gate, so one can still open or close a block.
    if (front?.token === 'ident' && this.macros.get(front.str) instanceof Define) {
      this.expandDefines(line);
      front = line[0];
    }
    if (!front) return;
    if (front.token === 'cs') {
      switch (front.str) {
        case '.endif': {
          this.conds.pop();
          const parent = this.conds[this.conds.length - 1];
          if (!parent || parent.state === 'live') {
            dead?.flush();
          } else {
            dead?.skipLine(sourceOfLine(line));
          }
          return;
        }
        case '.else':
          if (top.state !== 'pending' && top.state !== 'guessed') break;
          dead?.flush();
          top.state = 'live';
          return;
        case '.elseif':
          if (top.state !== 'pending') break;
          dead?.flush();
          this.elseIf(line, top);
          return;
        case '.include':
        case '.incbin':
          this.preload(line, front.str === '.incbin');
          break;
        default:
          if (front.str.startsWith('.if')) {
            this.conds.push({at: front, state: 'done', depth: this.stream.depth});
          }
      }
    }
    dead?.skipLine(sourceOfLine(line));
  }

  /** Records a file a guessed arm names, since the late pass may take it. */
  private preload(line: Token[], binary: boolean): void {
    const path = line[1];
    if (path?.token !== 'str' || !this.conds.some(f => f.state === 'guessed')) return;
    this.stream.preload(path.str, binary);
  }

  /** Evaluates an `.elseif` reached while no arm has been taken. */
  private elseIf(line: Token[], top: CondFrame): void {
    const cs = line[0];
    const outcome = this.condition(() => {
      this.expandLayers(line, Layer.ALL, 1);
      return this.ifValue(parseOneExpr(line.slice(1), cs, this.asm.encodeChar), line);
    }, cs);
    top.state = armState(outcome);
  }

  private ifValue(expr: Expr, line: Token[]): CondResult {
    const r = this.evaluateConstOrDefer(expr, line[0]);
    if (!('deferred' in r)) return {value: !!r.value};
    const late = this.asm.lateCondition(line);
    return late === undefined ? r : {value: late};
  }

  private openIf(line: Token[], test: () => CondResult): void {
    const at = line[0];
    const state = armState(this.condition(test, at));
    this.conds.push({at, state, depth: this.stream.depth});
  }

  /** `.else`/`.elseif` reached from a live arm. */
  private nextBranch(line: Token[]): void {
    const top = this.conds[this.conds.length - 1];
    if (!top) badClose('.if', line[0]);
    top.state = 'done';
  }

  private closeIf(line: Token[]): void {
    if (!this.conds.pop()) badClose('.if', line[0]);
    this.inactiveRegionIndex?.flush();
  }

  private exitMacro(): void {
    this.stream.exit();
    const depth = this.stream.depth;
    while (this.conds.length && this.conds[this.conds.length - 1].depth > depth) {
      this.conds.pop();
    }
  }

  ////////////////////////////////////////////////////////////////
  // EXPANSION

  private expandDefines(line: Token[], pos = 0): Token[] {
    return this.expandLayers(line, Layer.DEFINES, pos);
  }

  private expandLine(line: Token[], pos = 0): Token[] {
    // Only expand functions when we aren't processing a function body
    // like a macro or .repeat
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

  private expandLayers(line: Token[], layers: Layer, pos: number): Token[] {
    const front = line[0];
    let depth = 0;
    let maxPos = 0;
    while (pos < line.length) {
      // expandToken checks for ident/cs/grp tokens directly, but for performance
      // skip over anything else here to avoid the function call overhead. this
      // matters here because its the preprocessor and we run this a lot
      const token = line[pos].token;
      if (token !== 'ident' && token !== 'cs' && token !== 'grp') {
        if (pos > maxPos) maxPos = pos;
        pos++;
        continue;
      }
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

  private checkNotMnemonic(name: string, at: Token): void {
    if (this.asm.isMnemonic(name) && !this.asm.allowsUbiquitousIdents()) {
      Tokens.fail(`Macro may not be named after the instruction ${name} ` +
                  `(enable it with '.feature ubiquitous_idents')`, at);
    }
  }

  /** Whether a name is an instruction or a `.macro`, and so can't be a scope. */
  private isCallable(name: string): boolean {
    return this.macros.get(name) instanceof Macro || this.asm.isMnemonic(name);
  }

  /**
   * For feature multiops_per_line, check if this is an allowed
   * type for starting a new statement
   */
  private startsStatement(name: string): boolean {
    const macro = this.macros.get(name);
    if (macro instanceof Macro) return !macro.params.length;
    return this.asm.isMnemonic(name);
  }

  /**
   * Search this line until we reach the end of this instruction to find the
   * start of another Statement (zero param macro or opcode). Return -1 if not found
   */
  private findNextStatement(line: Token[]): number {
    let depth = 0;
    for (let i = 1; i < line.length; i++) {
      const tok = line[i];
      switch (tok.token) {
        case 'lp': case 'lb': depth++; continue;
        case 'rp': case 'rb': depth--; continue;
        case 'ident': break;
        default: continue;
      }
      if (depth) continue;
      if (Tokens.eq(line[i + 1], Tokens.COLON)) {
        Tokens.fail(`A label must start its own line: ${tok.str}`, tok);
      }
      if (!this.startsStatement(tok.str)) continue;
      switch (line[i - 1].token) {
        case 'num': case 'str': case 'ident': case 'rp': case 'rb': case 'grp':
          return i;
      }
    }
    return -1;
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
          if (overflow.length) this.stream.unshift(...overflow);
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
    const expansion = macro.expand(line, idGen(this.asm));
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
    return [Tokens.numToken(Tokens.count(arg), cs.source)];
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
    return [Tokens.numToken(Preprocessor.tokensEqual(a, b, false) ? 1 : 0, cs.source)];
  }

  private xmatchTokens(cs: Token, a: Token[], b: Token[]) : Token[] {
    return [Tokens.numToken(Preprocessor.tokensEqual(a, b, true) ? 1 : 0, cs.source)];
  }

  private constCount(toks: Token[], cs: Token): number {
    try {
      return this.evaluateConst(parseOneExpr(toks, cs, this.asm.encodeChar), cs);
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
            arg = this.evaluateConst(parseOneExpr(argToks, prevTok, this.asm.encodeChar));

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
    const v = this.evaluateConst(parseOneExpr(cond, cs, this.asm.encodeChar), cs);
    return v ? ifTrue : ifFalse;
  }

  private blank(cs: Token, arg: Token[]) : Token[] {
    return [Tokens.numToken(arg.length === 0 ? 1 : 0, cs.source)];
  }

  /** `.const(expr)` is 1 when the expression is already known, 0 otherwise. */
  private constExpr(cs: Token, arg: Token[]) : Token[] {
    const expr = parseOneExpr(arg, cs, this.asm.encodeChar);
    let known = true;
    try {
      // `*` and labels have a value here, but it's an address rather than a
      // constant, so `.const` says no to them the way ca65 does.
      this.evaluateConst(expr, cs, false);
    } catch {
      known = false; // `*`, forward references and imports are not constant
    }
    return [Tokens.numToken(known ? 1 : 0, cs.source)];
  }

  /**
   * `.definedmacro` checks only for `.macro` and not the c-style `.define` macros
   */
  private definedMacro(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [Tokens.numToken(this.macros.get(ident) instanceof Macro ? 1 : 0,
                            cs.source)];
  }

  /** Checks if the current CPU setting supports this mnemonic */
  private isMnemonic(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [Tokens.numToken(this.asm.isMnemonic(ident) ? 1 : 0, cs.source)];
  }

  private definedSymbol(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [Tokens.numToken(this.asm.definedSymbol(ident) ? 1 : 0, cs.source)];
  }

  private constantSymbol(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [Tokens.numToken(this.asm.constantSymbol(ident) ? 1 : 0, cs.source)];
  }

  private referencedSymbol(cs: Token, arg: Token[]) : Token[] {
    const ident = Tokens.expectIdentifier(arg[0], cs);
    Tokens.expectEol(arg[1], 'a single identifier');
    return [Tokens.numToken(this.asm.referencedSymbol(ident) ? 1 : 0, cs.source)];
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
        const val = this.asm.definedValue(ex.sym);
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
    if (ex.op === 'sym' && ex.sym != null) return this.asm.definedSymbol(ex.sym);
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
    '.else': (line) => this.nextBranch(line),
    '.elseif': (line) => this.nextBranch(line),
    '.endif': (line) => this.closeIf(line),
    '.endmacro': ([cs]) => badClose('.macro', cs),
    '.endrepeat': (line) => this.parseEndRepeat(line),
    '.exitmacro': ([, a]) => { noGarbage(a); this.exitMacro(); },
    '.if': (line) => {
      const [cs, ...args] = line;
      const expr = parseOneExpr(args, cs, this.asm.encodeChar);
      this.openIf(line, () => this.ifValue(expr, line));
    },
    '.ifdef': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: this.parseIfDef(args, cs)}));
    },
    '.ifndef': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: !this.parseIfDef(args, cs)}));
    },
    '.ifblank': (line) => this.openIf(line, () => ({value: line.length <= 1})),
    '.ifnblank': (line) => this.openIf(line, () => ({value: line.length > 1})),
    '.ifref': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: this.asm.referencedSymbol(parseOneIdent(args, cs))}));
    },
    '.ifnref': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: !this.asm.referencedSymbol(parseOneIdent(args, cs))}));
    },
    '.ifsym': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: this.asm.definedSymbol(parseOneIdent(args, cs))}));
    },
    '.ifnsym': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: !this.asm.definedSymbol(parseOneIdent(args, cs))}));
    },
    '.ifconst': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: this.asm.constantSymbol(parseOneIdent(args, cs))}));
    },
    '.ifnconst': (line) => {
      const [cs, ...args] = line;
      this.openIf(line, () => ({value: !this.asm.constantSymbol(parseOneIdent(args, cs))}));
    },
    // NOTE: If support for any other CPUs is added, these will need to be un-stubbed.
    '.ifp02': (line) => this.openIf(line, () => ({value: true})),
    '.ifp4510': (line) => this.openIf(line, () => ({value: false})),
    '.ifp816': (line) => this.openIf(line, () => ({value: false})),
    '.ifpc02': (line) => this.openIf(line, () => ({value: false})),
    '.ifpdtv': (line) => this.openIf(line, () => ({value: false})),
    '.ifpsc02': (line) => this.openIf(line, () => ({value: false})),
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
        arg => this.evaluateConst(parseOneExpr(arg, cs, this.asm.encodeChar), cs));
    const bin = this.stream.incbin(path, offset ?? 0, length, cs);
    const bytestr: Token = cs.source ? {...Tokens.BYTESTR, source: cs.source}
                                     : Tokens.BYTESTR;
    this.asm.line([bytestr, {token: 'str', str: bin}]);
  }

  parseDefine(line: Token[]) {
    const name = Tokens.expectIdentifier(line[1], line[0]);
    this.checkNotMnemonic(name, line[1]);
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
    // Checked after the body is collected, so a rejected name doesn't also
    // leave the `.endmacro` dangling.
    this.checkNotMnemonic(name, line[1]);
    const prev = this.macros.get(name);
    if (prev) Tokens.fail(`Already defined: ${name}`, line[1]);
    this.macros.set(name, macro);
    this.macroIndex?.record(name, 'macro', macro, macro.definition?.source);
  }

  private parseRepeat(line: Token[]): void {
    const [expr, end] = Exprs.parse(line, 1, undefined, this.asm.encodeChar);
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
      return Tokens.numToken(top[2], token.source);
    })));
  }

  /**
   * Evaluate a conditional's test, treating a failure as false, which
   * lets us still properly parse the `.if` itself.
   * Process the args in a callable so that we can catch any errors
   * inside the `.if` block and recover.
   */
  private condition(test: () => CondResult, at?: Token): CondResult {
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

  private parseIfDef(args: Token[], cs: Token) {
    return this.macros.has(parseOneIdent(args, cs)) ||
      this.asm.definedSymbol(parseOneIdent(args, cs));
  }
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

function badClose(open: string, tok: Token): never {
  Tokens.fail(`${Tokens.name(tok)} with no ${open}`, tok);
}

function armState(outcome: CondResult): CondFrame['state'] {
  if ('deferred' in outcome) return 'guessed';
  return outcome.value ? 'live' : 'pending';
}
