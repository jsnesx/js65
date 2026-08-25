
// SPDX-License-Identifier: MPL-2.0

import {type Token} from './token.ts'
import { Symbol } from './assembler.ts'
import * as Tokens from './token.ts'

// export interface Expr {
//   op: string;
//   args?: Expr[];
//   num?: number;
//   meta?: Meta;
//   sym?: string;
//   source?: Tokens.SourceInfo;
// }



// export interface Meta {
//   rel?: boolean;
//   chunk?: number;
//   org?: number;
//   bank?: number;
//   offset?: number;
//   size?: number;
// }

/** Extra information for 'num' values. */
export interface Meta {
  /** Whether this is relative to the start of the chunk. */
  rel?: boolean;
  /** Relative chunk the value is defined in. */
  chunk?: number;
  /** Org value of chunk, if known. */
  org?: number;
  /** Bank value of chunk, if known. */
  bank?: number;
  /** Offset value of chunk, if known. */
  offset?: number;
  /** Size hint for number. */
  size?: number;
  /** Whether this is a branch offset (requires signed range checking). */
  branch?: boolean;
  /** Whether the chunk this value lives in is assigned to a zeropage segment. */
  zeropage?: boolean;
}

export interface Expr {
  // TODO - what about different address types? bank hint/etc?
  //      - does bank hint need to get stored in the object file?
  //        - probably not...?

  /**
   * operator (e.g. '+' or '.max') or 'sym', 'num', or 'im'
   * - sym: an offset into the symbols array (or the name in 'sym')
   *  - num: a number literal, or an offset into the symbols array.
   *  - im: an import from another object file (uses 'sym').
   *  - str: a byte array literal
   */
  op: string;
  /** only used when op === 'num' */
  num?: number;
  /** only used when op === 'str' */
  str?: string;
  meta?: Meta;
  /** only used when op === 'sym' */
  sym?: string;
  source?: Tokens.SourceInfo;
  args?: Expr[];
}

function jsSource(e: Expr): {source?: Tokens.SourceInfo} {
  return e.source ?
      {source: {parent: e.source, file: 'js', line: 0, column: 0}} : {};
}

/** Given an Expr, returns a new Expr for the low byte. */
export function loByte(e: Expr) {
  return {op: '<', args: [e], ...jsSource(e)};
}
/** Given an Expr, returns a new Expr for the high byte. */
export function hiByte(e: Expr) {
  return {op: '>', args: [e], ...jsSource(e)};
}

type Rec = (expr: Expr) => Expr; // recurses into children
type Traverser = (expr: Expr, rec: Rec, parent?: Expr) => Expr;

/** Performs a post-order traversal. */
export function traverse(expr: Expr, f: Traverser) {
  function rec(e: Expr) {
    const args = e.args;
    if (!args) return e;
    // Most of the nodes will be unchanged when calling t on it,
    // so skip the spread object clone if we didn't change anything
    let out: Expr[]|undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = t(args[i], e);
      if (!out && arg !== args[i]) out = args.slice(0, i);
      if (out) out.push(arg);
    }
    return out ? {...e, args: out} : e;
  }
  function t(e: Expr, p?: Expr) {
    const source = e.source;
    e = f(e, rec, p);
    if (source && !e.source) e.source = source;
    return e;
  }
  return t(expr);
}

// TODO - does this actually work???
export function traversePost(expr: Expr, f: Rec): Expr {
  return traverse(expr, (expr, rec) => f(rec(expr)));
}

/** LinkTimeEnv interface pasted here to avoid importing it. */
export interface LinkTimeEvalEnv {
  addrSize(sym: string): 1|2|undefined;
  bank(sym: string): number|undefined;
  chunkBank(chunkIndex: number): number|undefined;
}

