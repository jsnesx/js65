
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { z } from 'zod';
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
const MetaZ = z.object({
  /** Whether this is relative to the start of the chunk. */
  rel: z.boolean().optional(),
  /** Relative chunk the value is defined in. */
  chunk: z.number().optional(),
  /** Org value of chunk, if known. */
  org: z.number().optional(),
  /** Bank value of chunk, if known. */
  bank: z.number().optional(),
  /** Offset value of chunk, if known. */
  offset: z.number().optional(),
  /** Size hint for number. */
  size: z.number().optional(),
});

export type Meta = z.infer<typeof MetaZ>;

const BaseExpr = z.object({
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
  op: z.string(),
  /** only used when op === 'num' */
  num: z.number().optional(),
  /** only used when op === 'str' */
  str: z.string().optional(),
  meta: MetaZ.optional(),
  /** only used when op === 'sym' */
  sym: z.string().optional(),
  source: Tokens.SourceInfoZ.optional(),
});

// Work around for the recursive Expr type
export type Expr = z.infer<typeof BaseExpr> & {
  args?: Expr[];
};

export const ExprZ : z.ZodType<Expr> = BaseExpr.extend({
  args: z.lazy(() => ExprZ.array()).optional(),
});

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
    if (!e.args) return e;
    return {...e, args: e.args.map(c => t(c, e))};
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

export function evaluate(expr: Expr): Expr {
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
    case '.max': return sameChunk(expr, Math.max);
    case '.min': return sameChunk(expr, Math.min);
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
      case '^': return num(expr.args![0].meta?.bank) ?? expr;
      default: throw new Error(`Unknown unary operator: ${mapped}`);
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
    case '/': return binary(expr, (a, b) => Math.floor(a / b));
    case '.mod': return binary(expr, (a, b) => a % b);
    case '&': return binary(expr, (a, b) => a & b);
    case '|': return binary(expr, (a, b) => a | b);
    case '^': return binary(expr, (a, b) => a ^ b);
    case '<<': return binary(expr, (a, b) => a << b);
    case '>>': return binary(expr, (a, b) => a >>> b);
    case '<': return binary(expr, (a, b) => +(a < b));
    case '<=': return binary(expr, (a, b) => +(a <= b));
    case '>': return binary(expr, (a, b) => +(a > b));
    case '>=': return binary(expr, (a, b) => +(a >= b));
    case '=': return binary(expr, (a, b) => +(a == b));
    case '<>': return binary(expr, (a, b) => +(a != b));
    case '&&': return binary(expr, (a, b) => a && b);
    case '||': return binary(expr, (a, b) => a || b);
    case '.xor': return binary(expr, (a, b) => !a && b || !b && a || 0);
    default: throw new Error(`Unknown operator: ${mapped} Expr: ${JSON.stringify(expr)}`);
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
      default: throw new Error(`Unknown unary operator: ${expr.op}`);
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
    default: throw new Error(`Unknown operator: ${expr.op}`);
  }
}

