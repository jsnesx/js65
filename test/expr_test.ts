
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {Expr} from '../src/expr.ts';
import * as Exprs from '../src/expr.ts';
import {Token} from '../src/token.ts';
import * as Tokens from '../src/token.ts';
import * as util from '../src/util.ts';

const [_a] = [util];

const {COMMA, LP, RP} = Tokens;
const [_b] = [tstr, tcs, tid, num, op, sym, COMMA, LP, RP];
function tid(str: string): Token { return {token: 'ident', str}; }
function tnum(num: number): Token { return {token: 'num', num}; }
function tstr(str: string): Token { return {token: 'str', str}; }
function tcs(str: string): Token { return {token: 'cs', str}; }
function top(str: string): Token { return {token: 'op', str}; }

function num(num: number) {
  return {op: 'num', num, meta: {size: 1 + +(num > 255)}};
}
function str(s: string) {
  return {op: 'str', str: s, meta: {size: s.length}};
}
function op(op: string, ...args: Expr[]) { return {op, args}; }
function op1(op: string, ...args: Expr[]) {
  return {op, args, meta: {size: 1}};
}
function sym(sym: string) { return {op: 'sym', sym}; }
function off(num: number, chunk: number) {
  return {op: 'num', num, meta: {rel: true,  chunk}};
}