export function evaluate(expr: Expr, linkEnv?: LinkTimeEvalEnv): Expr {
  const mapped = NAME_MAP.get(expr.op) ?? expr.op;
  switch (mapped) { // var-arg functions
    case '.move':
    case 'im':
    case 'sym':
      // check if the current symbol is a constant number
      // symbolMap?.get(expr.args)
      return expr;
    case 'num':
      if (expr.meta?.rel && expr.meta.org != null) {
        // Remove the 'rel' tag since it's no longer relative.
        // deno-lint-ignore no-unused-vars
        const {rel, ...meta} = expr.meta;
        // TODO - pull size from meta?
        return {op: 'num', num: expr.num! + meta.org!, meta};
      }
      return expr;
    case '.max': return varArg(expr, Math.max);
    case '.min': return varArg(expr, Math.min);
    default: // fall through to later checks
  }

  // Special case for unaries
  if (expr.args?.length === 1) {
    switch (mapped) {
      case '+': return expr.args![0];
      case '-': return unary(expr, x => -x);
      case '~': return unary(expr, x => ~x);
      case '!': return unary(expr, x => +!x);
      case '<': return unary(expr, x => x & 0xff);
      case '>': return unary(expr, x => (x >> 8) & 0xff);
      case '^': {
        // Minor diff between js65, but if you use `^` on an addr instead of
        // a number, then we load the `.bank` value instead of the upper bits
        // 16-23 of the number like ca65 .bankbyte
        const arg = expr.args![0];
        const known = num(arg.meta?.bank);
        if (known) return known;
        // if we are getting a .bank(sym) use bank otherwise look it up
        // from the current chunk with segmentBank
        if ((arg.op === 'im' || arg.op === 'sym') && arg.sym != null) {
          const answer = num(linkEnv?.bank(arg.sym));
          if (answer) return answer;
          return expr; // not resolvable here without the linker
        } else if (arg.meta?.chunk != null) {
          // Addrs (when chunk is not null) are always 16 bit, so don't fall back
          // to the ca65 .bankbyte definition.
          const answer = num(linkEnv?.chunkBank(arg.meta.chunk));
          if (answer) return answer;
          return expr; // not resolvable here without the linker
        }
        return unary(expr, x => (x >>> 16) & 0xff);
      }
      case '.sizeof': {
        const arg = expr.args![0];
        return arg.op === 'sym' ? expr : arg;
      }
      case '.loword': return unary(expr, x => x & 0xffff);
      case '.hiword': return unary(expr, x => (x >>> 16) & 0xffff);
      // `.addrsize(sym)` is 1 for a zeropage symbol and 2 otherwise.  js65 has no
      // far/long segments, so ca65's 3 and 4 are unreachable.
      case '.addrsize': {
        const arg = expr.args![0];
        // Imports carry a one-byte size hint when declared zeropage.
        if (arg.op === 'im') {
          if (arg.meta?.size === 1) return {op: 'num', num: 1, meta: size(1)};
          const answer = linkEnv?.addrSize(arg.sym!);
          return {op: 'num', num: answer ?? 2, meta: size(1)};
        }
        if (arg.op === 'sym' && arg.sym != null) {
          const answer = linkEnv?.addrSize(arg.sym);
          return answer == null ? expr : {op: 'num', num: answer, meta: size(1)};
        }
        if (arg.op !== 'num') return expr;
        return {op: 'num', num: arg.meta?.zeropage ? 1 : 2, meta: size(1)};
      }
      case '.strlen': {
        const arg = expr.args![0];
        if (arg.op !== 'str') Tokens.fail('.strlen requires a string literal', expr);
        return {op: 'num', num: arg.str!.length, meta: size(arg.str!.length)};
      }
      default: Tokens.fail(`Unknown unary operator: ${mapped}`, expr);
    }
  }

  switch (mapped) {
    case 'str': return expr;
    // match checks that the TYPE of the left and right side are the same
    case '.match': return func(expr, (a, b) => a.num && b.num || a.str && b.str || a.sym && b.sym ? 1 : 0);
    // xmatch checks that the CONTENTS of the left and right side are the same
    case '.xmatch': return func(expr, (a, b) =>
      (a.num !== undefined && b.num !== undefined && a.num === b.num) ||
      (a.str !== undefined && b.str !== undefined && a.str === b.str) ||
      (a.sym !== undefined && b.sym !== undefined && a.sym === b.sym) ? 1 : 0);
    case '+': return plus(expr);
    case '-': return minus(expr);
    case '*': return binary(expr, (a, b) => a * b);
    case '/': return binary(expr, (a, b) => {
      if (b === 0) Tokens.fail('Division by zero', expr);
      return Math.trunc(a / b); // ca65 truncates toward zero
    });
    case '.mod': return binary(expr, (a, b) => {
      if (b === 0) Tokens.fail('Modulo operation with zero', expr);
      return a % b;
    });
    case '&': return binary(expr, (a, b) => a & b);
    case '|': return binary(expr, (a, b) => a | b);
    case '^': return binary(expr, (a, b) => a ^ b);
    case '<<': return binary(expr, shift((a, b) => a << b));
    case '>>': return binary(expr, shift((a, b) => a >>> b));
    case '<': return binary(expr, (a, b) => +(a < b));
    case '<=': return binary(expr, (a, b) => +(a <= b));
    case '>': return binary(expr, (a, b) => +(a > b));
    case '>=': return binary(expr, (a, b) => +(a >= b));
    case '=': return binary(expr, (a, b) => +(a == b));
    case '<>': return binary(expr, (a, b) => +(a != b));
    // The boolean operators always reduce to 0 or 1, never to an operand.
    case '&&': return binary(expr, (a, b) => +(!!a && !!b));
    case '||': return binary(expr, (a, b) => +(!!a || !!b));
    case '.xor': return binary(expr, (a, b) => +(!!a !== !!b));
    case '.strat': {
      const [s, idx] = expr.args!;
      if (s.op !== 'str') Tokens.fail('.strat requires a string literal', expr);
      if (idx.op !== 'num') return expr; // not resolvable yet
      const ch = Array.from(s.str!)[idx.num!];
      if (ch === undefined) Tokens.fail('.strat index out of range', expr);
      return {op: 'num', num: ch.codePointAt(0)!, meta: size(ch.codePointAt(0)!)};
    }
    default:
      Tokens.fail(`Unknown operator: ${mapped} Expr: ${JSON.stringify(expr)}`, expr);
  }
}

