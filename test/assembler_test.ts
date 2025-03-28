
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {Cpu} from '../src/cpu.ts';
import {Expr} from '../src/expr.ts';
import {Module} from '../src/module.ts';
import {Assembler} from '../src/assembler.ts';
import {Token} from '../src/token.ts';
import * as Tokens from '../src/token.ts';
import * as util from '../src/util.ts';

const [_a] = [util];

function ident(str: string): Token { return {token: 'ident', str}; }
function num(num: number): Token { return {token: 'num', num}; }
function str(str: string): Token { return {token: 'str', str}; }
function cs(str: string): Token { return {token: 'cs', str}; }
function op(str: string): Token { return {token: 'op', str}; }
const {COLON, COMMA, IMMEDIATE, LP, RP} = Tokens;
const ORG = cs('.org');
const RELOC = cs('.reloc');
const ASSERT = cs('.assert');
const SEGMENT = cs('.segment');

function off(num: number, chunk = 0): Expr {
  return {op: 'num', num, meta: {chunk, rel: true}};
}

const [_b] = [str, COMMA, LP, RP, ORG, RELOC, ASSERT, SEGMENT];

describe('Assembler', function() {

  describe('Simple instructions', function() {
    it('should handle `lda #$03`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lda'), IMMEDIATE, num(3)]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 3),
        }],
        symbols: [],
      });
    });

    it('should handle `sta $02`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('sta'), num(2)]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x85, 2),
        }],
        symbols: [],
      });
    });

    it('should handle `ldy $032f`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('ldy'), num(0x32f)]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xac, 0x2f, 3),
        }],
        symbols: [],
      });
    });

    it('should handle `rts`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('rts')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x60),
        }],
        symbols: [],
      });
    });

    it('should handle `lda ($24),y`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lda'), LP, num(0x24), RP, COMMA, ident('y')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xb1, 0x24),
        }],
        symbols: [],
      });
    });

    it('should handle `sta ($20,x)`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('sta'), LP, num(0x20), COMMA, ident('x'), RP]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x81, 0x20),
        }],
        symbols: [],
      });
    });

    it('should handle `lsr`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lsr')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x4a),
        }],
        symbols: [],
      });
    });

    it('should handle `lsr a`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lsr'), ident('A')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x4a),
        }],
        symbols: [],
      });
    });

    it('should handle `ora $480,x`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('ora'), num(0x480), COMMA, ident('x')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x1d, 0x80, 4),
        }],
        symbols: [],
      });
    });

    it('should handle `ora ($ff,x)`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('ora'), LP, num(0xff), COMMA, ident('x'), RP]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x01, 0xff),
        }],
        symbols: [],
      });
    });

    it('should handle `lda a:$80,x`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lda'), ident('a'), COLON, num(0x80), COMMA, ident('x')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xbd, 0x80, 0x00),
        }],
        symbols: [],
      });
    });

    it('should handle `lda z:a:$80,x`', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lda'), ident('z'), COLON, ident('a'), COLON, num(0x80), COMMA, ident('x')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xb5, 0x80),
        }],
        symbols: [],
      });
    });

    it('should error for improper address mode `lda z:$8000,y`', async function() {
      const a = new Assembler(Cpu.P02);
      try {
        await a.instruction([ident('lda'), ident('z'), COLON, num(0x8000), COMMA, ident('y')]);
      } catch (err) {
        expect(err.message).toEqual("Bad address mode zpy for lda");
      }
    });
  });

  describe('Symbols', function() {
    it('should fill in an immediately-available value', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', 0x23);
      await a.instruction([ident('lda'), IMMEDIATE, ident('val')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 0x23),
        }],
        symbols: [],
        segments: [],
      });
    });

    it('should substitute a immediately-available single-byte value with a zp instruction', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', 0x23);
      await a.instruction([ident('lda'), ident('val')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa5, 0x23),
        }],
        symbols: [],
        segments: [],
      });
    });

    it('should fill in an immediately-available multi-byte value', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', 0x2345);
      await a.instruction([ident('lda'), ident('val')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xad, 0x45, 0x23),
        }],
        symbols: [],
        segments: [],
      });
    });

    it('should fill in an immediately-available label', async function() {
      const a = new Assembler(Cpu.P02);
      a.org(0x9135);
      a.label('foo');
      await a.instruction([ident('ldx'), IMMEDIATE, op('<'), ident('foo')]);
      await a.instruction([ident('ldy'), IMMEDIATE, op('>'), ident('foo')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          name: 'foo',
          org: 0x9135,
          data: Uint8Array.of(0xa2, 0x35, 0xa0, 0x91),
        }],
        symbols: [],
        segments: [],
      });
    });

    it('should make a separate chunk for separate .org directives', async function() {
      const a = new Assembler(Cpu.P02);
      a.org(0x1234);
      await a.instruction([ident('rts')]);
      a.org(0x5678);
      await a.instruction([ident('ldy'), IMMEDIATE, num(0x12)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          org: 0x1234,
          data: Uint8Array.of(0x60),
        }, {
          overwrite: 'allow',
          segments: [],
          org: 0x5678,
          data: Uint8Array.of(0xa0, 0x12),
        }],
        symbols: [],
        segments: [],
      });
    });

    it('should merge chunks when .org is redundant with PC', async function() {
      const a = new Assembler(Cpu.P02);
      a.org(0x1234);
      await a.instruction([ident('rts')]);
      a.org(0x1235);
      await a.instruction([ident('ldy'), IMMEDIATE, num(0x12)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          org: 0x1234,
          data: Uint8Array.of(0x60, 0xa0, 0x12),
        }],
        symbols: [],
        segments: [],
      });
    });

    it('should substitute a forward referenced value', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lda'), IMMEDIATE, ident('val')]);
      a.assign('val', 0x23);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 0xff),
          subs: [{offset: 1, size: 1, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: {op: 'num', num: 0x23, meta: {size: 1}}}],
        segments: [],
      });
    });

    // While this would be nice to have CA65 simply emits a warning and uses ABS addressing instead
    // it('should substitute a forward referenced single-byte value with a zp instruction', async function() {
    //   const a = new Assembler(Cpu.P02);
    //   await a.instruction([ident('lda'), ident('val')]);
    //   a.assign('val', 0x23);
    //   expect(strip(a.module())).toEqual({
    //     chunks: [{
    //       overwrite: 'allow',
    //       segments: [],
    //       data: Uint8Array.of(0xa5, 0xff),
    //       subs: [{offset: 1, size: 1, expr: {op: 'sym', num: 0}}],
    //     }],
    //     symbols: [{expr: {op: 'num', num: 0x23, meta: {size: 1}}}],
    //     segments: [],
    //   });
    // });

    it('should substitute a forward referenced multi-byte value', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lda'), ident('val')]);
      a.assign('val', 0x2345);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xad, 0xff, 0xff),
          subs: [{offset: 1, size: 2, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: {op: 'num', num: 0x2345, meta: {size: 2}}}],
        segments: [],
      });
    });

    it('should substitute a forward referenced label', async function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.org'), num(0x8000)]);
      await a.instruction([ident('jsr'), ident('foo')]);
      expect(a.definedSymbol('foo')).toEqual(false);
      await a.instruction([ident('lda'), IMMEDIATE, num(0)]);
      a.label('foo');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          org: 0x8000,
          data: Uint8Array.of(0x20, 0xff, 0xff,
                              0xa9, 0x00),
          subs: [{offset: 1, size: 2, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: {op: 'num', num: 0x8005,
                          meta: {org: 0x8000, chunk: 0}}}],
        segments: [],
      });
    });

    it('should allow overwriting mutable symbols', async function() {
      const a = new Assembler(Cpu.P02);
      a.set('foo', 5);
      await a.instruction([ident('lda'), IMMEDIATE, ident('foo')]);
      a.set('foo', 6);
      await a.instruction([ident('lda'), IMMEDIATE, ident('foo')]);

      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 5, 0xa9, 6),
        }],
        symbols: [], segments: []});
    });

    it('should not allow redefining immutable symbols', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5);
      expect(() => a.assign('foo', 5))
          .toThrow(/Redefining symbol foo/);
      expect(() => a.label('foo')).toThrow(/Redefining symbol foo/);
    });

    it('should not allow redefining labels', function() {
      const a = new Assembler(Cpu.P02);
      a.label('foo');
      expect(() => a.assign('foo', 5))
          .toThrow(/Redefining symbol foo/);
      expect(() => a.label('foo')).toThrow(/Redefining symbol foo/);
    });

    it('should substitute a formula', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', {op: '+', args: [{op: 'num', num: 1},
                                       {op: 'sym', sym: 'x'}]});
      await a.instruction([ident('lda'), IMMEDIATE, ident('val')]);
      a.assign('x', 2);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 0xff),
          subs: [{offset: 1, size: 1,
                  expr: {op: '+', args: [{op: 'num', num: 1},
                                         {op: 'sym', num: 0}]}}],
        }],
        symbols: [{expr: {op: 'num', num: 2, meta: {size: 1}}}],
        segments: [],
      });
    });
  });

  describe('Cheap locals', function() {
    it('should handle backward refs', async function() {
      const a = new Assembler(Cpu.P02);
      a.label('@foo');
      await a.instruction([ident('ldx'), IMMEDIATE, op('<'), ident('@foo')]);
      await a.instruction([ident('ldy'), IMMEDIATE, op('>'), ident('@foo')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa2, 0xff, 0xa0, 0xff),
          subs: [{
            offset: 1, size: 1,
            expr: {op: '<', meta: {size: 1}, args: [off(0)]},
          }, {
            offset: 3, size: 1,
            expr: {op: '>', meta: {size: 1}, args: [off(0)]},
          }],
        }],
        symbols: [],
        segments: [],
      });
    });

    it('should handle forward refs', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('jsr'), ident('@foo')]);
      await a.instruction([ident('lda'), IMMEDIATE, num(0)]);
      a.label('@foo');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x20, 0xff, 0xff,
                              0xa9, 0x00),
          subs: [{offset: 1, size: 2, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: off(5)}],
        segments: [],
      });
    });

    it('should not allow using a cheap local name for non-labels', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.assign('@foo', 5))
          .toThrow(/Cheap locals may only be labels: @foo/);
    });

    it('should not allow reusing names in the same cheap scope', function() {
      const a = new Assembler(Cpu.P02);
      a.label('@foo');
      expect(() => a.label('@foo')).toThrow(/Redefining symbol @foo/);
    });

    it('should clear the scope on a non-cheap label', async function() {
      const a = new Assembler(Cpu.P02);
      a.label('@foo');
      await a.instruction([ident('jsr'), ident('@foo')]);
      a.label('bar');
      await a.instruction([ident('jsr'), ident('@foo')]);
      a.label('@foo');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x20, 0xff, 0xff,
                              0x20, 0xff, 0xff),
          subs: [
            {offset: 1, size: 2, expr: off(0)},
            {offset: 4, size: 2, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: off(6)}],
        segments: [],
      });
    });

    it('should not clear the scope on a symbol', function() {
      const a = new Assembler(Cpu.P02);
      a.label('@foo');
      a.assign('bar', 2);
      expect(() => a.label('@foo')).toThrow(/Redefining symbol @foo/);
    });

    it('should be an error if a cheap label is never defined', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('jsr'), ident('@foo')]);
      expect(() => a.label('bar'))
          .toThrow(/Cheap local label never defined: @foo/);
      expect(() => a.module())
          .toThrow(/Cheap local label never defined: @foo/);
    });
  });

  describe('Anonymous labels', function() {
    it('should work for forward references', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('bne'), op(':'), op('++')]);
      a.label(':');
      await a.instruction([ident('bcc'), ident(':+3')]);
      a.label(':'); // first target
      await a.instruction([ident('lsr')]);
      a.label(':');
      await a.instruction([ident('lsr')]);
      a.label(':'); // second target
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xd0, 0xff, 0x90, 0xff, 0x4a, 0x4a),
          subs: [{offset: 1, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 0}, off(2)]}},
                 {offset: 3, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 1}, off(4)]}}],
        }],
        symbols: [{expr: off(4)},
                  {expr: off(6)}],
        segments: []});
    });

    it('should work for backward references', async function() {
      const a = new Assembler(Cpu.P02);
      a.label(':'); // first target
      await a.instruction([ident('lsr')]);
      a.label(':');
      await a.instruction([ident('lsr')]);
      await a.instruction([ident('lsr')]);
      a.label(':'); // second target
      await a.instruction([ident('bne'), op(':'), op('---')]);
      a.label(':');
      await a.instruction([ident('bcc'), ident(':-2')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x4a, 0x4a, 0x4a, 0xd0, 0xfb, 0x90, 0xfc),
        }],
        symbols: [], segments: []});
    });

    it('should allow one label for both forward directions', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('bne'), op(':'), op('+')]);
      a.label(':');
      await a.instruction([ident('bcc'), ident(':-')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xd0, 0xff, 0x90, 0xfe),
          subs: [{offset: 1, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 0}, off(2)]}}],
        }],
        symbols: [{expr: off(2)}],
        segments: []});
    });

    it('should handle rts references', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('rts')]);
      await a.instruction([ident('bne'), ident(':<rts')]);
      await a.instruction([ident('bne'), ident(':rts')]);
      await a.instruction([ident('rts')]);
      await a.instruction([ident('bne'), ident(':>>rts')]);
      await a.instruction([ident('bne'), ident(':<<rts')]);
      await a.instruction([ident('bne'), ident(':>>rts')]);
      await a.instruction([ident('bne'), ident(':<<rts')]);
      await a.instruction([ident('rts')]);
      await a.instruction([ident('rts')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(
            0x60,
            0xd0, 0xfd,
            0xd0, 0xff,
            0x60,
            0xd0, 0xff,
            0xd0, 0xf6,
            0xd0, 0xff,
            0xd0, 0xf2,
            0x60,
            0x60),
          subs: [{offset: 4, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 0}, off(5)]}},
                 {offset: 7, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 1}, off(8)]}},
                 {offset: 11, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 1}, off(12)]}}],
        }],
        symbols: [{expr: off(5)},
                  {expr: off(15)}],
        segments: []});
    });
  });

  describe('Relative labels', function() {
    it('should work for forward references', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('bne'), op('++')]);
      a.label('+');
      await a.instruction([ident('bcc'), ident('+++')]);
      a.label('++');
      await a.instruction([ident('lsr')]);
      await a.instruction([ident('lsr')]);
      a.label('+++');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xd0, 0xff, 0x90, 0xff, 0x4a, 0x4a),
          subs: [{offset: 1, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 0}, off(2)]}},
                 {offset: 3, size: 1,
                  expr: {op: '-', args: [{op: 'sym', num: 1}, off(4)]}}],
        }],
        symbols: [{expr: off(4)},
                  {expr: off(6)}],
        segments: []});
    });

    it('should work for backward references', async function() {
      const a = new Assembler(Cpu.P02);
      a.label('--'); // first target
      await a.instruction([ident('lsr')]);
      await a.instruction([ident('lsr')]);
      await a.instruction([ident('lsr')]);
      a.label('-'); // second target
      await a.instruction([ident('bne'), op('--')]);
      await a.instruction([ident('bcc'), ident('-')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x4a, 0x4a, 0x4a, 0xd0, 0xfb, 0x90, 0xfc),
        }],
        symbols: [], segments: []});
    });
  });

  describe('.byte', function() {
    it('should support numbers', function() {
      const a = new Assembler(Cpu.P02);
      a.byte(1, 2, 3);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(1, 2, 3),
        }],
        symbols: [], segments: []});
    });
    it('should support larger numbers truncated', function() {
      const a = new Assembler(Cpu.P02);
      a.byte(0x102, 0x20304, 0x3040506);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(2, 4, 6),
        }],
        symbols: [], segments: []});
    });

    it('should support strings', function() {
      const a = new Assembler(Cpu.P02);
      a.byte('ab', 'cd');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x61, 0x62, 0x63, 0x64),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.byte'), num(1), op('+'), num(2)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(3),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with backward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('q', 5);
      a.directive([cs('.byte'), ident('q')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(5),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with forward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.byte'), ident('q'), op('+'), num(1)]);
      a.label('q');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff),
          subs: [{offset: 0, size: 1,
                  expr: {op: '+', args: [{op: 'sym', num: 0},
                                         {op: 'num', num: 1,
                                          meta: {size: 1}}]}}],
        }],
        symbols: [{expr: off(1)}],
        segments: []});
    });
  });

  describe('.res', function() {
    it('should reserve space', function() {
      const a = new Assembler(Cpu.P02);
      a.res(10, 3);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(3, 3, 3, 3, 3, 3, 3, 3, 3, 3),
        }],
        symbols: [], segments: []});
    });
  });

  describe('.word', function() {
    it('should support numbers', function() {
      const a = new Assembler(Cpu.P02);
      a.word(1, 2, 0x403);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(1, 0, 2, 0, 3, 4),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.word'), num(1), op('+'), num(2)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(3, 0),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with backward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('q', 0x305);
      a.directive([cs('.word'), ident('q')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(5, 3),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with forward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.word'), ident('q'), op('+'), num(1)]);
      a.label('q');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff, 0xff),
          subs: [{offset: 0, size: 2,
                  expr: {op: '+', args: [{op: 'sym', num: 0},
                                         {op: 'num', num: 1,
                                          meta: {size: 1}}]}}],
        }],
        symbols: [{expr: off(2)}],
        segments: []});
    });
  });

  describe('.segment', function() {
    it('should change the segment', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('01');
      a.byte(4);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['01'],
          data: Uint8Array.of(4),
        }], symbols: [], segments: []});
    });

    it('should allow multiple segments', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('01', '02');
      a.byte(4);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['01', '02'],
          data: Uint8Array.of(4),
        }], symbols: [], segments: []});
    });

    it('should configure the segment', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('size', 100)
      a.directive([cs('.segment'), str('03'),
                   COLON, ident('bank'), num(2), op('+'), num(1),
                   COLON, ident('size'), ident('size')]);
      expect(strip(a.module())).toEqual({
        chunks: [], symbols: [], segments: [{
          name: '03',
          bank: 3,
          size: 100,
          offset: 0,
        }]});
    });

    it('should merge multiple attr lists', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.segment'), str('02'), COLON, ident('bank'), num(2)]);
      a.directive([cs('.segment'), str('02'), COLON, ident('size'), num(200)]);
      expect(strip(a.module())).toEqual({
        chunks: [], symbols: [], segments: [{
          name: '02',
          bank: 2,
          size: 200,
          offset: 0,
        }]});
    });

    it('should track free regions', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('02');
      a.org(0x8000);
      a.free(0x200);
      a.org(0x9000);
      a.free(0x400);
      expect(strip(a.module())).toEqual({
        chunks: [], symbols: [], segments: [{
          name: '02',
          free: [[0x8000, 0x8200], [0x9000, 0x9400]],
        }]});
    });

    it('should allow setting a prefix', async function() {
      const a = new Assembler(Cpu.P02);
      a.segmentPrefix('cr:');
      a.directive([cs('.segment'), str('02')]);
      await a.instruction([ident('lsr')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['cr:02'],
          data: Uint8Array.of(0x4a),
        }],
        segments: [], symbols: [],
      });          
    });
  });

  describe('.pushseg/.popseg', function() {
    it('should switch and restore the segment', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('a', 'b');
      a.byte(4);
      a.pushSeg('a', 'c');
      a.byte(5);
      a.popSeg();
      a.byte(6);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['a', 'b'],
          data: Uint8Array.of(4, 6),
        }, {
          overwrite: 'allow',
          segments: ['a', 'c'],
          data: Uint8Array.of(5),
        }],
        symbols: [], segments: []});
    });

    it('should allow nesting', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('a', 'b');
      a.byte(4);
      a.pushSeg('a');
      a.byte(5);
      a.pushSeg('a', 'c');
      a.byte(6);
      a.popSeg();
      a.byte(7);
      a.popSeg();
      a.byte(8);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['a', 'b'],
          data: Uint8Array.of(4, 8),
        }, {
          overwrite: 'allow',
          segments: ['a'],
          data: Uint8Array.of(5, 7),
        }, {
          overwrite: 'allow',
          segments: ['a', 'c'],
          data: Uint8Array.of(6),
        }],
        symbols: [], segments: []});
    });

    it('should allow switching segments in the middle', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('a', 'b');
      a.byte(4);
      a.pushSeg('a');
      a.byte(5);
      a.segment('a', 'c');
      a.byte(6);
      a.segment('a');
      a.byte(7);
      a.popSeg();
      a.byte(8);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['a', 'b'],
          data: Uint8Array.of(4, 8),
        }, {
          overwrite: 'allow',
          segments: ['a'],
          data: Uint8Array.of(5),
        }, {
          overwrite: 'allow',
          segments: ['a', 'c'],
          data: Uint8Array.of(6),
        }, {
          overwrite: 'allow',
          segments: ['a'],
          data: Uint8Array.of(7),
        }],
        symbols: [], segments: []});
    });

    it('should restore the program counter', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('a', 'b');
      a.org(100);
      a.byte(4);
      a.pushSeg('a', 'c');
      a.org(10);
      a.byte(5);
      a.popSeg();
      a.byte(6);
      a.byte(a.pc());
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['a', 'b'],
          org: 100,
          data: Uint8Array.of(4, 6, 102),
        }, {
          overwrite: 'allow',
          segments: ['a', 'c'],
          org: 10,
          data: Uint8Array.of(5),
        }],
        symbols: [], segments: []});
    });
  });

  describe('.assert', function() {
    it('should pass immediately when true', function() {
      const a = new Assembler(Cpu.P02);
      a.assert({op: 'num', num: 1});
      expect(strip(a.module())).toEqual({chunks: [], symbols: [], segments: []});
    });

    it('should fail immediately when false', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.assert({op: 'num', num: 0}))
          .toThrow(/Assertion failed/);
    });

    it('should defer indeterminate assertions to the linker', function() {
      const a = new Assembler(Cpu.P02);
      a.label('Foo');
      a.directive([cs('.assert'), ident('Foo'), op('>'), num(8)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          name: 'Foo',
          data: Uint8Array.of(),
          asserts: [{op: '>', meta: {size: 1},
                     args: [off(0), {op: 'num', num: 8, meta: {size: 1}}]}],
        }],
        symbols: [], segments: []});
    });
  });

  describe('.scope', function() {
    it('should not leak inner symbols to outer scopes', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('bar', 12);
      a.scope('foo');
      a.assign('bar', 42);
      a.byte({op: 'sym', sym: 'bar'});
      a.endScope();
      a.byte({op: 'sym', sym: 'bar'});

      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(42, 12),
        }],
        symbols: [], segments: [],
      });
    });

    it('should inherit outer definitions', function() {
      const a = new Assembler(Cpu.P02);
      a.scope();
      a.scope('foo');
      a.byte({op: 'sym', sym: 'bar'});
      a.endScope();
      a.scope();
      a.byte({op: 'sym', sym: 'bar'});
      a.endScope();
      a.endScope();
      a.assign('bar', 14);
      
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff, 0xff),
          subs: [
            {offset: 0, size: 1, expr: {op: 'sym', num: 0}},
            {offset: 1, size: 1, expr: {op: 'sym', num: 1}},
          ],
        }],
        symbols: [
          {expr: {op: 'num', num: 14, meta: {size: 1}}},
          {expr: {op: 'num', num: 14, meta: {size: 1}}},
        ],
        segments: [],
      });
    });

    it('should allow writing into a scope', function() {
      const a = new Assembler(Cpu.P02);
      a.scope('foo');
      a.byte({op: 'sym', sym: 'bar'});
      a.endScope();
      a.assign('foo::bar', 13);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff),
          subs: [{offset: 0, size: 1, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [
          {expr: {op: 'num', num: 13, meta: {size: 1}}},
        ],
        segments: [],
      });
    });

    it('should allow symbols outside of scope to keep size', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('bar', 5);
      a.scope('foo');
      debugger;
      await a.instruction([ident('lda'), ident('bar')]);
      a.endScope();
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa5, 0xff),
          subs: [{offset: 1, size: 1, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: {meta: {size: 1}, num: 5, op: "num"}}], segments: [],
      });
    });
  
    it('should allow reading out of a scope', function() {
      const a = new Assembler(Cpu.P02);
      a.scope('foo');
      a.assign('bar', 5);
      a.endScope();
      a.byte({op: 'sym', sym: 'foo::bar'});
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x05),
        }],
        symbols: [], segments: [],
      });
    });
  });

  describe('.import', function() {
    it('should work before the reference', function() {
      const a = new Assembler(Cpu.P02);
      a.import('foo');
      a.byte({op: 'sym', sym: 'foo'});
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff),
          subs: [{offset: 0, size: 1, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: {op: 'im', sym: 'foo'}}],
        segments: [],
      });
    });

    it('should work after the reference', function() {
      const a = new Assembler(Cpu.P02);
      a.byte({op: 'sym', sym: 'foo'});
      a.import('foo');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff),
          subs: [{offset: 0, size: 1, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: {op: 'im', sym: 'foo'}}],
        segments: [],
      });
    });

    it('should work in a scope', function() {
      const a = new Assembler(Cpu.P02);
      a.scope();
      a.byte({op: 'sym', sym: 'foo'});
      a.endScope();
      a.import('foo');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff),
          subs: [{offset: 0, size: 1, expr: {op: 'sym', num: 0}}],
        }],
        symbols: [{expr: {op: 'im', sym: 'foo'}}],
        segments: [],
      });
    });

    it('should emit nothing if unused', function() {
      const a = new Assembler(Cpu.P02);
      a.import('foo');
      a.byte(2);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(2),
        }],
        symbols: [], segments: [],
      });
    });
  });

  describe('.export', function() {
    it('should export a later value', function() {
      const a = new Assembler(Cpu.P02);
      a.export('qux');
      a.assign('qux', 12);
      expect(strip(a.module())).toEqual({
        symbols: [{export: 'qux', expr: {op: 'num', num: 12, meta: {size: 1}}}],
        chunks: [], segments: [],
      });
    });

    it('should export an earlier value', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('qux', 12);
      a.export('qux');
      expect(strip(a.module())).toEqual({
        symbols: [{export: 'qux', expr: {op: 'num', num: 12, meta: {size: 1}}}],
        chunks: [], segments: [],
      });
    });
  });

  // TODO - test all the error cases...
});

function strip(o: Module): Module {
  for (const s of o.symbols || []) {
    stripExpr(s.expr);
  }
  for (const c of o.chunks || []) {
    if (c.name === 'Code') delete c.name;
    for (const a of c.asserts || []) {
      stripExpr(a);
    }
    for (const s of c.subs || []) {
      stripExpr(s.expr);
    }
  }
  return o;
  function stripExpr(e: Expr|undefined) {
    if (!e) return;
    delete e.source;
    for (const a of e.args || []) {
      stripExpr(a);
    }
  }
}