export function identifier(expr: Expr): string {
  if (expr.op === 'sym' && expr.sym) return expr.sym;
  throw new Error(`Expected identifier but got op: ${expr.op}`);
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

/** Parse a single expression, must occupy the rest of the line. */
export function parseOnly(tokens: Token[], index = 0, symbols?: Map<string, Symbol>): Expr {
  const [expr, i] = parse(tokens, index, symbols);
  if (i < tokens.length) {
    parse(tokens, index, symbols);
    throw new Error(`Garbage after expression: ${Tokens.nameAt(tokens[i])}`);
  } else if (!expr) {
    throw new Error(`No expression?`);
  }
  return expr;
}

// Returns [undefined, -1] if a bad parse.
// Give up on normal parsing, just use a shunting yard again...
//  - but handle parens recursively.
export function parse(tokens: Token[], index = 0, symbols?: Map<string, Symbol>): [Expr|undefined, number] {
//console.log('PARSE: tokens=', tokens, 'index=', index);
//try { throw new Error(); } catch (e) { console.log(e.stack); }
  const ops: [string, OperatorMeta][] = [];
  const exprs: Expr[] = [];

  function popOp() {
    const [op, [,, arity]] = ops.pop()!;
//console.log('pop', op, arity);
    const args = exprs.splice(exprs.length - arity, arity);
    if (args.length !== arity) throw new Error(`shunting parse failed? ${Tokens.nameAt(tokens[i])}`);
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
        const mapped = NAME_MAP.get(front.str);
        const prefix = PREFIXOPS.get(mapped ?? front.str);
        if (prefix) {
          ops.push([front.str, prefix]);
        } else if (front.token === 'cs') {
          const op = front.str;
          if (!FUNCTIONS.has(op)) {
            throw new Error(`No such function: ${Tokens.nameAt(front)}`);
          }
          const next = tokens[i + 1];
          if (next?.token !== 'lp') {
            throw new Error(`Bad funcall: ${Tokens.nameAt(next ?? front)}`);
          }
          const close = Tokens.findBalanced(tokens, i + 1);
          if (close < 0) {
            throw new Error(`Never closed: ${Tokens.nameAt(next)}`);
          }
          const args: Expr[] = [];
          for (const arg of Tokens.parseArgList(tokens, i + 2, close)) {
            args.push(parseOnly(arg, 0, symbols));
          }
          i = close;
          exprs.push(fixSize({op, args}));
          val = false;
        } else if (Tokens.eq(front, Tokens.STAR)) {
          exprs.push({op: 'sym', sym: '*'});
          val = false;
        } else {
          throw new Error(`Unknown prefix operator: ${Tokens.nameAt(front)}`);
        }
      } else if (front.token === 'lp') {
        // find balanced parens
        const close = Tokens.findBalanced(tokens, i);
        if (close < 0) {
          throw new Error(`No close paren: ${Tokens.nameAt(front)}`);
        } // return [undefined, -1];
        const e = parseOnly(tokens.slice(i + 1, close), 0, symbols);
        exprs.push(e);
        i = close;
        val = false;
      } else if (front.token === 'ident') {
        // add symbol
        // use scope information to determine size
        const expr = symbols?.get(front.str)?.expr;
        exprs.push((expr) ? expr : {op: 'sym', sym: front.str});
        val = false;
      } else if (front.token === 'num') {
        // add number
        const num = front.num;
        exprs.push({op: 'num', num, meta: size(num, front)});
        val = false;
      } else if (front.token === 'str') { 
        // TODO: use the charmap to look up literal value
        const s = front.str
        exprs.push({op: 'str', str: s, meta: {size: s.length}});
        val = false;
      } else {
        // bad token??
        throw new Error(`Bad expression token: ${Tokens.nameAt(front)}`);
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
        const mapped = NAME_MAP.get(front.str);
        const op = BINOPS.get(mapped ?? front.str);
        if (!op) break; // we're at the end...?  or if no op.
        // see if anything to the left is faster.
        while (ops.length) {
          const top = ops[ops.length - 1];
          const cmp = compareOp(top[1], op);
          if (cmp < 0) break;
          if (cmp === 0) {
            throw new Error(
                `Mixing ${top[0]} and ${front.str} needs explicit parens.${
                  Tokens.at(front)}`);
          }
          popOp();
        }
        ops.push([front.str, op]);
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
  if (exprs.length !== 1) throw new Error(`expression parse failed: nonunique result ${Tokens.nameAt(tokens[index])}`);
  if (tokens[index].source) exprs[0].source = tokens[index].source;
  return [exprs[0], i];
}


// works on absolute numbers, or relative numbers if all in same chunk.
// may not mix relative + absolute.
function sameChunk(_expr: Expr, _f: (...nums: number[]) => number): Expr {
  throw new Error();
}

function num(num: number|undefined): Expr|undefined {
  if (num == null) return undefined;
  return {op: 'num', num, meta: size(num)};
}

function unary(expr: Expr, f: (x: number) => number): Expr {
  // require absolute
  const arg = expr.args![0];
  if (!isAbs(arg)) return expr;
  const num = f(arg.num!);
  return {op: 'num', num, meta: size(num)};
}

function binary(expr: Expr, f: (x: number, y: number) => number): Expr {
  // require both to be absolute
  const [a, b] = expr.args!;
  if (!isAbs(a) || !isAbs(b)) return expr;
  const num = f(a.num!, b.num!);
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
    (out.meta || (out.meta = {})).size = size(out.num!).size;
  }
  return out;
}

function minus(expr: Expr): Expr {
  // allow rel - rel for delta
  const [a, b] = expr.args!;
  if (a.op !== 'num' || b.op !== 'num') return expr;
  const out: Expr = {op: 'num', num: a.num! - b.num!};
  if (b.meta?.rel) {
    return a.meta?.rel && a.meta.chunk === b.meta.chunk ? out : expr;
  }
  if (a.meta?.rel) out.meta = a.meta;
  if (!out.meta?.rel && out.meta?.size == null) {
    (out.meta || (out.meta = {})).size = size(out.num!).size;
  }
  return out;
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
export const BINOPS = new Map<string, OperatorMeta>([
  // Scoping operator
  // ['::', [8, 1, BINARY]],
  // Memory hints
  //[':', [6, 0]],
  // Multiplicative operators: note that bitwise and arithmetic cannot associate
  ['*', [5, 4, BINARY]],
  ['/', [5, 4, BINARY]],
  ['.mod', [5, 3, BINARY]],
  ['&', [5, 2, BINARY]],
  ['^', [5, 1, BINARY]],
  ['<<', [5, 0, BINARY]],
  ['>>', [5, 0, BINARY]],
  // Arithmetic operators: note that bitwise and arithmetic cannot associate
  ['+', [4, 2, BINARY]],
  ['-', [4, 2, BINARY]],
  ['|', [4, 1, BINARY]],
  // Comparison operators
  ['<', [3, 0, BINARY]],
  ['<=', [3, 0, BINARY]],
  ['>', [3, 0, BINARY]],
  ['>=', [3, 0, BINARY]],
  ['=', [3, 0, BINARY]],
  ['<>', [3, 0, BINARY]],
  // Logical operators: different kinds cannot associate
  ['&&', [2, 3, BINARY]],
  ['.xor', [2, 2, BINARY]],
  ['||', [2, 1, BINARY]],
  // Comma
  //[',', [1, 1]],
]);

const PREFIXOPS = new Map<string, OperatorMeta>([
  // ['::', [9, -1, UNARY]], // global scope
  ['+', [9, -1, UNARY]],
  ['-', [9, -1, UNARY]],
  ['~', [9, -1, UNARY]],
  ['<', [9, -1, UNARY]],
  ['>', [9, -1, UNARY]],
  ['^', [9, -1, UNARY]],
  ['!', [2, -1, UNARY]],
  // The following operations force the value to use a certain addresing mode
  // ['z:', [2, -1, UNARY]], // direct/zeropage
  // ['a:', [2, -1, UNARY]], // absolute
  // ['f:', [2, -1, UNARY]], // far
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
]);
  
function fixSize(expr: Expr): Expr {
  const xform = SIZE_TRANSFORMS.get(expr.op);
  const size = xform?.(...expr.args!.map(e => Number(e.meta?.size)));
  if (size) (expr.meta || (expr.meta = {})).size = size;
  return expr;
}

export function size(num: number, token?: Token): Meta {
  if (num < 256 && token && token.token === 'num' && token.width != null) {
    return {size: token.width};
  }
  return {size: 0 <= num && num < 256 ? 1 : 2};
}

// function fail(msg: string): never {
//   throw new Error(msg);
// }