/** Strip source info from the expression. */
export function strip(expr: Expr) {
  const out = {...expr};
  if (out.args) out.args = out.args.map(strip);
  delete out.source;
  return out;
}

/** Searches for symbols in the expression. */
export function symbols(expr: Expr, out: string[] = []): string[] {
  // NOTE: we don't dedupe with a set because it matters if a symbol
  // shows up twice in the same expression (i.e. it won't be invertible).
  for (const arg of expr.args || []) {
    symbols(arg, out);
  }
  if (expr.op === 'sym' && expr.sym) out.push(expr.sym);
  return out;
}

/** Attempts to solve the given symbol given the final result. */
export function invert(expr: Expr, sym: string, result: number): number|undefined {
  // TODO - make Solver an object that can keep track of extra info,
  // such as combining a < and a > byte to get a full word, or even
  // possibly keeping track of bank?
  switch (expr.op) {
    case 'sym':
      return expr.sym === sym ? result : undefined; // found what we're looking for
    case '.move':
    case 'im':
    case '.max':
    case '.min':
    case 'num':
      return undefined; // can't handle these
    default: // fall through to later checks
  }

  // Special case for unaries
  if (expr.args?.length === 1) {
    const arg = expr.args[0];
    switch (expr.op) {
      case '+': return invert(arg, sym, result);
      case '-': return invert(arg, sym, -result);
      case '~': return invert(arg, sym, ~result);
      // These are slightly lossy
      case '!': return result === +!!result ? invert(arg, sym, result) : undefined;
      case '<': return result === (result & 0xff) ? invert(arg, sym, result) : undefined;
      case '>': return result === (result & 0xff) ? invert(arg, sym, result << 8) : undefined;
      case '^': return undefined;
      default: Tokens.fail(`Unknown unary operator: ${expr.op}`, expr);
    }
  }

  switch (expr.op) {
    case '.mod':
    case '&':
    case '|':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case '=':
    case '<>':
    case '&&':
    case '||':
    case '.xor':
      return undefined;
  }
  // This only leaves the (mostly) invertible operations, but some care
  // about the order, so we need to figure out which arg is constant.
  const leftExpr = evaluate(expr.args![0]);
  const rightExpr = evaluate(expr.args![1]);
  const left = leftExpr.op === 'num' ? leftExpr.num! : undefined;
  const right = rightExpr.op === 'num' ? rightExpr.num! : undefined;
  if ((left == null) === (right == null)) return undefined; // exactly 1 null
  const knownArg = (left || right)!;
  const unknownArg = left == null ? leftExpr : rightExpr;
  switch (expr.op) {
    case '+': return invert(unknownArg, sym, result - knownArg);
    case '-': return invert(unknownArg, sym,
                            left == null ? result + knownArg : knownArg - result);
    case '*': return result % knownArg === 0 ?
                          invert(unknownArg, sym, result / knownArg) : undefined;
    case '/':
      // result = x / known => x = result * known
      if (left == null) return invert(unknownArg, sym, result * knownArg);
      // result = known / x => x = known / result, must go evenly
      if (knownArg % result !== 0) return undefined;
      return invert(unknownArg, sym, knownArg / result);
    case '^': return invert(unknownArg, sym, result ^ knownArg);
    case '<<':
      if (right == null) return undefined;
      if (((result >>> right) << right) !== result) return undefined;
      return invert(unknownArg, sym, result >>> right);
    case '>>':
      if (right == null) return undefined;
      if (((knownArg >>> right) << right) !== knownArg) return undefined;
      return invert(unknownArg, sym, result << right);
    default: Tokens.fail(`Unknown operator: ${expr.op}`, expr);
  }
}