describe('Expr', function() {

  describe('Exprs.parse', function() {
    it('should indicate where parsing left off', function() {
      const [expr, next] = Exprs.parse([tnum(5), tnum(6), tnum(7)], 1);
      expect(next).toBe(2);
      expect(expr).toEqual(num(6));
    });

    it('should parse binary ops', function() {
      const [expr, next] = Exprs.parse([tnum(5), top('+'), tnum(6), tnum(7)], 0);
      expect(next).toBe(3);
      expect(expr).toEqual(op('+', num(5), num(6)));
    });

    it('should parse parenthesized exprs', function() {
      const [expr, next] =
          Exprs.parse([LP, tnum(5), top('+'), tnum(6), RP, tnum(7)], 0);
      expect(next).toBe(5);
      expect(expr).toEqual(op('+', num(5), num(6)));
    });

    it('should parse * as a value', function() {
      const [expr, next] = Exprs.parse([top('*'), top('+'), tnum(1), tnum(2)]);
      expect(next).toBe(3);
      expect(expr).toEqual(op('+', sym('*'), num(1)));
    });

    it('should parse << as higher precedence than +', function() {
      const [expr, next] =
          Exprs.parse([tnum(1), top('+'), tnum(2), top('<<'), tnum(3)], 0);
      expect(next).toBe(5);
      expect(expr).toEqual(op('+', num(1), op('<<', num(2), num(3))));
    });

    it('should parse + as lower precedence than <<', function() {
      const [expr, next] =
          Exprs.parse([tnum(1), top('<<'), tnum(2), top('+'), tnum(3)], 0);
      expect(next).toBe(5);
      expect(expr).toEqual(op('+', op('<<', num(1), num(2)), num(3)));
    });

    it('should parse parentheses with highest precedence', function() {
      const [expr, next] =
          Exprs.parse([tnum(1), top('<<'), LP, tnum(2), top('+'), tnum(3), RP]);
      expect(next).toBe(7);
      expect(expr).toEqual(op('<<', num(1), op('+', num(2), num(3))));
    });
  });

  describe('Exprs.parseOnly', function() {
    it('should throw if garbage at end', function() {
      expect(() => Exprs.parseOnly([tnum(1), tnum(2)], 0))
          .toThrow(/garbage after expression/i);
    });

    it('should return the expression', function() {
      expect(Exprs.parseOnly([tnum(1)])).toEqual(num(1));
    });

    it('should parse prefix operators', function() {
      const expr = Exprs.parseOnly([top('+'), top('~'), top('^'), tnum(1)]);
      expect(expr).toEqual(op('+', op('~', op1('^', num(1)))));
    });

    it('should parse comparison operators', function() {
      const expr = Exprs.parseOnly([top('*'), top('='), tnum(0x1234)]);
      expect(expr).toEqual(op1('=', sym('*'), num(0x1234)));
    });

    it('should parse prefix functions', function() {
      const expr = Exprs.parseOnly([tcs('.max'), LP, tnum(4), COMMA, tnum(6),
                                   COMMA, tnum(8), RP, top('+'), tnum(3)]);
      expect(expr).toEqual(op('+', op1('.max', num(4), num(6), num(8)), num(3)));
    });

    it('should parse quoted strings', function() {
      const expr = Exprs.parseOnly([tstr("string_test")]);
      expect(expr).toEqual(str("string_test"));
    });
  });

  describe('Exprs.evaluate', function() {
    it('should preserve numbers', function() {
      expect(Exprs.evaluate(num(5))).toEqual(num(5));
    });

    it('should preserve offsets', function() {
      expect(Exprs.evaluate(off(5, 0))).toEqual(off(5, 0));
    });

    it('should preserve symbols', function() {
      expect(Exprs.evaluate(sym('foo'))).toEqual(sym('foo'));
    });

    it('should preserve expressions on symbols', function() {
      const expr = op('+', sym('foo'), num(1));
      expect(Exprs.evaluate(expr)).toBe(expr);
    });

    it('should return perform simple arithmetic', function() {
      expect(Exprs.evaluate(op('+', num(5), num(14)))).toEqual(num(19));
    });

    it('should perform binary bitwise operations', function() {
      expect(Exprs.evaluate(op('|', num(0x416), num(0x241)))).toEqual(num(0x657));
    });

    it('should perform unary bitwise operations', function() {
      expect(Exprs.evaluate(op('<', num(0x416)))).toEqual(num(0x16));
    });

    it('should perform logical operations', function() {
      expect(Exprs.evaluate(op('<', num(4), num(2)))).toEqual(num(0));
      expect(Exprs.evaluate(op('<', num(2), num(4)))).toEqual(num(1));
    });

    it('should add pure numbers to offsets', function() {
      expect(Exprs.evaluate(op('+', off(5, 0), num(1)))).toEqual(off(6, 0));
    });

    it('should evaluate a bank byte', function() {
      const arg = {op: 'num', num: 1, meta: {bank: 2}};
      expect(Exprs.evaluate(op('^', arg))).toEqual(num(2));
    });
  });

  // describe('Exprs.resolve', function() {
  //   const resolver = {
  //     chunkData(chunk: number) {
  //       switch (chunk) {
  //         case 1: return {bank: 7, zp: true};
  //         case 2: return {org: 0x9000};
  //         case 3: return {};
  //       }
  //       throw new Error(`unexpected: ${chunk}`);
  //     },
  //     resolve(name: string): Expr {
  //       switch (name) {
  //         case '*': return off(0x14, 3);   // reloc
  //         case 'foo': return off(0x23, 2); // org: $9000
  //         case 'bar': return off(0x37, 1); // reloc but zp
  //         case 'baz': return {op: 'sym', num: 6};
  //         case 'qux': return num(5);
  //       }
  //       throw new Error(`unexpected: ${name}`);
  //     },
  //   };

  //   it('should resolve a simple numerically assigned symbol', function() {
  //     expect(Exprs.resolve(sym('qux'), resolver)).toEqual(num(5));
  //   });

  //   it('should not resolve a global symbol table entry', function() {
  //     expect(Exprs.resolve(sym('baz'), resolver)).toEqual({op: 'sym', num: 6});
  //   });

  //   it('should evaluate upstream operators', function() {
  //     expect(Exprs.resolve(op('+', num(1), sym('qux')), resolver))
  //         .toEqual(num(6));
  //   });

  //   it('should inline relocatable offsets', function() {
  //     expect(Exprs.resolve(sym('*'), resolver)).toEqual(off(0x14, 3));
  //   });

  //   it('should substitute fixed offsets with numbers', function() {
  //     expect(Exprs.resolve(sym('foo'), resolver)).toEqual(num(0x9023));
  //   });

  //   it('should annotate zp offsets', function() {
  //     expect(Exprs.resolve(sym('bar'), resolver))
  //        .toEqual({op: 'num', num: 0x37, meta: {chunk: 1, size: 1}});
  //   });
  // });
});
