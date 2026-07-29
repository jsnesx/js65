
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {type Expr} from '../src/expr.ts';
import * as Exprs from '../src/expr.ts';
import {compile, type AssemblyInput} from '../src/libassembler.ts';
import {type Token} from '../src/token.ts';
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
  
    it('should evaluate match', function() {
      // Str type matches
      let expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.match'), LP, tstr("str1"), COMMA, tstr("str2"), RP
      ]));
      expect(expr).toEqual(num(1));
      // Num type matches
      expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.match'), LP, tnum(1), COMMA, tnum(2), RP
      ]));
      expect(expr).toEqual(num(1));
      // Type doesn't match
      expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.match'), LP, tnum(1), COMMA, tstr("test"), RP
      ]));
      expect(expr).toEqual(num(0));
    });
  
    it('should evaluate xmatch', function() {
      // Str contents match
      let expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.xmatch'), LP, tstr("str1"), COMMA, tstr("str1"), RP
      ]));
      expect(expr).toEqual(num(1));
      // Num contents match
      expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.xmatch'), LP, tnum(1), COMMA, tnum(1), RP
      ]));
      expect(expr).toEqual(num(1));
      // str contents doesn't match
      expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.xmatch'), LP, tstr("test1"), COMMA, tstr("test2"), RP
      ]));
      expect(expr).toEqual(num(0));
      // Num contents doesn't match
      expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.xmatch'), LP, tnum(1), COMMA, tnum(2), RP
      ]));
      expect(expr).toEqual(num(0));
      // Different types doesn't match
      expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.xmatch'), LP, tnum(1), COMMA, tstr("1"), RP
      ]));
      expect(expr).toEqual(num(0));
    });

    it('should evaluate .loword', function() {
      const expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.loword'), LP, tnum(0x12345678), RP
      ]));
      expect(expr).toEqual({op: 'num', num: 0x5678, meta: {size: 2}});
    });

    it('should evaluate .hiword', function() {
      const expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.hiword'), LP, tnum(0x12345678), RP
      ]));
      expect(expr).toEqual({op: 'num', num: 0x1234, meta: {size: 2}});
    });

    it('should evaluate .strlen', function() {
      const expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.strlen'), LP, tstr('hello'), RP
      ]));
      expect(expr).toEqual(num(5));
    });

    it('should evaluate .strat', function() {
      const expr = Exprs.evaluate(Exprs.parseOnly([
        tcs('.strat'), LP, tstr('hello'), COMMA, tnum(1), RP
      ]));
      expect(expr).toEqual(num('e'.codePointAt(0)!));
    });

    it('should reject .strlen on a non-string argument', function() {
      expect(() => Exprs.evaluate(Exprs.parseOnly([
        tcs('.strlen'), LP, tnum(1), RP
      ]))).toThrow(/requires a string literal/);
    });

    it('should throw on an out-of-range .strat index', function() {
      expect(() => Exprs.evaluate(Exprs.parseOnly([
        tcs('.strat'), LP, tstr('hi'), COMMA, tnum(5), RP
      ]))).toThrow(/index out of range/);
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

  // Test cases and output for each test case came from running each in ca65
  describe('ca65 operator compatibility', function() {

    async function assemble(body: string): Promise<number[]> {
      const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
${body}`;
      const result =
          await compile([{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
      if (!result.success) {
        throw new Error(result.messages.filter(m => m.level === 'error')
            .map(m => m.message).join('; '));
      }
      return Array.from(result.outputs[0].data);
    }

    // Really should add the .dword soon, but till then, we can check the 4 bytes of the
    // output by splitting it into a loword and hiword.
    async function value(expr: string): Promise<number> {
      const [lo, hi, hi2, hi3] =
          await assemble(`.word ((${expr}) & $ffff)\n.word (.hiword(${expr}))\n`);
      return lo | hi << 8 | hi2 << 16 | hi3 << 24;
    }

    function check(cases: Array<[string, number]>) {
      for (const [expr, want] of cases) {
        it(`should evaluate \`${expr}\` to ${want}`, async function() {
          expect(await value(expr)).toBe(want);
        });
      }
    }

    describe('precedence', function() {
      // ca65 gives boolean not the loosest precedence of all its operators.
      check([
        ['!1 && 1', 0],
        ['!0 && 0', 1],
        ['!1 || 0', 0],
        ['!0 || 0', 1],
        ['!1 .xor 1', 1],
        ['!1 = 0', 1],
        ['!0 = 0', 0],
        ['!(1 = 1)', 0],
        // boolean or is looser than boolean and/xor
        ['1 && 0 || 1', 1],
        ['0 || 1 && 1', 1],
        ['1 && 0 .xor 1', 1],
        ['0 || 1 .xor 1', 0],
        // unary operators are the highest priority
        ['-1 + 2', 1],
        ['<$1234 + 1', 0x35],
        ['2 * -3', -6],
      ]);
    });

    describe('associativity', function() {
      // Operators sharing a precedence level evaluate left to right.
      check([
        ['1 << 2 << 3', 32],
        ['1 - 2 - 3', -4],
        ['16 / 4 / 2', 2],
        ['1 = 1 = 1', 1],
        ['1 < 2 < 3', 1],
        ['1 .xor 0 .xor 1', 0],
        // ...including operators ca65 groups together but spells differently
        ['2 * 3 & 7', 6],
        ['1 << 2 * 3', 12],
        ['2 ^ 3 & 1', 1],
        ['1 + 2 | 4', 7],
        ['7 - 2 | 8', 13],
      ]);
    });

    describe('boolean operators', function() {
      // These always reduce to 0 or 1 rather than to one of their operands.
      check([
        ['2 && 3', 1],
        ['2 && 0', 0],
        ['2 || 0', 1],
        ['0 || 5', 1],
        ['0 .xor 5', 1],
        ['5 .xor 3', 0],
        ['2 .and 3', 1],
        ['2 .or 0', 1],
        ['!2', 0],
        ['.not 2', 0],
      ]);
    });

    describe('arithmetic', function() {
      check([
        // Division truncates toward zero and operates on signed 32-bit values.
        ['-7 / 2', -3],
        ['-3 / 2', -1],
        ['7 / -2', -3],
        ['$80000000 / 2', -0x40000000],
        ['-1 = $ffffffff', 1],
        // A shift count outside 0..31 clears the value.
        ['1 << 32', 0],
        ['1 << 64', 0],
        ['1 << -1', 0],
        ['$ffffffff >> 32', 0],
        // The bank byte of a plain number is bits 16-23.
        ['^$123456', 0x12],
        ['.bankbyte($123456)', 0x12],
      ]);

      it('should reject division by zero', async function() {
        await expect(value('1 / 0')).rejects.toThrow(/division by zero/i);
      });

      it('should reject modulo by zero', async function() {
        await expect(value('1 .mod 0')).rejects.toThrow(/modulo operation with zero/i);
      });
    });

    describe('functions', function() {
      check([
        ['.max(3, 7)', 7],
        ['.min(3, 7)', 3],
        ['.max(-3, 7)', 7],
        ['.min(-3, 7)', -3],
        ['.match(1, 2)', 1],
        ['.xmatch(1, 2)', 0],
        ['.xmatch(1, 1)', 1],
        ['.match("a", "b")', 1],
        ['.xmatch("a", "b")', 0],
        ['.match(abc, def)', 1],
        ['.xmatch(abc, def)', 0],
        ['.match(+, -)', 0],
        ['.const(5)', 1],
        ['.const(1+2)', 1],
        ['.const(*)', 0],
      ]);
    });

    describe('constant expressions in .if', function() {
      it('should apply the same precedence as the assembler', async function() {
        expect(await assemble(`
.if !0 && 0
.byte $11
.endif
.if !1 || 0
.byte $22
.endif
.if 1 && 0 || 1
.byte $33
.endif
.if 0 || 1 && 1
.byte $44
.endif
`)).toEqual([0x11, 0x33, 0x44]);
      });
    });
  });
});