export function identifier(expr: Expr): string {
  if (expr.op === 'sym' && expr.sym) return expr.sym;
  Tokens.fail(`Expected identifier but got op: ${expr.op}`, expr);
}

// /** Returns the identifier. */
// export function identifier(expr: Expr): string {
//   const terms: string[] = [];
//   append(expr);
//   return terms.join('::');
//   function append(e: Expr) {
//     if (e.op === 'ident') {
//       terms.push(e.sym!);
//     } else if (e.op === '::') {
//       if (e.args!.length === 1) terms.push('');
//       e.args!.forEach(append);
//     } else {
//       throw new Error(`Expected identifier but got op: ${e.op}`);
//     }
//   }
// }

/**
 * Pull in the charEncoder from the current Env context if the user has created
 * any charmapped values. This way we can do things like `.if 'a'` where `'a'` was
 * charmapped to some value like `1` or `0` for instance
 */
export type CharEncoder = (char: string) => number|undefined;

export interface SymbolLookup {
  /** Symbol table for already defined symbols. */
  get(name: string): Symbol|undefined;
  /** Check the scopes to size the symbol and return if its zeropage. */
  zeropage?(name: string): boolean;
  /**
   * optional callback that exprs will use to send ALL ident refs seen, even if already defined.
   */
  ref?(name: string, source?: Tokens.SourceInfo): void;
}

/** Parse a single expression, must occupy the rest of the line. */
export function parseOnly(tokens: Token[], index = 0, symbols?: SymbolLookup,
                          charEncoder?: CharEncoder): Expr {
  const [expr, i] = parse(tokens, index, symbols, charEncoder);
  if (i < tokens.length) {
    parse(tokens, index, symbols, charEncoder);
    Tokens.fail(`Garbage after expression: ${Tokens.nameOf(tokens[i])}`, tokens[i]);
  } else if (!expr) {
    throw new Error(`No expression?`);
  }
  return expr;
}

