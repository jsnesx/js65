
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {Cpu} from '../src/cpu.ts';
import {type Expr} from '../src/expr.ts';
import {type Module} from '../src/module.ts';
import {Assembler} from '../src/assembler.ts';
import {assemble as libAssemble, compile, type AssemblyInput} from '../src/libassembler.ts';
import {type Token} from '../src/token.ts';
import * as Tokens from '../src/token.ts';
import * as util from '../src/util.ts';

// Some directives (labels especially) are only observable after the preprocessor
// has split the source into lines, so those cases assemble a source snippet.
async function assemble(body: string): Promise<number[]> {
  const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n${body}`;
  const result = await compile([{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
  if (!result.success) throw new Error(JSON.stringify(result));
  return Array.from(result.outputs[0].data);
}

// Same as `assemble`, but for sources that are expected to fail.
// Returns the recorded error messages rather than the output bytes.
async function assembleErrors(body: string): Promise<string[]> {
  const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n${body}`;
  const result = await compile([{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
  if (result.success) throw new Error('Expected the assembly to fail');
  return result.messages.filter(m => m.level === 'error').map(m => m.message);
}

// Assembles a snippet through the full tokenizer/preprocessor pipeline and returns
// the module without linking it. Allows us to test for aliases as those are handled
// at the tokenizer level.
async function assembleModule(body: string): Promise<Module> {
  const result = await libAssemble([{type: 'source', code: body, name: 'test.s'} as AssemblyInput],
                                   {generateDebugInfo: false});
  if (!result.success) throw new Error(JSON.stringify(result.messages));
  return result.modules[0];
}

const [_a] = [util];

function ident(str: string): Token { return {token: 'ident', str}; }
function num(num: number): Token { return {token: 'num', num}; }
function str(str: string): Token { return {token: 'str', str}; }
function cs(str: string): Token { return {token: 'cs', str}; }
function op(str: string): Token { return {token: 'op', str}; }
const {COLON, COMMA, IMMEDIATE, LB, LP, RB, RP} = Tokens;
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
      } catch (err: any) {
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
      a.module();
      expect(a.hasErrors()).toBe(true);
      expect(a.getMessages().map(m => m.message))
          .toContain('Cheap local label never defined: @foo');
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
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 0}, off(2)]}},
                 {offset: 3, size: 1,
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 1}, off(4)]}}],
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
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 0}, off(2)]}}],
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
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 0}, off(5)]}},
                 {offset: 7, size: 1,
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 1}, off(8)]}},
                 {offset: 11, size: 1,
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 1}, off(12)]}}],
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
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 0}, off(2)]}},
                 {offset: 3, size: 1,
                  expr: {op: '-', meta: {branch: true}, args: [{op: 'sym', num: 1}, off(4)]}}],
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

  describe('.literal', function() {
    it('should emit strings without applying the charmap', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.charmap'), num(0x61), COMMA, num(0x80)]);
      a.directive([cs('.byte'), str('ab')]);
      a.directive([cs('.literal'), str('ab')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x80, 0x62, 0x61, 0x62),
        }],
        symbols: [], segments: []});
    });

    it('should emit strings without applying a multi-byte strmap', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.strmap'), str('ab'), COMMA,
                   LB, num(1), COMMA, num(2), COMMA, num(3), RB]);
      a.directive([cs('.byte'), str('ab')]);
      a.directive([cs('.literal'), str('ab')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(1, 2, 3, 0x61, 0x62),
        }],
        symbols: [], segments: []});
    });

    it('should support numbers and expressions like .byte', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('q', 5);
      a.directive([cs('.literal'), num(1), COMMA, num(2), op('+'), num(3),
                   COMMA, ident('q')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(1, 5, 5),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with forward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.literal'), ident('q'), op('+'), num(1)]);
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

  describe('.hibytes/.lobytes', function() {
    it('should emit the high byte of each expression', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.hibytes'), num(0x1234), COMMA, num(0x5678)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x12, 0x56),
        }],
        symbols: [], segments: []});
    });

    it('should emit the low byte of each expression', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.lobytes'), num(0x1234), COMMA, num(0x5678)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x34, 0x78),
        }],
        symbols: [], segments: []});
    });
  });

  describe('.addrsize', function() {
    it('should report 1 for a symbol in a segment marked zeropage', function() {
      const a = new Assembler(Cpu.P02);
      a.segment({name: 'zp', addressing: 1});
      a.label('zp_sym');
      a.segment({name: 'abs'});
      a.reloc();
      a.directive([cs('.byte'), cs('.addrsize'), LP, ident('zp_sym'), RP]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['zp'],
          name: 'zp_sym',
          zeropage: true,
          data: Uint8Array.of(),
        }, {
          overwrite: 'allow',
          segments: ['abs'],
          data: Uint8Array.of(1),
        }],
        symbols: [],
        segments: [{name: 'zp', addressing: 1}, {name: 'abs'}]});
    });

    it('should report 2 for a symbol in a segment not marked zeropage', function() {
      const a = new Assembler(Cpu.P02);
      a.segment({name: 'abs'});
      a.label('abs_sym');
      a.directive([cs('.zeropage')]);
      a.reloc();
      a.directive([cs('.byte'), cs('.addrsize'), LP, ident('abs_sym'), RP]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['abs'],
          name: 'abs_sym',
          data: Uint8Array.of(),
        }, {
          overwrite: 'allow',
          segments: ['ZEROPAGE'],
          zeropage: true,
          data: Uint8Array.of(2),
        }],
        symbols: [],
        segments: [{name: 'abs'}, {name: 'ZEROPAGE', addressing: 1}]});
    });

    it('should report 1 for a symbol in the .zeropage shorthand segment', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.zeropage')]);
      a.label('zp_sym');
      a.segment({name: 'abs'});
      a.reloc();
      a.directive([cs('.byte'), cs('.addrsize'), LP, ident('zp_sym'), RP]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['ZEROPAGE'],
          name: 'zp_sym',
          zeropage: true,
          data: Uint8Array.of(),
        }, {
          overwrite: 'allow',
          segments: ['abs'],
          data: Uint8Array.of(1),
        }],
        symbols: [],
        segments: [{name: 'ZEROPAGE', addressing: 1}, {name: 'abs'}]});
    });
  });

  describe('.strlen/.strat', function() {
    it('should compute a string literal length', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.byte'), cs('.strlen'), LP, str('hello'), RP]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(5),
        }],
        symbols: [], segments: []});
    });

    it('should extract a character from a string literal', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.byte'), cs('.strat'), LP, str('hello'), COMMA, num(1), RP]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of('e'.codePointAt(0)!),
        }],
        symbols: [], segments: []});
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

  describe('.dbyt', function() {
    it('should write words big-endian', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.dbyt'), num(1), COMMA, num(0x403)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0, 1, 4, 3),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with backward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('q', 0x305);
      a.directive([cs('.dbyt'), ident('q')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(3, 5),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with forward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.dbyt'), ident('q')]);
      a.label('q');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff, 0xff),
          subs: [{offset: 0, size: 1,
                  expr: {op: '>', args: [{op: 'sym', num: 0}]}},
                 {offset: 1, size: 1,
                  expr: {op: '<', args: [{op: 'sym', num: 0}]}}],
        }],
        symbols: [{expr: off(2)}],
        segments: []});
    });
  });

  describe('.faraddr', function() {
    it('should emit three little-endian bytes', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.faraddr'), num(1), COMMA, num(0x123456)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(1, 0, 0, 0x56, 0x34, 0x12),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with backward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('q', 0x30507);
      a.directive([cs('.faraddr'), ident('q')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(7, 5, 3),
        }],
        symbols: [], segments: []});
    });
  });

  describe('.dword', function() {
    it('should support numbers', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.dword'), num(1), COMMA, num(0x12345678)]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(1, 0, 0, 0, 0x78, 0x56, 0x34, 0x12),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with backward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('q', 0x305);
      a.directive([cs('.dword'), ident('q')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(5, 3, 0, 0),
        }],
        symbols: [], segments: []});
    });

    it('should support expressions with forward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.dword'), ident('q'), op('+'), num(1)]);
      a.label('q');
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff, 0xff, 0xff, 0xff),
          subs: [{offset: 0, size: 4,
                  expr: {op: '+', args: [{op: 'sym', num: 0},
                                         {op: 'num', num: 1,
                                          meta: {size: 1}}]}}],
        }],
        symbols: [{expr: off(4)}],
        segments: []});
    });
  });

  describe('.loword/.hiword', function() {
    it('should split a 32-bit value into words', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.word'), cs('.loword'), LP, num(0x12345678), RP,
                   COMMA, cs('.hiword'), LP, num(0x12345678), RP]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x78, 0x56, 0x34, 0x12),
        }],
        symbols: [], segments: []});
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
                   COLON, ident('off'), num(0),
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
      a.directive([cs('.segment'), str('02'), COLON, ident('off'), num(0), COLON, ident('bank'), num(2)]);
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

    it('should parse the ld65-compatible attributes', async function() {
      const m = await assembleModule(`
.segment "ROM" :mem $8000 :size $2000 :out "rom.bin" :fill $ff :define
.segment "CODE" :load "ROM" :run "RAM" :align $100 :alignload $10 :optional
.segment "VARS" :mem $300 :size $100 :bss :dedupe
.segment "ZP" :mem $10 :size $80 :zeropage
`);
      expect(m.segments).toEqual([{
        name: 'ROM',
        memory: 0x8000, size: 0x2000, offset: 0,
        out: 'rom.bin', fill: 0xff, define: true,
        free: [[0x8000, 0xa000]],
      }, {
        name: 'CODE',
        load: 'ROM', run: 'RAM',
        align: 0x100, alignLoad: 0x10, optional: true,
      }, {
        name: 'VARS',
        memory: 0x300, size: 0x100, bss: true, dedupe: true,
      }, {
        name: 'ZP',
        memory: 0x10, size: 0x80, addressing: 1, bss: true,
      }]);
    });

    it('should default :fill to zero', async function() {
      const m = await assembleModule(`.segment "ROM" :mem $8000 :size $10 :fill\n`);
      expect(m.segments).toEqual([{
        name: 'ROM', memory: 0x8000, size: 0x10, fill: 0,
        free: [[0x8000, 0x8010]],
      }]);
    });

    it('should ignore ld65 read-only attributes', async function() {
      const m = await assembleModule(`.segment "ROM" :mem $8000 :size $10 :ro\n`);
      expect(m.segments).toEqual([{name: 'ROM', memory: 0x8000, size: 0x10}]);
    });

    it('should reject a non-power-of-two alignment', async function() {
      await expect(assembleModule(`.segment "CODE" :align 3\n`))
          .rejects.toThrow(/align must be a power of two: 3/);
    });

    it('should reject an unknown segment attribute', async function() {
      await expect(assembleModule(`.segment "CODE" :overlay "ROM"\n`))
          .rejects.toThrow(/Unknown segment attr: overlay/);
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

  describe('predeclared ZEROPAGE segment', function() {
    function chunkIn(m: Module, segment: string) {
      const chunk = (m.chunks ?? []).find(c => c.segments.includes(segment));
      if (!chunk) throw new Error(`No chunk in segment ${segment}`);
      return chunk;
    }

    it('should give `.segment "ZEROPAGE"` zeropage address size', async function() {
      const m = await assembleModule(`.segment "ZEROPAGE"\nFoo: .res 1\n`);
      expect(m.segments).toEqual([{name: 'ZEROPAGE', addressing: 1}]);
    });

    it('should mark a chunk in `.segment "ZEROPAGE"` as zeropage', async function() {
      const m = await assembleModule(`.segment "ZEROPAGE"\nFoo: .res 1\n`);
      expect(chunkIn(m, 'ZEROPAGE').zeropage).toBe(true);
    });

    it('should keep zeropage address size when the segment also carries ld65 attributes',
       async function() {
         // The memory placement usually comes from the linker config, but a source
         // file is free to spell it out. Do not clear the address size in this case.
         const m = await assembleModule(`.segment "ZEROPAGE" :mem $10 :size $80\nFoo: .res 1\n`);
         expect(m.segments).toEqual([
           {name: 'ZEROPAGE', addressing: 1, memory: 0x10, size: 0x80}]);
         expect(chunkIn(m, 'ZEROPAGE').zeropage).toBe(true);
       });

    it('should report 1 from `.addrsize` for a label in `.segment "ZEROPAGE"`',
       async function() {
         const m = await assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  .byte .addrsize(Foo)
`);
         const code = chunkIn(m, 'CODE');
         expect(Array.from(code.data)).toEqual([1]);
       });

    it('should leave other named segments absolute', async function() {
      // Only ZEROPAGE is zeropage-addressed. The rest of ca65's predeclared
      // segments must stay absolute.
      const m = await assembleModule(`
.segment "BSS"
Foo: .res 1
.segment "CODE"
  sta Foo
`);
      const code = chunkIn(m, 'CODE');
      expect(Array.from(code.data)).toEqual([0x8d, 0xff, 0xff]);
    });
  });

  describe('zeropage operand sizing', function() {
    function codeOf(m: Module) {
      const chunk = (m.chunks ?? []).find(c => c.segments.includes('CODE'));
      if (!chunk) throw new Error('No chunk in segment CODE');
      return Array.from(chunk.data);
    }

    it('should size a label in the `.zeropage` shorthand segment as zeropage',
       async function() {
         const m = await assembleModule(`
.zeropage
Foo: .res 1
.segment "CODE"
  sta Foo
  lda Foo
`);
         expect(codeOf(m)).toEqual([0x85, 0xff, 0xa5, 0xff]);
       });

    it('should size a label in `.segment "ZEROPAGE"` as zeropage', async function() {
      const m = await assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  sta Foo
  lda Foo
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0xa5, 0xff]);
    });

    it('should size a label reached through a `.define`d segment name as zeropage',
       async function() {
         const m = await assembleModule(`
.define ZP_SEGMENT "ZEROPAGE"
.segment ZP_SEGMENT
Foo: .res 1
.segment "CODE"
  sta Foo
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    it('should size indexed operands on a zeropage label as zeropage', async function() {
      const m = await assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  lda Foo,x
  ldx Foo,y
`);
      expect(codeOf(m)).toEqual([0xb5, 0xff, 0xb6, 0xff]);
    });

    it('should still size a forward reference as absolute', async function() {
      // ca65 does the same here -- it can't know the address size yet, so it
      // picks absolute and warns. This guards against "fixing" it too eagerly.
      const m = await assembleModule(`
.segment "CODE"
  sta Foo
.segment "ZEROPAGE"
Foo: .res 1
`);
      expect(codeOf(m)).toEqual([0x8d, 0xff, 0xff]);
    });

    it('should still size a label in a non-zeropage segment as absolute',
       async function() {
         const m = await assembleModule(`
.segment "BSS"
Foo: .res 1
.segment "CODE"
  sta Foo
`);
         expect(codeOf(m)).toEqual([0x8d, 0xff, 0xff]);
       });

    it('should size an outer zeropage label referenced from a `.proc` as zeropage',
       async function() {
         // The reference resolves in the proc's scope, which doesn't have the
         // symbol, so the address size has to come from walking out to where it
         // is defined.
         const m = await assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
.proc p
  sta Foo
.endproc
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    it('should size an outer zeropage label referenced from a nested `.scope` as zeropage',
       async function() {
         const m = await assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
.scope outer
.scope inner
  sta Foo
.endscope
.endscope
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    it('should keep zeropage address size across an offset', async function() {
      // ca65 propagates address size through +/-, so `Ptr+1` is still zeropage.
      const m = await assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
  sta Ptr+1
  sta Ptr+0
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0x85, 0xff]);
    });

    it('should keep zeropage address size across an offset from a `.proc`',
       async function() {
         const m = await assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
.proc p
  sta Ptr+1
.endproc
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    it('should keep zeropage address size through an alias', async function() {
      const m = await assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
Alias := Ptr
  sta Alias
  sta Alias+1
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0x85, 0xff]);
    });

    it('should size an `.importzp` symbol offset as zeropage', async function() {
      const m = await assembleModule(`
.importzp Foo
.segment "CODE"
  sta Foo
  sta Foo+1
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0x85, 0xff]);
    });

    it('should stay absolute when an absolute label is offset by a zeropage one',
       async function() {
         // Nonsense arithmetic, but it must not silently become zeropage.
         const m = await assembleModule(`
.segment "ZEROPAGE"
Zp: .res 1
.segment "BSS"
Abs: .res 1
.segment "CODE"
  sta Abs+Zp
`);
         expect(codeOf(m)).toEqual([0x8d, 0xff, 0xff]);
       });

    it('should keep zeropage address size through an alias made inside a scope',
       async function() {
         // `:=` is handled as the preprocessor reads the line, so the alias is
         // built while the scope is open and `Zp` is only reachable through a
         // forward reference. That reference has to carry the address size, or
         // everything downstream of the alias goes absolute.
         const m = await assembleModule(`
.segment "ZEROPAGE"
Zp: .res 1
.segment "CODE"
.proc p
Alias := Zp
  sta Alias
.endproc
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    it('should keep zeropage address size when the offset gets folded away',
       async function() {
         // With an `.org` the label is no longer chunk-relative, so `Ptr+1`
         // folds to a plain number during `:=` and has to keep the address size
         // through the fold rather than riding along on the relative meta.
         const m = await assembleModule(`
.segment "ZEROPAGE"
.org $20
Ptr: .res 2
.segment "CODE"
Alias := Ptr+1
  sta Alias
`);
         expect(codeOf(m)).toEqual([0x85, 0x21]);
       });

    it('should keep zeropage address size for an offset from a nested scope',
       async function() {
         // Both halves at once: the reference has to find the outer definition
         // to get an address size, and the `+` has to carry it up.
         const m = await assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
.scope outer
.scope inner
  sta Ptr+1
.endscope
.endscope
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    // A constant defined outside a `.proc` is a value, not an address, so there
    // is no address size to carry - the value itself has to make it in. ca65
    // binds the name to the enclosing definition at the point of use, which
    // means the number is already in hand when the operand gets sized.
    it('should size a constant from an enclosing scope by its value',
       async function() {
         const m = await assembleModule(`
BLANK_TILE = $af
.segment "CODE"
.proc p
  lda BLANK_TILE
.endproc
`);
         expect(codeOf(m)).toEqual([0xa5, 0xaf]);
       });

    it('should size a constant from an enclosing scope through nested scopes',
       async function() {
         const m = await assembleModule(`
BLANK_TILE = $af
.segment "CODE"
.scope outer
.proc inner
  lda BLANK_TILE
.endproc
.endscope
`);
         expect(codeOf(m)).toEqual([0xa5, 0xaf]);
       });

    it('should fold an offset from an enclosing scope\'s constant', async function() {
      // Only worth anything if the value comes in rather than a reference: the
      // `+` has to fold to a number before the operand can be sized from it.
      const m = await assembleModule(`
BLANK_TILE = $af
.segment "CODE"
.proc p
  lda BLANK_TILE+1
.endproc
`);
      expect(codeOf(m)).toEqual([0xa5, 0xb0]);
    });

    it('should go absolute when an offset carries the value out of the zeropage',
       async function() {
         // Both halves fit in a byte and the sum does not, so the address size
         // cannot come from the operands alone.
         const m = await assembleModule(`
.segment "CODE"
  lda $ff+$ff
  lda $80+$80
`);
         expect(codeOf(m)).toEqual([0xad, 0xfe, 0x01, 0xad, 0x00, 0x01]);
       });

    it('should keep an offset absolute when an operand needs two bytes',
       async function() {
         const m = await assembleModule(`
BIG = $1234
.segment "CODE"
.proc p
  lda BIG-$1200
.endproc
`);
         expect(codeOf(m)).toEqual([0xad, 0x34, 0x00]);
       });

    it('should size an explicitly scoped constant by its value', async function() {
      const m = await assembleModule(`
.scope consts
BLANK_TILE = $af
.endscope
.segment "CODE"
.proc p
  lda consts::BLANK_TILE
.endproc
`);
      expect(codeOf(m)).toEqual([0xa5, 0xaf]);
    });

    it('should stay absolute for a constant from an enclosing scope that does not fit',
       async function() {
         const m = await assembleModule(`
BIG = $1234
.segment "CODE"
.proc p
  lda BIG
.endproc
`);
         expect(codeOf(m)).toEqual([0xad, 0x34, 0x12]);
       });

    it('should still size a constant defined after the reference as absolute',
       async function() {
         // Same rule as a forward-referenced label: nothing knows the value yet,
         // so the operand has to assume the worst. Guards against widening the
         // lookup into a second pass.
         const m = await assembleModule(`
.segment "CODE"
.proc p
  lda BLANK_TILE
.endproc
BLANK_TILE = $af
`);
         expect(codeOf(m)).toEqual([0xad, 0xff, 0xff]);
       });

    it('should bind to the enclosing constant when the local one comes later',
       async function() {
         // The first reference has only the outer `$af` to go on; the second is
         // after the local definition and takes that instead.
         const m = await assembleModule(`
BLANK_TILE = $af
.segment "CODE"
.proc p
  lda BLANK_TILE
BLANK_TILE = $12
  lda BLANK_TILE
.endproc
`);
         expect(codeOf(m)).toEqual([0xa5, 0xaf, 0xa5, 0x12]);
       });
  });

  // `.align` in relocatable mode defers to the linker by starting a new chunk
  // with an alignment constraint. If the segment ends before any data follows,
  // that constraint has to stay with the segment it was written in - ca65 pads
  // at the point of the directive - instead of leaking onto the next segment.
  describe('trailing .align', function() {
    function chunksIn(m: Module, segment: string) {
      return (m.chunks ?? []).filter(c => c.segments.includes(segment));
    }

    it('should pad the segment it appeared in', async function() {
      const m = await assembleModule(`
.segment "BBB"
  .byte 4
  .align 64
.segment "AAA"
  .byte 6,7,8
`);
      const [bbb] = chunksIn(m, 'BBB');
      expect(Array.from(bbb.data)).toEqual([4, ...new Array(63).fill(0)]);
      expect(bbb.align).toBe(64);
    });

    it('should not leak the alignment onto the next segment', async function() {
      const m = await assembleModule(`
.segment "BBB"
  .byte 4
  .align 64
.segment "AAA"
  .byte 6,7,8
`);
      const [aaa] = chunksIn(m, 'AAA');
      expect(Array.from(aaa.data)).toEqual([6, 7, 8]);
      expect(aaa.align).toBeUndefined();
    });

    it('should use the fill value it was given', async function() {
      const m = await assembleModule(`
.segment "BBB"
  .byte 4
  .align 8, $ff
.segment "AAA"
  .byte 6
`);
      const [bbb] = chunksIn(m, 'BBB');
      expect(Array.from(bbb.data)).toEqual([4, ...new Array(7).fill(0xff)]);
    });

    it('should pad a segment left aligned at the end of the source', async function() {
      const m = await assembleModule(`
.segment "BBB"
  .byte 4
  .align 8
`);
      const [bbb] = chunksIn(m, 'BBB');
      expect(Array.from(bbb.data)).toEqual([4, ...new Array(7).fill(0)]);
      expect(bbb.align).toBe(8);
    });

    it('should keep deferring the alignment when data follows it', async function() {
      // The normal case is unchanged: the alignment belongs to the new chunk,
      // and the linker gets to place it wherever it fits.
      const m = await assembleModule(`
.segment "BBB"
  .byte 4
  .align 64
  .byte 5
`);
      const chunks = chunksIn(m, 'BBB');
      expect(chunks.map(c => Array.from(c.data))).toEqual([[4], [5]]);
      expect(chunks.map(c => c.align)).toEqual([undefined, 64]);
    });

    it('should take the widest of several trailing alignments', async function() {
      const m = await assembleModule(`
.segment "BBB"
  .byte 4
  .align 8
  .align 64
  .align 2
.segment "AAA"
  .byte 6
`);
      const [bbb] = chunksIn(m, 'BBB');
      expect(bbb.align).toBe(64);
      expect(bbb.data.length).toBe(64);
    });

    it('should pad the pushed segment when `.popseg` ends it', async function() {
      const m = await assembleModule(`
.segment "AAA"
  .byte 6
.pushseg "BBB"
  .byte 4
  .align 8
.popseg
  .byte 7
`);
      const [bbb] = chunksIn(m, 'BBB');
      expect(Array.from(bbb.data)).toEqual([4, ...new Array(7).fill(0)]);
      expect(bbb.align).toBe(8);
      expect(chunksIn(m, 'AAA').map(c => Array.from(c.data))).toEqual([[6, 7]]);
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

  describe('.setcpu/.pushcpu/.popcpu', function() {
    it('should accept a supported cpu', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.setcpu'), str('6502')]);
      a.directive([cs('.setcpu'), str('6502X')]);
    });

    it('should reject an unsupported cpu', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.directive([cs('.setcpu'), str('65816')]))
          .toThrow(/Unsupported CPU: 65816/);
    });

    it('should allow balanced pushes and pops', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.pushcpu')]);
      a.directive([cs('.pushcpu')]);
      a.directive([cs('.popcpu')]);
      a.directive([cs('.popcpu')]);
    });

    it('should reject a .popcpu with no matching .pushcpu', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.pushcpu')]);
      a.directive([cs('.popcpu')]);
      expect(() => a.directive([cs('.popcpu')]))
          .toThrow(/\.popcpu without \.pushcpu/);
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
          {expr: {op: 'sym', num: 0}},
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

    // Disabled for now
    // it('should allow symbols outside of scope to keep size', async function() {
    //   const a = new Assembler(Cpu.P02);
    //   a.assign('bar', 5);
    //   a.scope('foo');
    //   await a.instruction([ident('sta'), ident('bar')]);
    //   a.endScope();
    //   expect(strip(a.module())).toEqual({
    //     chunks: [{
    //       overwrite: 'allow',
    //       segments: [],
    //       data: Uint8Array.of(0xa5, 0x05),
    //       subs: [{offset: 1, size: 1, expr: {op: 'sym', num: 0}}],
    //     }],
    //     symbols: [{expr: {meta: {size: 1}, num: 5, op: "num"}}], segments: [],
    //   });
    // });
  
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

    it('should not emit an empty chunk when opened outside a segment', async function() {
      const m = await assembleModule(`
.scope Constants
  FOO = 1
  BAR = 2
.endscope
.struct Point
  xc .byte
  yc .byte
.endstruct
.segment "DATA"
  .byte Constants::FOO, Constants::BAR
  .byte .sizeof(Point)
`);
      // Check that the only chunk is from the DATA segment
      expect(m.chunks!.map(c => ({segments: c.segments, data: c.data}))).toEqual([
        {segments: ['DATA'], data: Uint8Array.of(1, 2, 2)},
      ]);
    });

    it('should emit no chunks at all for a source that only declares a scope',
       async function() {
      const m = await assembleModule(`.scope Constants\n  FOO = 1\n.endscope\n`);
      expect(m.chunks).toEqual([]);
    });

    // The size of a scope still has to be measured from the first byte the scope
    // actually emits, even though the chunk doesn't exist when the scope opens.
    it('should size a scope that opens before its chunk exists', async function() {
      const m = await assembleModule(`
.segment "DATA"
.scope Sized
  .byte 1, 2, 3
.endscope
  .byte .sizeof(Sized)
`);
      expect(m.chunks!.map(c => c.data)).toEqual([Uint8Array.of(1, 2, 3, 3)]);
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

  describe('sized syms', function() {
    it('should use a zp value when the size of the assignment is known', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5);
      await a.instruction([ident('lda'), ident('foo')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa5, 5),
        }],
        symbols: [],
      });
    });
    // it('should produce an error when the assignment is negative', async function() {
    //   const a = new Assembler(Cpu.P02);
    //   a.assign('foo', -5);
    //   await a.instruction([ident('lda'), ident('foo')]);
    //   try {
    //     await a.instruction([ident('lda'), ident('foo')]);
    //     expect("").toEqual("Test failed, didn't throw an error.");
    //   } catch (err: any) {
    //     expect(err.message).toEqual("-5 not in range 0-255");
    //   }
    // });
    it('should use a zp value for negative zero', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', -0);
      await a.instruction([ident('lda'), ident('foo')]);
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa5, 0),
        }],
        symbols: [],
      });
    });
    it('should use an abs value because foo is resolved to the scope instead', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5);
      a.scope();
      a.assign('foo', 5000);
      await a.instruction([ident('lda'), ident('foo')]);
      a.endScope();
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xad, 5000 & 0xff, 5000 >> 8),
        }],
        symbols: [],
      });
    });
    // it('should error since foo is resolved as size 1 when outputting the byte, but when resolved later its 2 bytes', async function() {
    //   const a = new Assembler(Cpu.P02);
    //   a.assign('foo', 5);
    //   a.scope();
    //   await a.instruction([ident('lda'), ident('foo')]);
    //   a.assign('foo', 5000);
    //   a.endScope();
    //   try {
    //     a.module();
    //     expect("").toEqual("Test failed, didn't throw an error.");
    //   } catch (err: any) {
    //     console.log(err.message);
    //     expect(err.message).toEqual("5000 doesn't fit in one byte");
    //   }
    // });
    it('should use the outer foo when the inner one is not assigned until later', async function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5000);
      a.scope();
      await a.instruction([ident('lda'), ident('foo')]);
      a.assign('foo', 5);
      a.endScope();
      // The reference binds to whatever `foo` names at the point of use, and at
      // that point the only `foo` is the outer one. The inner assignment starts
      // a new symbol that this instruction never sees.
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xad, 5000 & 0xff, 5000 >> 8),
        }],
        symbols: [],
      });
    });
    it('should use an abs value because the symbol is undefined, so it is sized to 2 until the symbol is defined', async function() {
      const a = new Assembler(Cpu.P02);
      await a.instruction([ident('lda'), ident('foo')]);
      a.assign('foo', 5);
      // We make a sized substitution for this and set that we'll sub in 5 later.
      // This should also throw a warning that we didn't use ZP addressing for foo
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xad, 0xff, 0xff),
          subs: [{
            expr: { num: 0, op: "sym", },
            offset: 1, size: 2,
          }],
        }],
        symbols: [{
          expr: {
            meta: { size: 1 },
            num: 5, op: "num"},
        }],
      });
    });
    it('should use an abs value because the symbol is undefined and it ends up using the global foo anyway', async function() {
      const a = new Assembler(Cpu.P02);
      a.scope();
      await a.instruction([ident('lda'), ident('foo')]);
      a.endScope();
      a.assign('foo', 5);
      // This does NOT throw a warning in ca65 for ... reasons?
      expect(strip(a.module())).toEqual({
        segments: [],
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xad, 0xff, 0xff),
          subs: [{
            expr: { num: 0, op: "sym", },
            offset: 1, size: 2,
          }],
        }],
        symbols: [{
          expr: {
            meta: { size: 1 },
            num: 5, op: "num"},
        }],
      });
    });
    it('should error due to duplicate scope', async function() {
      const a = new Assembler(Cpu.P02);
      try {
        a.scope("foo");
        a.endScope();
        a.scope("foo");
        a.endScope();
        expect("").toEqual("Test failed, didn't throw an error.");
      } catch (err: any) {
        expect(err.message).toEqual("Cannot re-enter scope foo");
      }
    });
  });

  describe('.end', function() {
    it('stops assembling the rest of the file', async function() {
      expect(await assemble(`
  .byte 1
  .end
  .byte 2
`)).toEqual([1]);
    });

    // `###` fails in the preprocessor rather than the assembler, checking that
    // the file is really stopped processing completely
    it('does not require the rest of the file to be valid', async function() {
      expect(await assemble(`
  .byte 1
  .end
  .notadirective bogus
  ###
`)).toEqual([1]);
    });

    it('is skipped inside a false conditional', async function() {
      expect(await assemble(`
  .byte 1
  .if 0
  .end
  .endif
  .byte 2
`)).toEqual([1, 2]);
    });
  });

  describe('.forceimport', function() {
    it('imports the symbol like .import', async function() {
      const m = await assembleModule(`.forceimport foo\n.byte foo\n`);
      expect(strip(m).symbols).toEqual([{expr: {op: 'im', sym: 'foo'}}]);
    });
  });

  describe('.fopt', function() {
    it('is accepted and ignored as its unimplemented still', async function() {
      const m = await assembleModule(`.fopt comment, "hello"\n.byte 1\n`);
      expect(m.chunks![0].data).toEqual(Uint8Array.of(1));
    });
  });

  describe('.fatal', function() {
    it('aborts the assembly instead of continuing like .error', async function() {
      // `.error` is recoverable, so everything after it is still assembled...
      expect(await assembleErrors(`
  .error "first"
  .error "second"
`)).toEqual(['first', 'second']);
      // ...while `.fatal` stops immediately, so the second one never runs.
      expect(await assembleErrors(`
  .fatal "first"
  .error "second"
`)).toEqual(['first']);
    });

    it('reports its message exactly once', async function() {
      expect(await assembleErrors(`  .fatal "boom"\n`)).toEqual(['boom']);
    });

    it('requires a single string argument', async function() {
      expect(await assembleErrors(`  .fatal\n`))
          .toEqual(['Expected constant string after .FATAL']);
    });
  });

  describe('.sizeof', function() {
    it('reports the total size of a struct', async function() {
      expect(await assemble(`
.struct Player
  xpos .byte
  ypos .byte
  hp   .word
.endstruct
  .byte .sizeof(Player)
`)).toEqual([4]);
    });

    it('treats a struct tag as a scope rather than a value', async function() {
      // As in ca65, a struct name names a scope whose size is only reachable
      // through `.sizeof` - it is not itself a symbol holding the size.
      await expect(assemble(`
.struct Player
  hp .word
.endstruct
  .byte Player
`)).rejects.toThrow(/Symbol 'Player' undefined/);
    });

    it('reports the size of an individual struct field', async function() {
      expect(await assemble(`
.struct Player
  xpos .byte
  hp   .word
  name .byte 8
.endstruct
  .byte .sizeof(Player::xpos), .sizeof(Player::hp), .sizeof(Player::name)
`)).toEqual([1, 2, 8]);
    });

    it('reports the size of a .tag field as the tagged struct size', async function() {
      expect(await assemble(`
.struct Point
  x .byte
  y .byte
.endstruct
.struct Player
  hp  .word
  pos .tag Point
.endstruct
  .byte .sizeof(Player::pos), .sizeof(Player)
`)).toEqual([2, 4]);
    });

    it('reports the size of a .proc', async function() {
      expect(await assemble(`
.proc Foo
  lda #$00
  rts
.endproc
  .byte .sizeof(Foo)
`)).toEqual([0xa9, 0x00, 0x60, 3]);
    });

    it('includes nested scopes in a .proc size', async function() {
      expect(await assemble(`
.proc Outer
  .byte $01
  .proc Inner
    .byte $02, $03
  .endproc
  .byte $04
.endproc
  .byte .sizeof(Outer), .sizeof(Outer::Inner)
`)).toEqual([1, 2, 3, 4, 4, 2]);
    });

    it('resolves a forward reference to a .proc size', async function() {
      expect(await assemble(`
  .byte .sizeof(Later)
.proc Later
  .byte $01, $02, $03
.endproc
`)).toEqual([3, 1, 2, 3]);
    });

    it('prefers a scope over a symbol of the same name', async function() {
      expect(await assemble(`
Foo = 99
.scope Foo
  .byte $01, $02
.endscope
  .byte .sizeof(Foo)
`)).toEqual([1, 2, 2]);
    });

    it('reports the size of data declared on a label line', async function() {
      expect(await assemble(`
buf: .res 10
tbl: .byte $01, $02, $03
  .byte .sizeof(buf), .sizeof(tbl)
`)).toEqual([...new Array(10).fill(0), 1, 2, 3, 10, 3]);
    });

    it('reports zero for a label with no data on its line', async function() {
      expect(await assemble(`
empty:
  .byte $aa
  .byte .sizeof(empty)
`)).toEqual([0xaa, 0]);
    });

    it('resolves forward references to structs and labels', async function() {
      expect(await assemble(`
  .byte .sizeof(Later), .sizeof(buf)
.struct Later
  a .byte
  b .word
.endstruct
buf: .res 5
`)).toEqual([3, 5, 0, 0, 0, 0, 0]);
    });

    // Unlike ca65, which counts only the segment active when a scope opened, js65
    // counts every chunk the scope covers - crossing chunks is normal here, since
    // `.reloc` and multi-segment placement make it something users do on purpose.
    function sizeOfScope(build: (a: Assembler) => void, name: string) {
      const a = new Assembler(Cpu.P02);
      build(a);
      return a.evaluate(a.resolve({op: '.sizeof', args: [{op: 'sym', sym: name}]}));
    }

    it('counts data on both sides of a .reloc inside a scope', function() {
      expect(sizeOfScope(a => {
        a.segment('CODE');
        a.proc('Split');
        a.byte(1, 2, 3);
        a.reloc();
        a.byte(4, 5);
        a.endProc();
      }, 'Split')).toBe(5);
    });

    it('counts data across a segment change inside a scope', function() {
      expect(sizeOfScope(a => {
        a.segment('CODE');
        a.proc('Split');
        a.byte(1);
        a.segment('OTHER');
        a.byte(2, 3);
        a.endProc();
      }, 'Split')).toBe(3);
    });

    it('counts every chunk of a scope spanning more than two', function() {
      expect(sizeOfScope(a => {
        a.segment('CODE');
        a.org(0x8000);
        a.proc('Split');
        a.byte(1, 2);
        a.org(0x9000);
        a.byte(3, 4, 5, 6);
        a.org(0xa000);
        a.byte(7);
        a.endProc();
      }, 'Split')).toBe(7);
    });

    it('sizes a scope placed in one of several candidate segments', function() {
      // A segment list is a placement choice for a single chunk, not a split.
      expect(sizeOfScope(a => {
        a.segment('A', 'B', 'C');
        a.proc('Multi');
        a.byte(1, 2, 3, 4);
        a.endProc();
      }, 'Multi')).toBe(4);
    });

    it('rejects .sizeof on an undefined name', async function() {
      await expect(assemble(`  .byte .sizeof(Nope)\n`))
          .rejects.toThrow(/Size of 'Nope' is unknown/);
    });
  });
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