// Returns [undefined, -1] if a bad parse.
// Give up on normal parsing, just use a shunting yard again...
//  - but handle parens recursively.
export function parse(tokens: Token[], index = 0, symbols?: SymbolLookup,
                      charEncoder?: CharEncoder): [Expr|undefined, number] {
  const ops: [string, OperatorMeta][] = [];
  const exprs: Expr[] = [];

  function popOp() {
    const [op, [,, arity]] = ops.pop()!;
//console.log('pop', op, arity);
    const args = exprs.splice(exprs.length - arity, arity);
    if (args.length !== arity) Tokens.fail(`shunting parse failed? ${Tokens.nameOf(tokens[i])}`, tokens[i]);
    exprs.push(fixSize({op, args}));
  }

  let val = true;
  let i = index;
  for (; i < tokens.length; i++) {
    const front = tokens[i];
// console.log('exprs:',exprs,'ops:',ops,'tok:',front);
    if (val) {
      // looking for a value: literal, balanced parens, or prefix op.
      if (front.token === 'cs' || front.token === 'op') {
        const str = collapseSigns(front.str, true);
        if (!str) continue; // a run of signs that cancels itself out
        const mapped = NAME_MAP.get(str);
        const prefix = PREFIXOPS.get(mapped ?? str);
        if (prefix) {
          ops.push([str, prefix]);
        } else if (front.token === 'cs') {
          const op = front.str;
          if (!FUNCTIONS.has(op)) {
            Tokens.fail(`No such function: ${Tokens.nameOf(front)}`, front);
          }
          const next = tokens[i + 1];
          if (next?.token !== 'lp') {
            Tokens.fail(`Bad funcall: ${Tokens.nameOf(next ?? front)}`, next ?? front);
          }
          const close = Tokens.findBalanced(tokens, i + 1);
          if (close < 0) {
            Tokens.fail(`Never closed: ${Tokens.nameOf(next)}`, next);
          }
          const args: Expr[] = [];
          // `.sizeof` names a definition rather than using its value, so its
          // argument must survive as a symbol instead of being inlined here.
          const argSymbols = op === '.sizeof' ? undefined : symbols;
          for (const arg of Tokens.parseArgList(tokens, i + 2, close)) {
            args.push(parseOnly(arg, 0, argSymbols, charEncoder));
          }
          i = close;
          exprs.push(fixSize({op, args}));
          val = false;
        } else if (Tokens.eq(front, Tokens.STAR)) {
          exprs.push({op: 'sym', sym: '*'});
          val = false;
        } else {
          Tokens.fail(`Unknown prefix operator: ${Tokens.nameOf(front)}`, front);
        }
      } else if (front.token === 'lp') {
        // find balanced parens
        const close = Tokens.findBalanced(tokens, i);
        if (close < 0) {
          Tokens.fail(`No close paren: ${Tokens.nameOf(front)}`, front);
        } // return [undefined, -1];
        const e = parseOnly(tokens.slice(i + 1, close), 0, symbols, charEncoder);
        exprs.push(e);
        i = close;
        val = false;
      } else if (front.token === 'ident') {
        // add symbol
        // use scope information to determine size
        const expr = symbols?.get(front.str)?.expr;
        if (expr) {
          exprs.push(expr);
        } else {
          // Nothing to inline, but the address size may still be known. Carry
          // it on the reference so `+`/`-` and the operand sizing can see it.
          const ref: Expr = {op: 'sym', sym: front.str};
          if (symbols?.zeropage?.(front.str)) ref.meta = {zeropage: true};
          exprs.push(ref);
        }
        // This is the only place that sees EVERY symbol, so we can use this
        // callback in the LSP to make sure we see every reference.
        symbols?.ref?.(front.str, front.source);
        val = false;
      } else if (front.token === 'num') {
        // add number
        const num = front.num;
        exprs.push({op: 'num', num, meta: size(num, front)});
        val = false;
      } else if (front.token === 'str') {
        const s = front.str;
        // A single-quoted literal is a character literal, which is treated like a
        // number in ca65.
        const chars = front.char ? Array.from(s) : undefined;
        if (chars) {
          if (chars.length !== 1) {
            Tokens.fail(`Character literal must be one character: '${s}'`, front);
          }
          const num = charEncoder?.(chars[0]) ?? chars[0].codePointAt(0)!;
          exprs.push({op: 'num', num, meta: size(num, front)});
        } else {
          exprs.push({op: 'str', str: s, meta: {size: s.length}});
        }
        val = false;
      } else {
        // bad token??
        Tokens.fail(`Bad expression token: ${Tokens.nameOf(front)}`, front);
        // return [undefined, -1];
      }
    } else {
      // looking for an infix operator or EOL.
      if (Tokens.eq(front, Tokens.COMMA) /* || Tokens.eq(front, Tokens.RP) */) {
        // TODO - is rparen okay? usually should have extracted the balanced
        // paren out first?
        break;
      }
      if (front.token === 'cs' || front.token === 'op') {
        const str = collapseSigns(front.str, false);
        const mapped = NAME_MAP.get(str);
        const op = BINOPS.get(mapped ?? str);
        if (!op) break; // we're at the end...?  or if no op.
        // see if anything to the left is faster.
        while (ops.length) {
          const top = ops[ops.length - 1];
          const cmp = compareOp(top[1], op);
          if (cmp < 0) break;
          if (cmp === 0) {
            Tokens.fail(
                `Mixing ${top[0]} and ${front.str} needs explicit parens.`, front);
          }
          popOp();
        }
        ops.push([str, op]);
        val = true;
      } else {
        //throw new Error(`Garbage after expression: ${Tokens.nameAt(front)}`);
//console.log('bad value', i, front);
        break;
      }
    }
  }
//console.log('exprs:',exprs,'ops:',ops);
  // Now pop all the ops
  while (ops.length) popOp();
//console.log('post-pop:', exprs);
  if (!tokens[index]) throw new Error(`No token at ${index}:\n${tokens.map(t => '  ' + Tokens.nameAt(t) + '\n')}`);
  if (exprs.length !== 1) Tokens.fail(`expression parse failed: nonunique result ${Tokens.nameOf(tokens[index])}`, tokens[index]);
  if (!exprs[0].source && tokens[index].source)
    exprs[0].source = tokens[index].source;
  return [exprs[0], i];
}


const SIGN_RUN = /^([-+])\1+$/;

/**
 * We allow an asm6 style +++ free-standing to be a label, but for a long
 * run of a +++ b, we can collapse that into a single a + b here to simplify
 * handling these cases. For instance a -- b turns into a - (-b) which is a + b
 */
function collapseSigns(str: string, unary: boolean): string {
  // Fast path, skip the regex if we don't have a string of +++ or ---
  if (str.length < 2) return str;
  const c = str.charCodeAt(0);
  if (c !== 0x2d /* - */ && c !== 0x2b /* + */) return str;
  if (!SIGN_RUN.test(str)) return str;
  const negations = str[0] === '-' ? (unary ? str.length : str.length - 1) : 0;
  if (negations % 2) return '-';
  return unary ? '' : '+';
}

/** ca65 evaluates expressions as signed 32-bit integers, so we do too. */
function i32(x: number): number {
  return x | 0;
}

/** Wrap the shift so that counts outside 0..31 produce 0. */
function shift(f: (x: number, n: number) => number): (x: number, n: number) => number {
  return (x, n) => (n >>> 0) >= 32 ? 0 : f(x, n);
}

function num(num: number|undefined): Expr|undefined {
  if (num == null) return undefined;
  return {op: 'num', num, meta: size(num)};
}

function unary(expr: Expr, f: (x: number) => number): Expr {
  // require absolute
  const arg = expr.args![0];
  if (!isAbs(arg)) return expr;
  const num = i32(f(i32(arg.num!)));
  return {op: 'num', num, meta: size(num)};
}

function binary(expr: Expr, f: (x: number, y: number) => number): Expr {
  // require both to be absolute
  const [a, b] = expr.args!;
  if (!isAbs(a) || !isAbs(b)) return expr;
  const num = i32(f(i32(a.num!), i32(b.num!)));
  return {op: 'num', num, meta: size(num)};
}

/** `.max`/`.min`: works on absolute numbers only. */
function varArg(expr: Expr, f: (...nums: number[]) => number): Expr {
  const args = expr.args!;
  if (!args.length || !args.every(isAbs)) return expr;
  const num = i32(f(...args.map(a => i32(a.num!))));
  return {op: 'num', num, meta: size(num)};
}

function func(expr: Expr, f: (x: Expr, y: Expr) => number): Expr {
  const [a, b] = expr.args!;
  const num = f(a, b);
  return {op: 'num', num, meta: size(num)};
}

function plus(expr: Expr): Expr {
  // allow some relative, but only if adding a non-address?
  const [a, b] = expr.args!;
  if (a.op !== 'num' || b.op !== 'num') return expr;
  const out: Expr = {op: 'num', num: a.num! + b.num!};
  if (a.meta || b.meta) {
    if (a.meta?.rel && b.meta?.rel) return expr; // basically nonsense
    if (a.meta?.rel) {
      out.meta = a.meta;
    } else if (b.meta?.rel) {
      out.meta = b.meta;
    }
  }
  if (!out.meta?.rel && out.meta?.size == null) {
    (out.meta || (out.meta = {})).size = foldedSize(out.num!, a, b);
  }
  return carryZeropage(out, '+', [a, b]);
}

function minus(expr: Expr): Expr {
  // allow rel - rel for delta
  const [a, b] = expr.args!;
  if (a.op !== 'num' || b.op !== 'num') return expr;
  const out: Expr = {op: 'num', num: a.num! - b.num!};
  // Preserve branch flag from the parent expression (set by assembler for branches)
  const isBranch = expr.meta?.branch;
  if (b.meta?.rel) {
    if (a.meta?.rel && a.meta.chunk === b.meta.chunk) {
      // Same-chunk relative subtraction - preserve branch flag if set
      out.meta = {size: size(out.num!).size};
      if (isBranch) out.meta.branch = true;
      return out;
    }
    return expr;
  }
  if (a.meta?.rel) out.meta = a.meta;
  if (!out.meta?.rel && out.meta?.size == null) {
    (out.meta || (out.meta = {})).size = foldedSize(out.num!, a, b);
  }
  // Preserve branch flag even for non-relative subtractions
  if (isBranch && out.op === 'num') {
    (out.meta || (out.meta = {})).branch = true;
  }
  return carryZeropage(out, '-', [a, b]);
}

function foldedSize(num: number, ...args: Expr[]): number {
  return Math.max(size(num).size!,
                  ...args.map(a => Number(a.meta?.size) || 0));
}

/** For +/- ops, we want things like ZP + 1 to also land in ZP */
function carryZeropage(out: Expr, op: string, args: Expr[]): Expr {
  if (out.meta?.zeropage || !isZeropage(op, args)) return out;
  // Copy rather than mutate since `out.meta` may still be an operand's `meta`.
  return {...out, meta: {...out.meta, zeropage: true}};
}

function isAbs(expr: Expr): boolean {
  return expr.op === 'num' && !expr.meta?.rel;
}




// Returns >0 if top is faster, <0 if top is slower, and 0 if can't mix
function compareOp(top: OperatorMeta, next: OperatorMeta): number {
  if (top[0] > next[0]) return 1;
  if (top[0] < next[0]) return -1;
  if (top[1] !== next[1]) return 0;
  return top[1];
}


// precedence, associativity, arity
type OperatorMeta = readonly [number, number, number];
const BINARY = 2;
const UNARY = 1;

// Precedence follows ca65's table in section 5.5 of its manual.
// The numbers here are opposite of what ca65 uses, but that is fine as long
// as they are the same relative to each other.
const LEFT = 1;
const RIGHT = -1;
export const BINOPS = new Map<string, OperatorMeta>([
  // Scoping operator
  // ['::', [8, LEFT, BINARY]],
  // Memory hints
  //[':', [6, 0]],
  // Multiplicative and bitwise operators
  ['*', [6, LEFT, BINARY]],
  ['/', [6, LEFT, BINARY]],
  ['.mod', [6, LEFT, BINARY]],
  ['&', [6, LEFT, BINARY]],
  ['^', [6, LEFT, BINARY]],
  ['<<', [6, LEFT, BINARY]],
  ['>>', [6, LEFT, BINARY]],
  // Arithmetic operators
  ['+', [5, LEFT, BINARY]],
  ['-', [5, LEFT, BINARY]],
  ['|', [5, LEFT, BINARY]],
  // Comparison operators
  ['<', [4, LEFT, BINARY]],
  ['<=', [4, LEFT, BINARY]],
  ['>', [4, LEFT, BINARY]],
  ['>=', [4, LEFT, BINARY]],
  ['=', [4, LEFT, BINARY]],
  ['<>', [4, LEFT, BINARY]],
  // Boolean and/xor have more precedence than boolean or
  ['&&', [3, LEFT, BINARY]],
  ['.xor', [3, LEFT, BINARY]],
  ['||', [2, LEFT, BINARY]],
  // Comma
  //[',', [1, 1]],
]);

const PREFIXOPS = new Map<string, OperatorMeta>([
  // ['::', [7, RIGHT, UNARY]], // global scope
  ['+', [7, RIGHT, UNARY]],
  ['-', [7, RIGHT, UNARY]],
  ['~', [7, RIGHT, UNARY]],
  ['<', [7, RIGHT, UNARY]],
  ['>', [7, RIGHT, UNARY]],
  ['^', [7, RIGHT, UNARY]],
  // Boolean not has less precedence than everything else, so `!a && b` is `!(a && b)`.
  ['!', [1, RIGHT, UNARY]],
  // The following operations force the value to use a certain addresing mode
  // ['z:', [2, RIGHT, UNARY]], // direct/zeropage
  // ['a:', [2, RIGHT, UNARY]], // absolute
  // ['f:', [2, RIGHT, UNARY]], // far
]);

// TODO - skip1 and skip2 macros
// .macro skip1
//   .byte $2c
// .endmacro
// .macro skip2
//   .byte $4c
//   .assert .byteat(* + 2) < $20 .or \
//           .byteat(* + 2) >= $60 .or \
//           .byteat(* + 1) & $07 .in [2,3,4]
// .endmacro
// NOTE: dangerous reads are 2002, 2004, 2007 (plus mirrors), 4015
// Then the assembler needs to understand the flow of these two ops...
// or just disassemble it on the fly?
const FUNCTIONS = new Set<string>([
  '.byteat',
  '.wordat',
  '.match', '.xmatch',
  '.max', '.min',
  '.sizeof',
  '.hiword', '.loword',
  '.strlen', '.strat',
  '.addrsize',
]);

const NAME_MAP = new Map<string, string>([
  ['.bitand', '&'],
  ['.bitxor', '^'],
  ['.bitor', '|'],
  ['.shl', '<<'],
  ['.shr', '>>'],
  ['.and', '&&'],
  ['.or', '||'],
  ['.bitnot', '~'],
  ['.lobyte', '<'],
  ['.hibyte', '>'],
  ['.bankbyte', '^'], // ??? how to implement on number?
  ['.not', '!'],
]);

const SIZE_TRANSFORMS = new Map<string, (...args: number[]) => number>([
  // unary: bank byte; binary: bitxor
  ['^', (...args) => args.length === 1 ? 1 : Math.max(...args)],
  ['<', () => 1], // unary (lobyte) and binary (cmp) both single-byte
  ['>', () => 1], // unary (hibyte) and binary (cmp) both single-byte
  ['!', () => 1], // not always 0 or 1
  ['<=', () => 1], // cmp
  ['>=', () => 1], // cmp
  ['<>', () => 1], // cmp
  ['=', () => 1], // cmp
  // bitwise and logical operator return max
  ['&', Math.max],
  ['&&', Math.max],
  ['|', Math.max],
  ['||', Math.max],
  ['.xor', Math.max],
  ['.max', Math.max],
  ['.min', Math.max], // could use min, but may not be safe w/ negatives
  ['.hiword', () => 2],
  ['.loword', () => 2],
]);
  
function fixSize(expr: Expr): Expr {
  const xform = SIZE_TRANSFORMS.get(expr.op);
  // perf: only use the spread operator when handling an unknown num of args
  const args = expr.args!;
  const size = !xform ? undefined :
      args.length === 1 ? xform(Number(args[0].meta?.size)) :
      args.length === 2 ? xform(Number(args[0].meta?.size),
                                Number(args[1].meta?.size)) :
      xform(...args.map(e => Number(e.meta?.size)));
  if (size) (expr.meta || (expr.meta = {})).size = size;
  if ((expr.op === '+' || expr.op === '-') && isZeropage(expr.op, expr.args!)) {
    (expr.meta || (expr.meta = {})).zeropage = true;
  }
  return expr;
}

function isAddress(expr: Expr): boolean {
  switch (expr.op) {
    case 'sym': case 'im': return true;
    case 'num':
      return Boolean(expr.meta?.rel || expr.meta?.zeropage ||
                     expr.meta?.chunk != null);
    case '+': case '-': return (expr.args ?? []).some(isAddress);
    default: return false;
  }
}

function isZeropage(op: string, args: Expr[]): boolean {
  // Unary `-` negates, which no longer names an address; unary `+` is identity.
  if (args.length === 1) return op === '+' && Boolean(args[0].meta?.zeropage);
  if (op === '-' && isAddress(args[1])) return false;
  const addrs = args.filter(isAddress);
  return addrs.length === 1 && Boolean(addrs[0].meta?.zeropage);
}

export function size(num: number, token?: Token): Meta {
  if (num < 256 && token && token.token === 'num' && token.width != null) {
    return {size: token.width};
  }
  return {size: 0 <= num && num < 256 ? 1 : 2};
}

/**
 * Whether `num` can be written into `size` bytes. Both the assembler and the
 * linker ask this, so the rule lives here rather than in either one.
 *
 * A value counts as fitting if it is in range read either as unsigned or as
 * signed, so a byte takes -128 through 255.
 * This is a change from ca65 which rejects any negative value from -1 to -128
 * as out of range since it considers them 32 bit numbers.
 */
export function fits(num: number, size: number, isBranch = false): boolean {
  const bits = size << 3;
  // NOTE: 2**bits rather than 1<<bits, since a 4-byte value shifts by 32,
  // which wraps around to 1 and rejects everything.
  const min = -(2 ** (bits - 1));
  const max = (isBranch ? 2 ** (bits - 1) : 2 ** bits) - 1;
  return num >= min && num <= max;
}

/**
 * The message for a value `fits` rejected. `at` is the address it was being
 * written to, which the linker knows and the assembler doesn't.
 */
export function rangeErrorMessage(num: number, size: number,
                                  isBranch = false, at = ''): string {
  const bits = size << 3;
  if (isBranch) {
    return `Branch out of range: offset ${num}${at} (valid range: ${
        -(2 ** (bits - 1))} to ${2 ** (bits - 1) - 1})`;
  }
  const name = ['byte', 'word', 'farword', 'dword'][size - 1] ?? `${size} bytes`;
  return `Not a ${name}: ${num < 0 ? num : `$${num.toString(16)}`}${at}`;
}
