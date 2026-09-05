
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {Cpu} from '../src/cpu.ts';
import {type Expr} from '../src/expr.ts';
import {type Module} from '../src/module.ts';
import {Assembler} from '../src/assembler.ts';
import {FEATURE_NAMES, type TokenizerOptions} from '../src/options.ts';
import {assemble as libAssemble, compile, deserializeObjectFile, serializeObjectFile,
        type AssemblyInput} from '../src/libassembler.ts';
import {replayModule, replayModules, type LinkTimeEnv} from '../src/latepass.ts';
import {type Token} from '../src/token.ts';
import * as Tokens from '../src/token.ts';
import * as util from '../src/util.ts';

// Some directives (labels especially) are only observable after the preprocessor
// has split the source into lines, so those cases assemble a source snippet.
function assemble(body: string): number[] {
  const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n${body}`;
  const result = compile([{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
  if (!result.success) throw new Error(JSON.stringify(result));
  return Array.from(result.outputs[0].data);
}

// Same as `assemble`, but for sources that are expected to fail.
// Returns the recorded error messages rather than the output bytes.
function assembleErrors(body: string): string[] {
  const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n${body}`;
  const result = compile([{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
  if (result.success) throw new Error('Expected the assembly to fail');
  return result.messages.filter(m => m.level === 'error').map(m => m.message);
}

// Same as `assemble`, but for sources that are expected to succeed while
// reporting something. Returns the recorded warnings rather than the bytes.
function assembleWarnings(body: string): string[] {
  const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n${body}`;
  const result = compile([{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
  if (!result.success) throw new Error(JSON.stringify(result.messages));
  return result.messages.filter(m => m.level === 'warning').map(m => m.message);
}

// Assembles a snippet through the full tokenizer/preprocessor pipeline and returns
// the module without linking it. Allows us to test for aliases as those are handled
// at the tokenizer level.
function assembleModule(body: string): Module {
  const result = libAssemble([{type: 'source', code: body, name: 'test.s'} as AssemblyInput],
                                   {generateDebugInfo: false});
  if (!result.success) throw new Error(JSON.stringify(result.messages));
  return result.modules[0];
}

const [_a] = [util];

function ident(str: string): Token { return {token: 'ident', str}; }
function num(num: number): Token { return {token: 'num', num}; }
function str(str: string): Token { return {token: 'str', str}; }
function cs(str: string): Token { return {token: 'cs', str}; }

// Feeds a hand-built line list to `Assembler.tokens()` as its `Tokens.Source`,
// standing in for the preprocessor so raw `.if`/`.elseif`/`.else`/`.endif`
// markers (which the preprocessor normally consumes) reach the assembler.
function tokenSource(lines: Token[][]): Tokens.Source {
  let i = 0;
  return {next: () => lines[i++]};
}
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
    it('should handle `lda #$03`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lda'), IMMEDIATE, num(3)]);
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

    it('should handle `sta $02`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('sta'), num(2)]);
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

    it('should handle `ldy $032f`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('ldy'), num(0x32f)]);
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

    it('should handle `rts`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('rts')]);
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

    it('should handle `lda ($24),y`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lda'), LP, num(0x24), RP, COMMA, ident('y')]);
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

    it('should handle `sta ($20,x)`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('sta'), LP, num(0x20), COMMA, ident('x'), RP]);
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

    it('should handle `lsr`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lsr')]);
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

    it('should handle `lsr a`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lsr'), ident('A')]);
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

    it('should handle `ora $480,x`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('ora'), num(0x480), COMMA, ident('x')]);
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

    it('should handle `ora ($ff,x)`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('ora'), LP, num(0xff), COMMA, ident('x'), RP]);
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

    it('should handle `lda a:$80,x`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lda'), ident('a'), COLON, num(0x80), COMMA, ident('x')]);
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

    it('should handle `lda z:a:$80,x`', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lda'), ident('z'), COLON, ident('a'), COLON, num(0x80), COMMA, ident('x')]);
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

    it('should error for improper address mode `lda z:$8000,y`', function() {
      const a = new Assembler(Cpu.P02);
      try {
        a.instruction([ident('lda'), ident('z'), COLON, num(0x8000), COMMA, ident('y')]);
      } catch (err: any) {
        expect(err.message).toEqual("Bad address mode zpy for lda");
      }
    });
  });

  describe('Symbols', function() {
    it('should fill in an immediately-available value', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', 0x23);
      a.instruction([ident('lda'), IMMEDIATE, ident('val')]);
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

    it('should substitute a immediately-available single-byte value with a zp instruction', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', 0x23);
      a.instruction([ident('lda'), ident('val')]);
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

    it('should fill in an immediately-available multi-byte value', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', 0x2345);
      a.instruction([ident('lda'), ident('val')]);
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

    it('should fill in an immediately-available label', function() {
      const a = new Assembler(Cpu.P02);
      a.org(0x9135);
      a.label('foo');
      a.instruction([ident('ldx'), IMMEDIATE, op('<'), ident('foo')]);
      a.instruction([ident('ldy'), IMMEDIATE, op('>'), ident('foo')]);
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

    it('should make a separate chunk for separate .org directives', function() {
      const a = new Assembler(Cpu.P02);
      a.org(0x1234);
      a.instruction([ident('rts')]);
      a.org(0x5678);
      a.instruction([ident('ldy'), IMMEDIATE, num(0x12)]);
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

    it('should merge chunks when .org is redundant with PC', function() {
      const a = new Assembler(Cpu.P02);
      a.org(0x1234);
      a.instruction([ident('rts')]);
      a.org(0x1235);
      a.instruction([ident('ldy'), IMMEDIATE, num(0x12)]);
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

    it('should substitute a forward referenced value', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lda'), IMMEDIATE, ident('val')]);
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
    // it('should substitute a forward referenced single-byte value with a zp instruction', function() {
    //   const a = new Assembler(Cpu.P02);
    //   a.instruction([ident('lda'), ident('val')]);
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

    it('should substitute a forward referenced multi-byte value', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lda'), ident('val')]);
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

    it('should substitute a forward referenced label', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.org'), num(0x8000)]);
      a.instruction([ident('jsr'), ident('foo')]);
      expect(a.definedSymbol('foo')).toEqual(false);
      a.instruction([ident('lda'), IMMEDIATE, num(0)]);
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

    it('should allow overwriting mutable symbols', function() {
      const a = new Assembler(Cpu.P02);
      a.set('foo', 5);
      a.instruction([ident('lda'), IMMEDIATE, ident('foo')]);
      a.set('foo', 6);
      a.instruction([ident('lda'), IMMEDIATE, ident('foo')]);

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

    it('should substitute a formula', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('val', {op: '+', args: [{op: 'num', num: 1},
                                       {op: 'sym', sym: 'x'}]});
      a.instruction([ident('lda'), IMMEDIATE, ident('val')]);
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
    it('should handle backward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.label('@foo');
      a.instruction([ident('ldx'), IMMEDIATE, op('<'), ident('@foo')]);
      a.instruction([ident('ldy'), IMMEDIATE, op('>'), ident('@foo')]);
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

    it('should handle forward refs', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('jsr'), ident('@foo')]);
      a.instruction([ident('lda'), IMMEDIATE, num(0)]);
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

    it('should allow using a cheap local name for a constant', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('@temp', 5);
      a.instruction([ident('lda'), IMMEDIATE, ident('@temp')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 5),
        }],
        symbols: [], segments: []});
    });

    it('should clear cheap local constants on a non-cheap label', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('@temp', 5);
      a.instruction([ident('lda'), IMMEDIATE, ident('@temp')]);
      a.label('bar');
      a.assign('@temp', 6);
      a.instruction([ident('lda'), IMMEDIATE, ident('@temp')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 5, 0xa9, 6),
        }],
        symbols: [], segments: []});
    });

    it('should not allow redefining a cheap local constant', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('@temp', 5);
      expect(() => a.assign('@temp', 6)).toThrow(/Redefining symbol @temp/);
    });

    it('should allow redefining a cheap local constant after a label changes', function() {
      const a = new Assembler(Cpu.P02);
      a.reloc();
      a.label('test1');
      a.assign('@temp', 5);
      a.instruction([ident('lda'), IMMEDIATE, ident('@temp')]);
      a.reloc();
      a.label('test2');
      a.assign('@temp', 6);
      a.instruction([ident('lda'), IMMEDIATE, ident('@temp')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          name: "test1",
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 5),
        },{
          name: "test2",
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xa9, 6),
        }],
        symbols: [], segments: []});
    });

    it('should not allow reusing names in the same cheap scope', function() {
      const a = new Assembler(Cpu.P02);
      a.label('@foo');
      expect(() => a.label('@foo')).toThrow(/Redefining symbol @foo/);
    });

    it('should clear the scope on a non-cheap label', function() {
      const a = new Assembler(Cpu.P02);
      a.label('@foo');
      a.instruction([ident('jsr'), ident('@foo')]);
      a.label('bar');
      a.instruction([ident('jsr'), ident('@foo')]);
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

    it('should be an error if a cheap label is never defined', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('jsr'), ident('@foo')]);
      expect(() => a.label('bar'))
          .toThrow(/Cheap local label never defined: @foo/);
      a.module();
      expect(a.hasErrors()).toBe(true);
      expect(a.getMessages().map(m => m.message))
          .toContain('Cheap local label never defined: @foo');
    });
  });

  describe('Anonymous labels', function() {
    it('should work for forward references', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('bne'), op(':'), op('++')]);
      a.label(':');
      a.instruction([ident('bcc'), ident(':+3')]);
      a.label(':'); // first target
      a.instruction([ident('lsr')]);
      a.label(':');
      a.instruction([ident('lsr')]);
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

    it('should work for backward references', function() {
      const a = new Assembler(Cpu.P02);
      a.label(':'); // first target
      a.instruction([ident('lsr')]);
      a.label(':');
      a.instruction([ident('lsr')]);
      a.instruction([ident('lsr')]);
      a.label(':'); // second target
      a.instruction([ident('bne'), op(':'), op('---')]);
      a.label(':');
      a.instruction([ident('bcc'), ident(':-2')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x4a, 0x4a, 0x4a, 0xd0, 0xfb, 0x90, 0xfc),
        }],
        symbols: [], segments: []});
    });

    it('should allow one label for both forward directions', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('bne'), op(':'), op('+')]);
      a.label(':');
      a.instruction([ident('bcc'), ident(':-')]);
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

    it('should handle rts references', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('rts')]);
      a.instruction([ident('bne'), ident(':<rts')]);
      a.instruction([ident('bne'), ident(':rts')]);
      a.instruction([ident('rts')]);
      a.instruction([ident('bne'), ident(':>>rts')]);
      a.instruction([ident('bne'), ident(':<<rts')]);
      a.instruction([ident('bne'), ident(':>>rts')]);
      a.instruction([ident('bne'), ident(':<<rts')]);
      a.instruction([ident('rts')]);
      a.instruction([ident('rts')]);
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
    it('should work for forward references', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('bne'), op('++')]);
      a.label('+');
      a.instruction([ident('bcc'), ident('+++')]);
      a.label('++');
      a.instruction([ident('lsr')]);
      a.instruction([ident('lsr')]);
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

    it('should work for backward references', function() {
      const a = new Assembler(Cpu.P02);
      a.label('--'); // first target
      a.instruction([ident('lsr')]);
      a.instruction([ident('lsr')]);
      a.instruction([ident('lsr')]);
      a.label('-'); // second target
      a.instruction([ident('bne'), op('--')]);
      a.instruction([ident('bcc'), ident('-')]);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0x4a, 0x4a, 0x4a, 0xd0, 0xfb, 0x90, 0xfc),
        }],
        symbols: [], segments: []});
    });
  });

  describe('mnemonic-named labels', function() {
    // A name that is an instruction or a macro is never a label, colon or not,
    // which is what ca65 does.  Reading `inx:` as a label named `inx` used to
    // drop the instruction and report nothing at all.
    it('should reject a mnemonic followed by a colon', function() {
      expect(assembleErrors('inx:\n')).not.toEqual([]);
    });

    it('should reject a mnemonic used as a label before more code', function() {
      expect(assembleErrors('inx : iny\n')).not.toEqual([]);
      expect(assembleErrors('nop : inx : iny\n')).not.toEqual([]);
      expect(assembleErrors('foo: nop : bar: dex\n')).not.toEqual([]);
    });

    it('should reject a macro name followed by a colon', function() {
      expect(assembleErrors('.macro mm\n  inx\n.endmacro\nmm:\n'))
          .not.toEqual([]);
    });

    it('should still accept an ordinary label before an instruction',
       function() {
      expect(assemble('foo: nop\n  jmp foo\n'))
          .toEqual([0xea, 0x4c, 0x00, 0x80]);
    });

    it('should reject a mnemonic-named symbol from an assignment', function() {
      // `ubiquitous_idents` is off by default, so `nop` cannot name a symbol.
      expect(assembleErrors('nop = $12\n  lda nop\n'))
          .toEqual([expect.stringMatching(/named after the instruction nop/)]);
    });

    it('should reject a mnemonic-named macro', function() {
      expect(assembleErrors('.macro nop\n  inx\n.endmacro\n'))
          .toEqual([expect.stringMatching(/named after the instruction nop/)]);
      expect(assembleErrors('.define nop $12\n'))
          .toEqual([expect.stringMatching(/named after the instruction nop/)]);
    });
  });

  describe('.feature ubiquitous_idents', function() {
    it('should allow a mnemonic-named symbol when on', function() {
      expect(assemble('.feature ubiquitous_idents\nnop = $12\n  lda nop\n'))
          .toEqual([0xa5, 0x12]);
    });

    it('should allow a mnemonic-named label when on', function() {
      expect(assemble('.feature ubiquitous_idents\nnop:\n  jmp nop\n'))
          .toEqual([0x4c, 0x00, 0x80]);
    });

    it('should allow a mnemonic-named macro when on', function() {
      expect(assemble('.feature ubiquitous_idents\n.macro nop\n  inx\n' +
                      '.endmacro\n  nop\n')).toEqual([0xe8]);
    });

    it('should go back to rejecting them when turned off again', function() {
      expect(assembleErrors('.feature ubiquitous_idents\n' +
                            '.feature ubiquitous_idents off\nnop = $12\n'))
          .toEqual([expect.stringMatching(/named after the instruction nop/)]);
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
    it('should report larger numbers, and still truncate them', function() {
      // Truncating keeps everything after this at the address it would have
      // had, so the reported error is the only thing wrong with the output.
      const a = new Assembler(Cpu.P02);
      a.byte(0x102, 0x20304, 0x3040506);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(2, 4, 6),
        }],
        symbols: [], segments: []});
      expect(a.getMessages().map(m => m.message)).toEqual([
        'Not a byte: $102', 'Not a byte: $20304', 'Not a byte: $3040506',
      ]);
    });

    it('should take a negative that fits as a signed byte', function() {
      // ca65 sign-extends to 32 bits and calls this a range error; `.byte -1`
      // so plainly means $ff that js65 takes it without complaint.
      const a = new Assembler(Cpu.P02);
      a.byte(-1, -128, 0, 255);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: [],
          data: Uint8Array.of(0xff, 0x80, 0x00, 0xff),
        }],
        symbols: [], segments: []});
      expect(a.getMessages()).toEqual([]);
    });

    it('should report a negative too big to be a signed byte', function() {
      const a = new Assembler(Cpu.P02);
      a.byte(-129);
      expect(a.getMessages().map(m => m.message)).toEqual(['Not a byte: -129']);
    });

    it('should overflow when lobyte is taken before adding to a positive offset', function() {
      expect(assembleErrors([
        'OFFSET = -8',
        'LOBYTE_OFFSET = <OFFSET', // masks to $f8 (248), losing the sign
        'Y1 = 8 + LOBYTE_OFFSET',  // 8 + 248 = 256 = $100, not 0
        '.byte Y1',
        '',
      ].join('\n'))).toEqual(['Not a byte: $100']);

      // Taking the lobyte only at the very end, after the signed arithmetic,
      // gives the intended result instead.
      expect(assemble([
        'OFFSET = -8',
        'Y1 = 8 + OFFSET',
        '.byte <Y1',
        '',
      ].join('\n'))).toEqual([0]);
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

    it('should parse the ld65-compatible attributes', function() {
      const m = assembleModule(`
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

    it('should default :fill to zero', function() {
      const m = assembleModule(`.segment "ROM" :mem $8000 :size $10 :fill\n`);
      expect(m.segments).toEqual([{
        name: 'ROM', memory: 0x8000, size: 0x10, fill: 0,
        free: [[0x8000, 0x8010]],
      }]);
    });

    it('should ignore ld65 read-only attributes', function() {
      const m = assembleModule(`.segment "ROM" :mem $8000 :size $10 :ro\n`);
      expect(m.segments).toEqual([{name: 'ROM', memory: 0x8000, size: 0x10}]);
    });

    it('should reject a non-power-of-two alignment', function() {
      expect(() => assembleModule(`.segment "CODE" :align 3\n`))
          .toThrow(/align must be a power of two: 3/);
    });

    it('should reject an unknown segment attribute', function() {
      expect(() => assembleModule(`.segment "CODE" :overlay "ROM"\n`))
          .toThrow(/Unknown segment attr: overlay/);
    });

    it('should not carry .org into a segment that never had one',
       function() {
      const m = assembleModule(`
.segment "ZP" :mem $20 :size $10 :zp
.segment "RAM" :mem $200 :size $600 :bss
.org $400
foo: .byte 1
.segment "ZP"
bar: .byte 2
`);
      expect(m.chunks!.map(c => c.org)).toEqual([0x400, undefined]);
    });

    it('should size operands from the new segment after a segment change',
       function() {
      // `.org $400` in RAM must not make `bar` an absolute address in ZP.
      const m = assembleModule(`
.segment "ZP" :mem $20 :size $10 :zp
.segment "RAM" :mem $200 :size $600 :bss
.org $400
foo: .byte 1
.segment "ZP"
bar: .byte 2
.segment "RAM"
lda bar
`);
      // lda zp is 2 bytes (a5 xx), lda abs would be 3.
      expect(m.chunks![2].data.length).toEqual(2);
    });

    it('should resume a segment\'s own .org on coming back to it',
       function() {
      const m = assembleModule(`
.segment "A" :mem $8000 :size $1000
.org $8000
.byte 1, 2, 3
.segment "B" :mem $9000 :size $1000
.byte 4
.segment "A"
.byte 5
`);
      // "A" picks up at $8003, and "B" stays relocatable.
      expect(m.chunks!.map(c => [c.segments, c.org, [...c.data]])).toEqual([
        [['A'], 0x8000, [1, 2, 3]],
        [['B'], undefined, [4]],
        [['A'], 0x8003, [5]],
      ]);
    });

    it('should resume an .org that opened no chunk', function() {
      const m = assembleModule(`
.segment "A" :mem $8000 :size $1000
.org $8000
.segment "B" :mem $9000 :size $1000
.byte 4
.segment "A"
.byte 5
`);
      expect(m.chunks!.map(c => c.org)).toEqual([undefined, 0x8000]);
    });

    it('should not resume an .org that was ended with .reloc', function() {
      const m = assembleModule(`
.segment "A" :mem $8000 :size $1000
.org $8000
.byte 1
.reloc
.segment "B" :mem $9000 :size $1000
.byte 4
.segment "A"
.byte 5
`);
      expect(m.chunks!.map(c => c.org)).toEqual([0x8000, undefined, undefined]);
    });

    it('should reject .free in a segment that never had an .org', function() {
      expect(() => assembleModule(`
.segment "A" :mem $8000 :size $1000
.org $8000
.segment "B" :mem $9000 :size $1000
.free $100
`)).toThrow(/\.free in \.reloc mode/);
    });

    it('should allow setting a prefix', function() {
      const a = new Assembler(Cpu.P02);
      a.segmentPrefix('cr:');
      a.directive([cs('.segment'), str('02')]);
      a.instruction([ident('lsr')]);
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

  // `.segment "A" & "B"` declares the mirror `"A&B"` and uses it in one
  // statement. The chunk names that alias; the linker is what turns the name
  // into the member list (see `composite segments` in linker_test.ts).
  describe('mirror .segment lists', function() {
    it('should parse an &-separated segment list', function() {
      const m = assembleModule(`
.segment "A" & "B"
.byte 1
`);
      expect(m.chunks!.length).toBe(1);
      expect(m.chunks![0].segments).toEqual(['A&B']);
      expect(m.segments).toEqual([{name: 'A&B', mirror: ['A', 'B']}]);
    });

    it('should leave a comma list a pool, not a mirror', function() {
      const m = assembleModule(`
.segment "A", "B"
.byte 1
`);
      expect(m.chunks![0].segments).toEqual(['A', 'B']);
      expect(m.chunks![0].placement ?? 'any').toBe('any');
    });

    it('should carry a mirror list through .pushseg/.popseg', function() {
      const m = assembleModule(`
.segment "A" & "B"
.byte 1
.pushseg "C"
.byte 2
.popseg
.byte 3
.pushseg "A" & "C"
.byte 4
.popseg
`);
      expect(m.chunks!.map(c => [c.segments, [...c.data]])).toEqual([
        [['A&B'], [1, 3]],
        [['C'], [2]],
        [['A&C'], [4]],
      ]);
      // Only the two aliases are declarations; `"C"` is a bare name.
      expect(m.segments).toEqual([
        {name: 'A&B', mirror: ['A', 'B']},
        {name: 'A&C', mirror: ['A', 'C']},
      ]);
    });

    // A mirror and a pool over the same two segments are different places, so
    // `.org` in one must not pick up where the other left off.
    it('should keep .org PCs separate per list mode', function() {
      const m = assembleModule(`
.segment "A" & "B"
.org $8000
.byte 1
.segment "A", "B"
.org $8100
.byte 2
.segment "A" & "B"
.byte 3
.segment "A", "B"
.byte 4
`);
      expect(m.chunks!.map(c => [c.segments, c.org, [...c.data]])).toEqual([
        [['A&B'], 0x8000, [1]],
        [['A', 'B'], 0x8100, [2]],
        [['A&B'], 0x8001, [3]],
        [['A', 'B'], 0x8101, [4]],
      ]);
    });

    it('should reject mixing , and & separators', function() {
      expect(() => assembleModule(`.segment "A", "B" & "C"\n`)).toThrow();
      expect(() => assembleModule(`.segment "A" & "B", "C"\n`)).toThrow();
    });

    it('should reject an anonymous segment in an & list', function() {
      expect(() => assembleModule(`.segment $8000 :size $10 & "B"\n`)).toThrow();
      expect(() => assembleModule(`.segment "A" & $8000 :size $10\n`)).toThrow();
    });
  });

  // The assembler only records the declaration and the name each chunk used.
  // Turning the name into its members is the linker's job, since the two may
  // be in different modules - see `composite segments` in linker_test.ts.
  describe('composite .segment declarations', function() {
    // `.segment "A" & "B"` is defined as shorthand for a declaration of
    // `.segment "A&B" :mirror {"A", "B"}` followed by a use of that name, so
    // the two spellings have to keep producing the same module.
    it('should declare a mirror composite usable by name', function() {
      const m = assembleModule(`
.segment "A&B" :mirror {"A", "B"}
.segment "A&B"
.byte 1
`);
      expect(m.chunks!.length).toBe(1);
      expect(m.chunks![0].segments).toEqual(['A&B']);
      expect(m.segments).toEqual([{name: 'A&B', mirror: ['A', 'B']}]);
    });

    it('should make the & shorthand equivalent to its declaration', function() {
      const shorthand = assembleModule(`
.segment "A" & "B"
.byte 1, 2
`);
      const declared = assembleModule(`
.segment "A&B" :mirror {"A", "B"}
.segment "A&B"
.byte 1, 2
`);
      expect(declared.chunks).toEqual(shorthand.chunks);
      expect(declared.segments).toEqual(shorthand.segments);
    });

    // A use of the name is just a use of the name, whether or not the
    // declaration is in this module. Only the linker needs to tell them apart.
    it('should name the composite on the chunk, not its members', function() {
      const declared = assembleModule(`
.segment "COMMON" :mirror {"A", "B"}
.segment "COMMON"
.byte 1
`);
      const undeclared = assembleModule(`
.segment "COMMON"
.byte 1
`);
      expect(declared.chunks![0].segments).toEqual(['COMMON']);
      expect(declared.chunks![0].placement).toBeUndefined();
      expect(undeclared.chunks).toEqual(declared.chunks);
    });

    it('should allow an arbitrary name and keep the written member order',
       function() {
      // Unlike the & shorthand, which sorts members and derives the name from
      // them, a declaration names itself and preserves the order as written.
      const m = assembleModule(`
.segment "COMMON" :mirror {"B", "A"}
.segment "COMMON"
.byte 1
`);
      expect(m.segments).toEqual([{name: 'COMMON', mirror: ['B', 'A']}]);
    });

    it('should accept a comma-less member list', function() {
      const m = assembleModule(`
.segment "COMMON" :mirror {"A" "B"}
.segment "COMMON"
.byte 1
`);
      expect(m.segments).toEqual([{name: 'COMMON', mirror: ['A', 'B']}]);
    });

    it('should declare a pool composite', function() {
      const m = assembleModule(`
.segment "MUSIC" :pool {"A", "B"}
.segment "MUSIC"
.byte 1
`);
      expect(m.segments).toEqual([{name: 'MUSIC', pool: ['A', 'B']}]);
      expect(m.chunks![0].segments).toEqual(['MUSIC']);
    });

    it('should apply the segment prefix to members', function() {
      const m = assembleModule(`
.segmentprefix "p"
.segment "COMMON" :mirror {"A", "B"}
.segment "COMMON"
.byte 1
`);
      expect(m.segments).toEqual([{name: 'pCOMMON', mirror: ['pA', 'pB']}]);
    });

    // A single-member list is not a mirror; it would just be an alias, which
    // this feature deliberately does not provide.
    it('should reject a single-member composite', function() {
      expect(() => assembleModule(`.segment "X" :mirror {"A"}\n`))
          .toThrow(/at least two|two or more|single/i);
      expect(() => assembleModule(`.segment "X" :pool {"A"}\n`))
          .toThrow(/at least two|two or more|single/i);
    });

    it('should reject an empty member list', function() {
      expect(() => assembleModule(`.segment "X" :mirror {}\n`))
          .toThrow(/empty|at least two|two or more/i);
    });

    it('should reject duplicate members', function() {
      expect(() => assembleModule(`.segment "X" :mirror {"A", "A"}\n`))
          .toThrow(/duplicate/i);
    });

    it('should reject a non-string member', function() {
      expect(() => assembleModule(`.segment "X" :mirror {"A", 5}\n`))
          .toThrow(/string/i);
    });

    it('should require braces around the member list', function() {
      expect(() => assembleModule(`.segment "X" :mirror "A"\n`))
          .toThrow(/braced list|brace/i);
      expect(() => assembleModule(`.segment "X" :mirror "A", "B"\n`))
          .toThrow(/braced list|brace/i);
    });

    it('should reject both :mirror and :pool on one declaration', function() {
      expect(() => assembleModule(
                 `.segment "X" :mirror {"A", "B"} :pool {"A", "B"}\n`))
          .toThrow(/mirror|pool/i);
    });

    it('should reject geometry attributes on an composite', function() {
      for (const attr of [':size $100', ':mem $8000', ':off 0', ':load "A"']) {
        expect(() => assembleModule(
                   `.segment "X" :mirror {"A", "B"} ${attr}\n`))
            .toThrow(/Cannot use other segment attributes/i);
      }
    });
  });

  describe('anonymous .segment', function() {
    // Assembles under a caller-chosen module name, since that name seeds the
    // generated segment-name hash.
    function assembleNamed(body: string, name: string,
                                 generateDebugInfo = false): Module {
      const result = libAssemble(
          [{type: 'source', code: body, name} as AssemblyInput],
          {generateDebugInfo});
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      return result.modules[0];
    }

    // @anon@<file>:<line>:<hash>. The line is empty without debug info, which
    // is how `assembleModule` runs.
    const ANON = /^@anon@[^\0]+:\d*:[0-9a-f]{12}$/;

    it('should take the address positionally and require :size', function() {
      const m = assembleModule(`.segment $8000 :size $4000\n`);
      expect(m.segments!.length).toBe(1);
      const [seg] = m.segments!;
      expect(seg.name).toMatch(ANON);
      expect(seg.memory).toBe(0x8000);
      expect(seg.size).toBe(0x4000);
      // The linker hands out file offsets, so the module must not carry one.
      expect(seg.offset).toBeUndefined();
    });

    it('should carry the file and line in the name', function() {
      const m = assembleNamed(
          `\n\n.segment $8000 :size $10\n`, 'bank.s', true);
      expect(m.segments![0].name).toMatch(/^@anon@bank\.s:3:[0-9a-f]{12}$/);
    });

    it('should still carry the line without debug info', function() {
      const m = assembleNamed(`.segment $8000 :size $10\n`, 'bank.s');
      expect(m.segments![0].name).toMatch(/^@anon@bank\.s:1:[0-9a-f]{12}$/);
    });

    it('should distinguish two segments on different lines', function() {
      // The line is part of the hash, so identical declarations still differ.
      const m = assembleNamed(
          `.segment $8000 :size $10\n.segment $8000 :size $10\n`, 'bank.s', true);
      expect(m.segments![0].name).toMatch(/^@anon@bank\.s:1:/);
      expect(m.segments![1].name).toMatch(/^@anon@bank\.s:2:/);
    });

    it('should generate the same name for the same source twice', function() {
      const src = `.segment $8000 :size $4000\n.segment $c000 :size $4000\n`;
      const a = assembleModule(src);
      const b = assembleModule(src);
      expect(a.segments!.map(s => s.name)).toEqual(b.segments!.map(s => s.name));
    });

    it('should generate distinct names for two segments in one module',
       function() {
      const m = assembleModule(
          `.segment $8000 :size $4000\n.segment $8000 :size $4000\n`);
      // Same address and size: only the sequence number distinguishes them.
      expect(m.segments!.length).toBe(2);
      expect(m.segments![0].name).not.toBe(m.segments![1].name);
    });

    it('should generate distinct names for the same source at two paths',
       function() {
      const src = `.segment $8000 :size $4000\n`;
      const a = assembleNamed(src, 'a.s');
      const b = assembleNamed(src, 'b.s');
      expect(a.segments![0].name).not.toBe(b.segments![0].name);
    });

    it('should synthesize a free range for :fill', function() {
      const m = assembleModule(`.segment $8000 :size $4000 :fill $ff\n`);
      expect(m.segments![0].fill).toBe(0xff);
      expect(m.segments![0].free).toEqual([[0x8000, 0xc000]]);
    });

    it('should evaluate the address as an expression', function() {
      const m = assembleModule(`.segment $8000+16 :size $10\n`);
      expect(m.segments![0].memory).toBe(0x8010);
    });

    it('should accept :bank as metadata', function() {
      const m = assembleModule(`.segment $8000 :size $10 :bank 3\n`);
      expect(m.segments![0].bank).toBe(3);
    });

    it('should ignore ld65 read-only attributes', function() {
      const m = assembleModule(`.segment $8000 :size $10 :ro\n`);
      expect(m.segments![0]).toEqual(
          {name: m.segments![0].name, memory: 0x8000, size: 0x10});
    });

    it('should bind following data to the generated segment', function() {
      const m = assembleModule(`.segment $8000 :size $10\n.byte 1\n`);
      expect(m.chunks![0].segments).toEqual([m.segments![0].name]);
    });

    it('should imply .org at the declared address', function() {
      // The address is part of the segment, so no explicit `.org` is needed.
      const m = assembleModule(`.segment $8000 :size $10\n.byte 1\n`);
      expect(m.chunks![0].org).toBe(0x8000);
    });

    it('should re-imply .org for each anonymous segment', function() {
      const m = assembleModule(
          `.segment $8000 :size $10\n.byte 1\n` +
          `.segment $9000 :size $10\n.byte 2\n`);
      expect(m.chunks!.map(c => c.org)).toEqual([0x8000, 0x9000]);
    });

    it('should resolve labels against the implied .org', function() {
      const m = assembleModule(
          `.segment $8000 :size $10\nStart:\n  .byte 1\n  .word Start\n`);
      expect(m.chunks![0].org).toBe(0x8000);
      expect([...m.chunks![0].data]).toEqual([1, 0x00, 0x80]);
    });

    it('should let an explicit .org move within the segment', function() {
      const m = assembleModule(
          `.segment $8000 :size $100\n.byte 1\n.org $8040\n.byte 2\n`);
      expect(m.chunks!.map(c => c.org)).toEqual([0x8000, 0x8040]);
    });

    it('should let .reloc drop the implied .org', function() {
      const m = assembleModule(
          `.segment $8000 :size $100\n.reloc\n.byte 1\n`);
      expect(m.chunks![0].org).toBeUndefined();
    });

    it('should let .free carve a range out of the segment', function() {
      // `.free` needs a PC, which the segment's implied `.org` supplies.
      const m = assembleModule(
          `.segment $8000 :size $100\n.byte 1\n.free $20\n`);
      expect(m.segments![0].free).toEqual([[0x8001, 0x8021]]);
    });

    it('should reject a missing :size', function() {
      expect(() => assembleModule(`.segment $8000\n`))
          .toThrow(/An anonymous \.segment requires :size/);
      expect(() => assembleModule(`.segment $8000 :fill $ff\n`))
          .toThrow(/An anonymous \.segment requires :size/);
    });

    it('should reject a comma-separated list', function() {
      expect(() => assembleModule(
              `.segment $8000 :size $10, $9000 :size $10\n`))
          .toThrow(
              /anonymous \.segment may not appear in a comma-separated list/);
    });

    for (const attr of ['off $0', 'mem $8000', 'out "x.bin"', 'load "A"',
                        'run "A"', 'alignload $10',
                        'optional', 'dedupe', 'default', 'align $10',
                        'define']) {
      const key = attr.split(' ')[0];
      it(`should reject :${key}`, function() {
        expect(() => assembleModule(`.segment $8000 :size $10 :${attr}\n`))
            .toThrow(new RegExp(
                `Segment attr ${key} is not allowed on an anonymous \\.segment`));
      });
    }

    it('should declare a ram area with :bss', function() {
      const m = assembleModule(`.segment $0200 :size $600 :bss\n.res 2\n`);
      const [seg] = m.segments!;
      expect(seg.name).toMatch(ANON);
      expect(seg.memory).toBe(0x200);
      expect(seg.size).toBe(0x600);
      expect(seg.bss).toBe(true);
      // Positional address is an implicit `.org`, the same as for a rom bank.
      expect(m.chunks![0].org).toBe(0x200);
    });

    it('should set the addressing size with :zp', function() {
      const m = assembleModule(`.segment $0000 :size $100 :zp\n.res 1\n`);
      const [seg] = m.segments!;
      expect(seg.name).toMatch(ANON);
      expect(seg.bss).toBe(true);
      expect(seg.addressing).toBe(1);
    });

    it('should make two ram areas at one address, like two rom banks',
       function() {
      // Banked ram: each declaration is its own area, so the addresses overlap
      // rather than packing one after the other.
      const m = assembleModule(
          `.segment $6000 :size $2000 :bss\n.res 1\n` +
          `.segment $6000 :size $2000 :bss\n.res 1\n`);
      expect(m.segments!.length).toBe(2);
      expect(m.segments![0].name).not.toBe(m.segments![1].name);
      expect(m.chunks!.map(c => c.org)).toEqual([0x6000, 0x6000]);
    });

    it('should reject :fill on a ram area', function() {
      expect(() => assembleModule(`.segment $0200 :size $10 :bss :fill $00\n`))
          .toThrow(/fill is not allowed on an anonymous ram segment/);
    });

    it('should reject an unknown segment attribute', function() {
      expect(() => assembleModule(`.segment $8000 :size $10 :overlay "A"\n`))
          .toThrow(/Unknown segment attr: overlay/);
    });

    it('should reject an anonymous segment after a named one', function() {
      expect(() => assembleModule(
              `.segment "A" :size $10\n.segment $8000 :size $10\n`))
          .toThrow(
              /Cannot use an anonymous \.segment after a named \.segment/);
    });

    it('should reject a named segment after an anonymous one', function() {
      expect(() => assembleModule(
              `.segment $8000 :size $10\n.segment "A" :size $10\n`))
          .toThrow(
              /Cannot use a named \.segment after an anonymous \.segment/);
    });

    it('should reject an anonymous segment after .code', function() {
      // `.code` bypasses parseSegmentList entirely, so this pins the latch
      // living in segment() rather than in the parser.
      expect(() => assembleModule(`.code\n.segment $8000 :size $10\n`))
          .toThrow(
              /Cannot use an anonymous \.segment after a named \.segment/);
    });

    it('should reject .pushseg in anonymous mode', function() {
      expect(() => assembleModule(`.segment $8000 :size $10\n.pushseg\n`))
          .toThrow(/\.pushseg cannot be used with anonymous segments/);
    });

    it('should reject .popseg in anonymous mode', function() {
      expect(() => assembleModule(
              `.segment $8000 :size $10\n.popseg\n`))
          .toThrow(/\.popseg cannot be used with anonymous segments/);
    });

    it('should reject a user segment name starting with @', function() {
      expect(() => assembleModule(`.segment "@foo"\n`))
          .toThrow(/Segment name may not start with '@'/);
    });

    it('should reject an @ segment prefix', function() {
      // The check is on the composed name, so a prefix can't smuggle one in.
      expect(() => assembleModule(`.segmentprefix "@"\n.segment "x"\n`))
          .toThrow(/Segment name may not start with '@'.*@x/);
    });
  });

  describe('predeclared ZEROPAGE segment', function() {
    function chunkIn(m: Module, segment: string) {
      const chunk = (m.chunks ?? []).find(c => c.segments.includes(segment));
      if (!chunk) throw new Error(`No chunk in segment ${segment}`);
      return chunk;
    }

    it('should give `.segment "ZEROPAGE"` zeropage address size', function() {
      const m = assembleModule(`.segment "ZEROPAGE"\nFoo: .res 1\n`);
      expect(m.segments).toEqual([{name: 'ZEROPAGE', addressing: 1}]);
    });

    it('should mark a chunk in `.segment "ZEROPAGE"` as zeropage', function() {
      const m = assembleModule(`.segment "ZEROPAGE"\nFoo: .res 1\n`);
      expect(chunkIn(m, 'ZEROPAGE').zeropage).toBe(true);
    });

    it('should keep zeropage address size when the segment also carries ld65 attributes',
       function() {
         // The memory placement usually comes from the linker config, but a source
         // file is free to spell it out. Do not clear the address size in this case.
         const m = assembleModule(`.segment "ZEROPAGE" :mem $10 :size $80\nFoo: .res 1\n`);
         expect(m.segments).toEqual([
           {name: 'ZEROPAGE', addressing: 1, memory: 0x10, size: 0x80}]);
         expect(chunkIn(m, 'ZEROPAGE').zeropage).toBe(true);
       });

    it('should report 1 from `.addrsize` for a label in `.segment "ZEROPAGE"`',
       function() {
         const m = assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  .byte .addrsize(Foo)
`);
         const code = chunkIn(m, 'CODE');
         expect(Array.from(code.data)).toEqual([1]);
       });

    it('should leave other named segments absolute', function() {
      // Only ZEROPAGE is zeropage-addressed. The rest of ca65's predeclared
      // segments must stay absolute.
      const m = assembleModule(`
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
       function() {
         const m = assembleModule(`
.zeropage
Foo: .res 1
.segment "CODE"
  sta Foo
  lda Foo
`);
         expect(codeOf(m)).toEqual([0x85, 0xff, 0xa5, 0xff]);
       });

    it('should size a label in `.segment "ZEROPAGE"` as zeropage', function() {
      const m = assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  sta Foo
  lda Foo
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0xa5, 0xff]);
    });

    it('should size a label reached through a `.define`d segment name as zeropage',
       function() {
         const m = assembleModule(`
.define ZP_SEGMENT "ZEROPAGE"
.segment ZP_SEGMENT
Foo: .res 1
.segment "CODE"
  sta Foo
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    it('should size indexed operands on a zeropage label as zeropage', function() {
      const m = assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  lda Foo,x
  ldx Foo,y
`);
      expect(codeOf(m)).toEqual([0xb5, 0xff, 0xb6, 0xff]);
    });

    it('should still size a forward reference as absolute', function() {
      // ca65 does the same here -- it can't know the address size yet, so it
      // picks absolute and warns. This guards against "fixing" it too eagerly.
      const m = assembleModule(`
.segment "CODE"
  sta Foo
.segment "ZEROPAGE"
Foo: .res 1
`);
      expect(codeOf(m)).toEqual([0x8d, 0xff, 0xff]);
    });

    it('should still size a label in a non-zeropage segment as absolute',
       function() {
         const m = assembleModule(`
.segment "BSS"
Foo: .res 1
.segment "CODE"
  sta Foo
`);
         expect(codeOf(m)).toEqual([0x8d, 0xff, 0xff]);
       });

    it('should size an outer zeropage label referenced from a `.proc` as zeropage',
       function() {
         // The reference resolves in the proc's scope, which doesn't have the
         // symbol, so the address size has to come from walking out to where it
         // is defined.
         const m = assembleModule(`
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
       function() {
         const m = assembleModule(`
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

    it('should keep zeropage address size across an offset', function() {
      // ca65 propagates address size through +/-, so `Ptr+1` is still zeropage.
      const m = assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
  sta Ptr+1
  sta Ptr+0
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0x85, 0xff]);
    });

    it('should keep zeropage address size across an offset from a `.proc`',
       function() {
         const m = assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
.proc p
  sta Ptr+1
.endproc
`);
         expect(codeOf(m)).toEqual([0x85, 0xff]);
       });

    it('should keep zeropage address size through an alias', function() {
      const m = assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
Alias := Ptr
  sta Alias
  sta Alias+1
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0x85, 0xff]);
    });

    it('should size an `.importzp` symbol offset as zeropage', function() {
      const m = assembleModule(`
.importzp Foo
.segment "CODE"
  sta Foo
  sta Foo+1
`);
      expect(codeOf(m)).toEqual([0x85, 0xff, 0x85, 0xff]);
    });

    it('should stay absolute when an absolute label is offset by a zeropage one',
       function() {
         // Nonsense arithmetic, but it must not silently become zeropage.
         const m = assembleModule(`
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
       function() {
         // `:=` is handled as the preprocessor reads the line, so the alias is
         // built while the scope is open and `Zp` is only reachable through a
         // forward reference. That reference has to carry the address size, or
         // everything downstream of the alias goes absolute.
         const m = assembleModule(`
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
       function() {
         // With an `.org` the label is no longer chunk-relative, so `Ptr+1`
         // folds to a plain number during `:=` and has to keep the address size
         // through the fold rather than riding along on the relative meta.
         const m = assembleModule(`
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
       function() {
         // Both halves at once: the reference has to find the outer definition
         // to get an address size, and the `+` has to carry it up.
         const m = assembleModule(`
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
       function() {
         const m = assembleModule(`
BLANK_TILE = $af
.segment "CODE"
.proc p
  lda BLANK_TILE
.endproc
`);
         expect(codeOf(m)).toEqual([0xa5, 0xaf]);
       });

    it('should size a constant from an enclosing scope through nested scopes',
       function() {
         const m = assembleModule(`
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

    it('should fold an offset from an enclosing scope\'s constant', function() {
      // Only worth anything if the value comes in rather than a reference: the
      // `+` has to fold to a number before the operand can be sized from it.
      const m = assembleModule(`
BLANK_TILE = $af
.segment "CODE"
.proc p
  lda BLANK_TILE+1
.endproc
`);
      expect(codeOf(m)).toEqual([0xa5, 0xb0]);
    });

    it('should go absolute when an offset carries the value out of the zeropage',
       function() {
         // Both halves fit in a byte and the sum does not, so the address size
         // cannot come from the operands alone.
         const m = assembleModule(`
.segment "CODE"
  lda $ff+$ff
  lda $80+$80
`);
         expect(codeOf(m)).toEqual([0xad, 0xfe, 0x01, 0xad, 0x00, 0x01]);
       });

    it('should keep an offset absolute when an operand needs two bytes',
       function() {
         const m = assembleModule(`
BIG = $1234
.segment "CODE"
.proc p
  lda BIG-$1200
.endproc
`);
         expect(codeOf(m)).toEqual([0xad, 0x34, 0x00]);
       });

    it('should size an explicitly scoped constant by its value', function() {
      const m = assembleModule(`
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
       function() {
         const m = assembleModule(`
BIG = $1234
.segment "CODE"
.proc p
  lda BIG
.endproc
`);
         expect(codeOf(m)).toEqual([0xad, 0x34, 0x12]);
       });

    it('should still size a constant defined after the reference as absolute',
       function() {
         // Same rule as a forward-referenced label: nothing knows the value yet,
         // so the operand has to assume the worst. Guards against widening the
         // lookup into a second pass.
         const m = assembleModule(`
.segment "CODE"
.proc p
  lda BLANK_TILE
.endproc
BLANK_TILE = $af
`);
         expect(codeOf(m)).toEqual([0xad, 0xff, 0xff]);
       });

    it('should bind to the enclosing constant when the local one comes later',
       function() {
         // The first reference has only the outer `$af` to go on; the second is
         // after the local definition and takes that instead.
         const m = assembleModule(`
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

    // ca65's `z:` / `a:` / `f:` prefixes override the address size the operand
    // would otherwise be given. They are the escape hatch for the cases above
    // where js65 has to guess, most importantly a forward reference.
    describe('address size overrides', function() {
      it('should force zeropage on a forward reference with `z:`', function() {
        const m = assembleModule(`
.segment "CODE"
  sta z:Foo
.segment "ZEROPAGE"
Foo: .res 1
`);
        expect(codeOf(m)).toEqual([0x85, 0xff]);
      });

      it('should force absolute on a zeropage label with `a:`', function() {
        const m = assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  sta a:Foo
`);
        expect(codeOf(m)).toEqual([0x8d, 0xff, 0xff]);
      });

      it('should force the address size of a known value', function() {
        const m = assembleModule(`
.segment "CODE"
  lda a:$12
  lda z:$12
`);
        expect(codeOf(m)).toEqual([0xad, 0x12, 0x00, 0xa5, 0x12]);
      });

      it('should carry the override through an offset', function() {
        const m = assembleModule(`
.segment "CODE"
  lda a:$12+1
  lda z:$12+1
`);
        expect(codeOf(m)).toEqual([0xad, 0x13, 0x00, 0xa5, 0x13]);
      });

      it('should force the address size of an indexed operand', function() {
        const m = assembleModule(`
.segment "ZEROPAGE"
Foo: .res 1
.segment "CODE"
  lda a:Foo,x
  ldx a:Foo,y
  ldx z:$12,y
`);
        expect(codeOf(m)).toEqual([0xbd, 0xff, 0xff, 0xbe, 0xff, 0xff, 0xb6, 0x12]);
      });

      it('should accept an override inside an indirect operand', function() {
        // Every 6502 indirect mode has a fixed operand size, so the override
        // can only agree with it, but ca65 sources still spell it out.
        const m = assembleModule(`
.segment "ZEROPAGE"
Ptr: .res 2
.segment "CODE"
  lda (z:Ptr),y
  lda (z:Ptr,x)
`);
        expect(codeOf(m)).toEqual([0xb1, 0xff, 0xa1, 0xff]);
      });

      it('should reject an override that the mnemonic has no mode for',
         function() {
           expect(assembleErrors('  lda z:$12,y'))
               .toEqual(['Bad address mode zpy for lda']);
         });

      it('should reject an override on an immediate', function() {
        expect(assembleErrors('  lda #a:$12'))
            .toEqual(['Cannot force absolute addressing on imm arguments']);
      });

      it('should reject a value too big for a forced zeropage', function() {
        expect(assembleErrors('  lda z:$1234')).toEqual(['Not a byte: $1234']);
      });

      it('should reject `f:`, which needs a 65816', function() {
        expect(assembleErrors('  lda f:$12'))
            .toEqual(['Far addressing (`f:`) is 65816-only']);
      });
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

    it('should pad the segment it appeared in', function() {
      const m = assembleModule(`
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

    it('should not leak the alignment onto the next segment', function() {
      const m = assembleModule(`
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

    it('should use the fill value it was given', function() {
      const m = assembleModule(`
.segment "BBB"
  .byte 4
  .align 8, $ff
.segment "AAA"
  .byte 6
`);
      const [bbb] = chunksIn(m, 'BBB');
      expect(Array.from(bbb.data)).toEqual([4, ...new Array(7).fill(0xff)]);
    });

    it('should pad a segment left aligned at the end of the source', function() {
      const m = assembleModule(`
.segment "BBB"
  .byte 4
  .align 8
`);
      const [bbb] = chunksIn(m, 'BBB');
      expect(Array.from(bbb.data)).toEqual([4, ...new Array(7).fill(0)]);
      expect(bbb.align).toBe(8);
    });

    it('should keep deferring the alignment when data follows it', function() {
      // The normal case is unchanged: the alignment belongs to the new chunk,
      // and the linker gets to place it wherever it fits.
      const m = assembleModule(`
.segment "BBB"
  .byte 4
  .align 64
  .byte 5
`);
      const chunks = chunksIn(m, 'BBB');
      expect(chunks.map(c => Array.from(c.data))).toEqual([[4], [5]]);
      expect(chunks.map(c => c.align)).toEqual([undefined, 64]);
    });

    it('should take the widest of several trailing alignments', function() {
      const m = assembleModule(`
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

    it('should pad the pushed segment when `.popseg` ends it', function() {
      const m = assembleModule(`
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

    it('should keep the current segment when pushed with no arguments',
       function() {
      const a = new Assembler(Cpu.P02);
      a.segment('a', 'b');
      a.byte(4);
      a.pushSeg();
      a.byte(5);
      a.popSeg();
      a.byte(6);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['a', 'b'],
          data: Uint8Array.of(4, 5, 6),
        }],
        symbols: [], segments: []});
    });

    it('should restore a pending .org with no chunk open yet', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('a');
      a.org(0x8000);
      a.pushSeg('b');
      a.byte(5);
      a.popSeg();
      a.byte(6);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['b'],
          data: Uint8Array.of(5),
        }, {
          overwrite: 'allow',
          segments: ['a'],
          org: 0x8000,
          data: Uint8Array.of(6),
        }],
        symbols: [], segments: []});
    });

    it('should leave the popped segment\'s .org for it to resume', function() {
      const a = new Assembler(Cpu.P02);
      a.segment('a');
      a.pushSeg('b');
      a.org(0x9000);
      a.byte(1);
      a.popSeg();
      a.byte(2);
      a.segment('b');
      a.byte(3);
      expect(strip(a.module())).toEqual({
        chunks: [{
          overwrite: 'allow',
          segments: ['b'],
          org: 0x9000,
          data: Uint8Array.of(1),
        }, {
          overwrite: 'allow',
          segments: ['a'],
          data: Uint8Array.of(2),
        }, {
          overwrite: 'allow',
          segments: ['b'],
          org: 0x9001,
          data: Uint8Array.of(3),
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

  describe('.feature', function() {
    // A directly-driven assembler has no tokenizer to configure; the names are
    // still validated, so most cases don't need one.
    function feature(...tokens: Token[]) {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.feature'), ...tokens]);
      return a;
    }

    // Names js65 doesn't implement yet. Delete a line here when one lands - the
    // "everything else is accepted" test below then covers it automatically.
    const UNSUPPORTED = ['dollar_in_identifiers', 'dollar_is_pc'];

    it('should accept every ca65 feature name it implements', function() {
      for (const name of FEATURE_NAMES) {
        if (UNSUPPORTED.includes(name)) continue;
        expect(() => feature(ident(name))).not.toThrow();
      }
    });

    it('should reject an unknown feature name', function() {
      expect(() => feature(ident('nonsense')))
          .toThrow(/Unknown feature: nonsense/);
    });

    it('should keep FEATURE_NAMES in sync with applyFeature', function() {
      // The list is hand-maintained next to the switch, so pin that no name in
      // it falls through to the unknown case.
      for (const name of FEATURE_NAMES) {
        expect(() => feature(ident(name))).not.toThrow(/Unknown feature/);
      }
    });

    it('should reject a feature it does not implement', function() {
      for (const name of UNSUPPORTED) {
        expect(() => feature(ident(name)))
            .toThrow(new RegExp(`Unsupported feature: ${name}`));
      }
    });

    it('should require at least one name', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.directive([cs('.feature')]))
          .toThrow(/Expected feature name/);
    });

    it('should set the option a feature maps to', function() {
      expect(feature(ident('bracket_as_indirect')).opts.allowBrackets).toBe(true);
      expect(feature(ident('pc_assignment')).opts.pcAssignment).toBe(true);
      expect(feature(ident('labels_without_colons')).opts.labelsWithoutColons)
          .toBe(true);
      expect(feature(ident('force_range')).opts.forceRange).toBe(true);
    });

    it('should be case insensitive, like ca65', function() {
      expect(feature(ident('Bracket_As_Indirect')).opts.allowBrackets).toBe(true);
    });

    it('should accept a comma separated list', function() {
      const a = feature(ident('pc_assignment'), COMMA, ident('force_range'),
                        COMMA, ident('string_escapes'));
      expect(a.opts.pcAssignment).toBe(true);
      expect(a.opts.forceRange).toBe(true);
    });

    it('should accept the `name on` and `name off` forms', function() {
      expect(feature(ident('pc_assignment'), ident('on')).opts.pcAssignment)
          .toBe(true);
      expect(feature(ident('pc_assignment'), ident('off')).opts.pcAssignment)
          .toBe(false);
      expect(feature(ident('pc_assignment'), op('+')).opts.pcAssignment)
          .toBe(true);
      expect(feature(ident('pc_assignment'), op('-')).opts.pcAssignment)
          .toBe(false);
    });

    it('should accept per-name states in a list', function() {
      const a = feature(ident('pc_assignment'), ident('off'), COMMA,
                        ident('force_range'), ident('on'));
      expect(a.opts.pcAssignment).toBe(false);
      expect(a.opts.forceRange).toBe(true);
    });

    it('should reject a state that is not on/off/+/-', function() {
      expect(() => feature(ident('pc_assignment'), ident('maybe')))
          .toThrow(/Expected on, off, \+ or -/);
      expect(() => feature(ident('pc_assignment'), num(1)))
          .toThrow(/Expected on, off, \+ or -/);
    });

    it('should reject a name that is not an identifier', function() {
      expect(() => feature(str('pc_assignment')))
          .toThrow(/Expected identifier/);
    });

    it('should write tokenizer features through to the tokenizer options',
       function() {
      // These land on the tokenizer's options object rather than the
      // assembler's, which is how a `.feature` mid-file reaches files that
      // haven't been tokenized yet.
      const tokenizerOptions: TokenizerOptions = {};
      const a = new Assembler(Cpu.P02, {tokenizerOptions});
      a.directive([cs('.feature'), ident('c_comments')]);
      expect(tokenizerOptions.cComments).toBe(true);
      a.directive([cs('.feature'), ident('underline_in_numbers')]);
      expect(tokenizerOptions.numberSeparators).toBe(true);
      a.directive([cs('.feature'), ident('line_continuations'), ident('off')]);
      expect(tokenizerOptions.lineContinuations).toBe(false);
    });

    // js65 behaves these ways unconditionally, so there is no option to set.
    // If one of these ever becomes a real toggle, it moves out of this list.
    const UNCONDITIONAL = ['at_in_identifiers', 'addrsize', 'string_escapes',
                           'loose_char_term', 'loose_string_term',
                           'missing_char_term', 'org_per_seg'];

    it('should leave the options alone for a feature already always on',
       function() {
      for (const name of [...UNCONDITIONAL, 'long_jsr_jmp_rts']) {
        const tokenizerOptions: TokenizerOptions = {};
        const a = new Assembler(Cpu.P02, {tokenizerOptions});
        a.directive([cs('.feature'), ident(name)]);
        expect(tokenizerOptions).toEqual({});
        expect(a.opts.allowBrackets).toBeUndefined();
        expect(a.opts.pcAssignment).toBeUndefined();
        expect(a.opts.labelsWithoutColons).toBeUndefined();
        expect(a.opts.forceRange).toBeUndefined();
      }
    });

    it('should warn, not fail, for a feature already always on', function() {
      // The source asked for something it already has, so assembly continues -
      // but silently ignoring the request would hide that `.feature ... off`
      // didn't take, so each one is reported once as a warning.
      for (const name of UNCONDITIONAL) {
        const a = feature(ident(name));
        expect(a.hasErrors()).toBe(false);
        expect(a.getMessages().map(m => m.level)).toEqual(['warning']);
        expect(a.getMessages()[0].message)
            .toMatch(new RegExp(`Cannot change feature ${name} \\(.+\\)`));
      }
    });

    it('should warn when a feature already always on is turned off',
       function() {
      // The `off` case is the one that actually changes behavior from what the
      // source asked for, so it has to warn too rather than pass silently.
      const a = feature(ident('string_escapes'), ident('off'));
      expect(a.hasErrors()).toBe(false);
      expect(a.getMessages().map(m => m.level)).toEqual(['warning']);
      expect(a.getMessages()[0].message)
          .toMatch(/Cannot change feature string_escapes/);
    });

    it('should warn per name and keep going through a list', function() {
      // A warning mid-list must not swallow the names after it.
      const a = feature(ident('addrsize'), COMMA, ident('org_per_seg'), COMMA,
                        ident('pc_assignment'));
      expect(a.getMessages().map(m => m.message)).toEqual([
        expect.stringMatching(/Cannot change feature addrsize/),
        expect.stringMatching(/Cannot change feature org_per_seg/),
      ]);
      expect(a.opts.pcAssignment).toBe(true);
    });

    it('should not warn for a 65816-only feature', function() {
      // js65 assembles 6502 only, so this one is simply irrelevant rather than
      // a request js65 is declining - nothing to tell the user about.
      expect(feature(ident('long_jsr_jmp_rts')).getMessages()).toEqual([]);
    });

    it('should not warn for a feature it really applies', function() {
      const tokenizerOptions: TokenizerOptions = {};
      const a = new Assembler(Cpu.P02, {tokenizerOptions});
      a.directive([cs('.feature'), ident('bracket_as_indirect')]);
      a.directive([cs('.feature'), ident('c_comments')]);
      expect(a.getMessages()).toEqual([]);
    });

    it('should parse through the full pipeline', function() {
      // `.feature` used to be silently swallowed, so this pins that a real
      // source file reaches the new handler.
      expect(assemble('.feature bracket_as_indirect\nlda #$03\n'))
          .toEqual([0xa9, 0x03]);
      expect(assembleErrors('.feature nonsense\n'))
          .toEqual([expect.stringMatching(/Unknown feature: nonsense/)]);
    });

    it('should carry the warning through the full pipeline', function() {
      // The warning has to survive out to the caller's message list, and must
      // not turn a working source into a failed build.
      expect(assemble('.feature string_escapes\nlda #$03\n'))
          .toEqual([0xa9, 0x03]);
      expect(assembleWarnings('.feature string_escapes\nlda #$03\n'))
          .toEqual([expect.stringMatching(/Cannot change feature string_escapes/)]);
    });

    it('should locate the warning at the line that caused it', function() {
      // A file-level warning with no source location is hard to act on, so this
      // must hold without `generateDebugInfo` - locations are gathered for
      // diagnostics regardless of whether they get written out.
      const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
lda #$03
.feature org_per_seg
`;
      const result = compile(
          [{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
      expect(result.success).toBe(true);
      const warnings = result.messages.filter(m => m.level === 'warning');
      expect(warnings.length).toBe(1);
      expect(warnings[0].source?.file).toBe('test.s');
      expect(warnings[0].source?.line).toBe(4);
    });

    // `options.features` is what `--feature` and the JSON transports fill in.
    // It resolves through the same table as the directive, so the two agree.
    describe('from options.features', function() {
      function build(body: string, features: string[]) {
        const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
${body}`;
        return compile([{type: 'source', code, name: 'test.s'} as AssemblyInput],
                       {features});
      }

      it('should apply an assembler feature before any source is read',
         function() {
        const result = build('lda [$10],y\n', ['bracket_as_indirect']);
        expect(result.success).toBe(true);
        expect(Array.from(result.outputs[0].data)).toEqual([0xb1, 0x10]);
      });

      it('should apply a tokenizer feature before any source is read',
         function() {
        const result = build('lda #1_0\n', ['underline_in_numbers']);
        expect(result.success).toBe(true);
        expect(Array.from(result.outputs[0].data)).toEqual([0xa9, 10]);
      });

      it('should fail on an unknown name, as the directive does',
         function() {
        const result = build('lda #$03\n', ['nonsense']);
        expect(result.success).toBe(false);
        expect(result.messages.map(m => m.message))
            .toEqual([expect.stringMatching(/Unknown feature: nonsense/)]);
      });

      it('should fail on a name js65 cannot support', function() {
        const result = build('lda #$03\n', ['dollar_is_pc']);
        expect(result.success).toBe(false);
        expect(result.messages.map(m => m.message))
            .toEqual([expect.stringMatching(/Unsupported feature: dollar_is_pc/)]);
      });

      it('should report every bad name, not just the first', function() {
        const result = build('lda #$03\n', ['nonsense', 'dollar_is_pc']);
        expect(result.messages.map(m => m.message)).toEqual([
          expect.stringMatching(/Unknown feature: nonsense/),
          expect.stringMatching(/Unsupported feature: dollar_is_pc/),
        ]);
      });

      it('should warn once for a feature js65 always applies', function() {
        const result = build('lda #$03\n', ['string_escapes']);
        expect(result.success).toBe(true);
        expect(result.messages.map(m => m.level)).toEqual(['warning']);
        expect(result.messages[0].message)
            .toMatch(/Cannot change feature string_escapes/);
      });

      it('should let a later .feature turn an option back off', function() {
        // The flag is a starting state, not a lock: the source still owns the
        // option from the point `.feature` appears.
        const result = build('.feature bracket_as_indirect off\nlda [$10],y\n',
                                   ['bracket_as_indirect']);
        expect(result.success).toBe(false);
      });
    });

    // Each of these pairs a source that fails without the feature with the same
    // source assembling with it, which is what tells a wired-up flag apart from
    // one that only parses.
    describe('c_comments', function() {
      it('should not skip a block comment without the feature',
         function() {
        // `/*` is a division followed by the PC, which can't start a line.
        expect(assembleErrors('/* nope */\nlda #$03\n'))
            .toEqual([expect.stringMatching(/Unexpected/)]);
      });

      it('should skip a comment inside a line', function() {
        expect(assemble('.feature c_comments\nlda /* mid */ #$03\n'))
            .toEqual([0xa9, 0x03]);
      });

      it('should skip a comment that spans lines', function() {
        // Like whitespace, a comment that runs over a newline joins the lines,
        // which is what ca65 does.
        expect(assemble(
            '.feature c_comments\nlda /* one\ntwo\nthree */ #$03\n'))
            .toEqual([0xa9, 0x03]);
      });

      it('should not nest', function() {
        // ca65's block comments end at the first `*/`, so the trailing `*/`
        // here is left over and is a syntax error rather than a comment.
        expect(assembleErrors(
            '.feature c_comments\n/* outer /* inner */ */\nlda #$03\n'))
            .not.toEqual([]);
      });

      it('should report an unterminated comment', function() {
        expect(assembleErrors('.feature c_comments\nlda #$03\n/* forever\n'))
            .toEqual([expect.stringMatching(/Unterminated comment, expected \*\//)]);
      });

      it('should keep counting lines through a comment', function() {
        // A multi-line token is the one thing that can throw off the line
        // counter, and every later diagnostic in the file depends on it.
        const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.feature c_comments
/* one
   two
   three */
.feature org_per_seg
`;
        const result = compile(
            [{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
        expect(result.success).toBe(true);
        const warnings = result.messages.filter(m => m.level === 'warning');
        expect(warnings.length).toBe(1);
        expect(warnings[0].source?.line).toBe(7);
      });
    });

    describe('pc_assignment', function() {
      const preamble = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
`;

      it('should reject `*=` without the feature', function() {
        expect(assembleErrors('*= $8100\n'))
            .toEqual([expect.stringMatching(/requires the pc_assignment feature/)]);
      });

      it('should move the pc like .org', function() {
        const m = assembleModule(`${preamble}.feature pc_assignment
lda #$01
* = $8100
lda #$02
`);
        expect(m.chunks!.map(c => c.org)).toEqual([0x8000, 0x8100]);
      });

      it('should accept it with no space before the `=`', function() {
        const m = assembleModule(`${preamble}.feature pc_assignment
lda #$01
*=$8100
lda #$02
`);
        expect(m.chunks!.map(c => c.org)).toEqual([0x8000, 0x8100]);
      });

      it('should still read `*` as the pc in an expression', function() {
        // Only assignment was missing; reading the pc never needed the feature.
        expect(assemble('.word *\n')).toEqual([0x00, 0x80]);
      });
    });

    describe('labels_without_colons', function() {
      it('should reject a bare leading identifier without the feature',
         function() {
        expect(assembleErrors('foo lda #$01\n')).not.toEqual([]);
      });

      it('should define a label', function() {
        expect(assemble(
            '.feature labels_without_colons\nfoo lda #$01\n  jmp foo\n'))
            .toEqual([0xa9, 0x01, 0x4c, 0x00, 0x80]);
      });

      it('should define a label on a line of its own', function() {
        expect(assemble(
            '.feature labels_without_colons\nfoo\n  lda #$01\n  jmp foo\n'))
            .toEqual([0xa9, 0x01, 0x4c, 0x00, 0x80]);
      });

      it('should not turn a mnemonic into a label', function() {
        expect(assemble('.feature labels_without_colons\nlda #$01\n'))
            .toEqual([0xa9, 0x01]);
      });

      it('should not turn a macro call into a label', function() {
        expect(assemble(`.feature labels_without_colons
.macro twonops
  nop
  nop
.endmacro
twonops
`)).toEqual([0xea, 0xea]);
      });

      it('should not turn an assignment into a label', function() {
        expect(assemble(
            '.feature labels_without_colons\nfoo = $01\nlda #foo\n'))
            .toEqual([0xa9, 0x01]);
        expect(assemble(
            '.feature labels_without_colons\nfoo .set $02\nlda #foo\n'))
            .toEqual([0xa9, 0x02]);
      });

      it('should leave struct members alone', function() {
        // Inside a `.struct` a leading identifier declares a member, so the
        // feature must not steal it away as a label.
        expect(assemble(`.feature labels_without_colons
.struct Point
  xpos .byte
  ypos .byte
.endstruct
lda #.sizeof(Point)
`)).toEqual([0xa9, 0x02]);
      });

      it('should still accept a label with a colon', function() {
        expect(assemble(
            '.feature labels_without_colons\nfoo: lda #$01\n  jmp foo\n'))
            .toEqual([0xa9, 0x01, 0x4c, 0x00, 0x80]);
      });
    });

    describe('force_range', function() {
      // The assembler range-checks whatever it can resolve on its own; the
      // linker checks the rest. Both go through `Exprs.fits`, so the feature
      // has to turn off both of them.
      it('should fail on an out of range value the assembler resolved',
         function() {
        expect(assembleErrors('.byte $1234\n')).toEqual(['Not a byte: $1234']);
        expect(assembleErrors('lda #300\n')).toEqual(['Not a byte: $12c']);
        expect(assembleErrors('.word $12345\n'))
            .toEqual(['Not a word: $12345']);
      });

      it('should truncate an out of range value the assembler resolved',
         function() {
        expect(assemble('.feature force_range\n.byte $1234\n'))
            .toEqual([0x34]);
        expect(assemble('.feature force_range\nlda #300\n'))
            .toEqual([0xa9, 0x2c]);
      });

      it('should take a negative that fits as signed either way',
         function() {
        // Not the feature's doing - a negative that fits is always fine.
        expect(assemble('.byte -1\n  .word -1\n  lda #-1\n'))
            .toEqual([0xff, 0xff, 0xff, 0xa9, 0xff]);
        expect(assembleErrors('.byte -129\n')).toEqual(['Not a byte: -129']);
      });

      it('should fail on a branch the assembler resolved out of range',
         function() {
        // A backward branch inside one chunk never reaches the linker, so
        // before the check landed this was silently truncated to a wrong jump.
        expect(assembleErrors('back: nop\n.res 200\n  bne back\n'))
            .toEqual(['Branch out of range: offset -203 (valid range: -128 to 127)']);
        expect(assemble('.feature force_range\nback: nop\n.res 200\n  bne back\n')
                   .slice(-2))
            .toEqual([0xd0, 0x35]);
      });

      it('should fail on an out of range value without the feature',
         function() {
        // The linker reports each failed substitution once per pass, so match
        // the message rather than the count.
        expect(assembleErrors('.byte far\nfar: nop\n'))
            .toContain('Not a byte: $8001 at $8000');
      });

      it('should fail when a label plus an offset overflows a word',
         function() {
        expect(assembleErrors('.word Table + $ff00\nTable:\n  nop\n'))
            .toContain('Not a word: $17f02 at $8000');
      });

      it('should truncate an out of range value', function() {
        // `far` is $8001, which does not fit in the byte the linker has to
        // write, so the feature keeps the low byte instead of failing.
        expect(assemble('.feature force_range\n.byte far\nfar: nop\n'))
            .toEqual([0x01, 0xea]);
      });

      it('should fail on a branch out of range without the feature',
         function() {
        expect(assembleErrors('bne far\n.res 200\nfar: nop\n'))
            .toContain(
                'Branch out of range: offset 200 at $8001 (valid range: -128 to 127)');
      });

      it('should truncate a branch out of range', function() {
        const data = assemble(
            '.feature force_range\nbne far\n.res 200\nfar: nop\n');
        expect(data.slice(0, 2)).toEqual([0xd0, 0xc8]);
      });

      it('should record itself on the substitution it applies to',
         function() {
        // The check lives in the linker, so the flag has to survive assembly -
        // including a separate `-c` assembly - by riding on the substitution.
        const m = assembleModule(
            '.feature force_range\n.byte far\nfar: nop\n');
        expect(m.chunks![0].subs).toEqual([
          {offset: 0, size: 1, expr: expect.anything(), forceRange: true},
        ]);
      });

      it('should leave the substitution alone without the feature',
         function() {
        const m = assembleModule('.byte far\nfar: nop\n');
        expect(m.chunks![0].subs![0].forceRange).toBeUndefined();
      });
    });

    // The features js65 applies unconditionally are only "already on" for as
    // long as nothing regresses them, so pin a few with no flag set at all.
    describe('features that are always on', function() {
      it('should allow `@` in an identifier', function() {
        expect(assemble('@foo: lda #$01\n  jmp @foo\n'))
            .toEqual([0xa9, 0x01, 0x4c, 0x00, 0x80]);
      });

      it('should honor string escapes', function() {
        expect(assemble('.byte "a\\x42c"\n')).toEqual([0x61, 0x42, 0x63]);
      });

      it('should accept either quote style', function() {
        expect(assemble('.byte "ab", \'c\'\n')).toEqual([0x61, 0x62, 0x63]);
      });
    });
  });

  describe('.autoimport', function() {
    it('should accept no argument as a no-op', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.autoimport')]);
      expect(a.getMessages()).toEqual([]);
    });

    it('should accept `+` as a no-op', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.autoimport'), op('+')]);
      expect(a.getMessages()).toEqual([]);
    });

    it('should accept `-` without complaining', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([cs('.autoimport'), op('-')]);
      expect(a.getMessages()).toEqual([]);
    });

    it('should reject anything else after the directive', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.directive([cs('.autoimport'), ident('on')]))
          .toThrow(/Expected \+ or -/);
    });

    it('should keep assembling normally after `-`', function() {
      expect(assemble('.autoimport -\nlda #$03\n')).toEqual([0xa9, 0x03]);
      expect(assembleWarnings('.autoimport -\nlda #$03\n')).toEqual([]);
    });

    it('should leave an undefined symbol for the linker when on', function() {
      // Autoimport is the js65 default, so an undeclared name assembles as an
      // implicit import and only the linker gets to complain about it.
      const m = assembleModule('jsr Foo\n');
      expect(m.symbols!.some(s => s.expr?.op === 'im' && s.expr.sym === 'Foo'))
          .toBe(true);
    });

    it('should require an explicit import when off', function() {
      expect(assembleErrors('.autoimport -\njsr Foo\n'))
          .toEqual([expect.stringMatching(/Symbol 'Foo' undefined/)]);
    });

    it('should still accept a declared import when off', function() {
      const m = assembleModule('.autoimport -\n.import Foo\njsr Foo\n');
      expect(m.symbols!.some(s => s.expr?.op === 'im' && s.expr.sym === 'Foo'))
          .toBe(true);
    });

    it('should not touch symbols that are defined locally when off', function() {
      expect(assemble('.autoimport -\nFoo: lda #$03\n  jmp Foo\n'))
          .toEqual([0xa9, 0x03, 0x4c, 0x00, 0x80]);
    });

    it('should still allow forward references when off', function() {
      expect(assemble('.autoimport -\n  jmp Foo\nFoo: lda #$03\n'))
          .toEqual([0x4c, 0x03, 0x80, 0xa9, 0x03]);
    });

    it('should apply to the whole module regardless of where it appears',
       function() {
      // ca65 treats autoimport as a global switch read at scope-close time,
      // not a positional one, so a later `-` governs an earlier reference.
      expect(assembleErrors('jsr Foo\n.autoimport -\n'))
          .toEqual([expect.stringMatching(/Symbol 'Foo' undefined/)]);
    });

    it('should record what it inferred on the module', function() {
      const m = assembleModule('lda Foo\n');
      expect(m.autoImports!.map(a => a.name)).toEqual(['Foo']);
      // The reference site rides along so tools can point at it.
      expect(m.autoImports![0].source).toMatchObject({file: 'test.s', line: 1});
    });

    it('should record nothing when the name was declared', function() {
      const m = assembleModule('.import Foo\nlda Foo\n');
      expect(m.autoImports).toBeUndefined();
    });

    it('should record nothing for a plain forward reference', function() {
      const m = assembleModule('jmp Foo\nFoo: rts\n');
      expect(m.autoImports).toBeUndefined();
    });

    it('should round-trip autoImports through an object file', function() {
      // The replay reads this back to size auto-imports, so a separately
      // assembled `.o` has to carry it.
      const m = assembleModule('lda Foo\n');
      const m2 = deserializeObjectFile(serializeObjectFile(m));
      expect(m2.autoImports).toEqual(m.autoImports);
    });
  });

  describe('.autoimport late pass', function() {
    // An auto-imported name is external, so the module has to defer its width
    // to the linker exactly the way a declared `.import` does.
    it('records a size query so the linker can re-size the reference',
       function() {
      const m = assembleModule('lda Foo\n');
      expect(m.lateAssembly).toBeDefined();
      expect(m.lateAssembly!.sizeQueries.map(q => [q.name, q.guess]))
          .toEqual([['Foo', 2]]);
    });

    it('guesses abs on the first pass', function() {
      const m = assembleModule('lda Foo\nrts\n');
      expect(Array.from(m.chunks![0].data)).toEqual([0xad, 0xff, 0xff, 0x60]);
    });

    it('re-sizes to zp when the late pass finds the export in a zp segment',
       function() {
      const zpEnv: LinkTimeEnv = {
        addrSize: () => 1,
        bank: () => undefined,
        segmentBank: () => undefined,
      };
      const m = assembleModule('lda Foo\nrts\n');
      const replay = replayModule(m, zpEnv);
      expect(replay.success).toBe(true);
      expect(Array.from(replay.module.chunks![0].data))
          .toEqual([0xa5, 0xff, 0x60]);
    });

    it('stays abs when the late pass reports an abs export', function() {
      const absEnv: LinkTimeEnv = {
        addrSize: () => 2,
        bank: () => undefined,
        segmentBank: () => undefined,
      };
      const m = assembleModule('lda Foo\nrts\n');
      const replay = replayModule(m, absEnv);
      expect(replay.success).toBe(true);
      expect(Array.from(replay.module.chunks![0].data))
          .toEqual([0xad, 0xff, 0xff, 0x60]);
    });
  });

  describe('.assert', function() {
    it('should pass immediately when true', function() {
      const a = new Assembler(Cpu.P02);
      a.assert({op: 'num', num: 1});
      expect(strip(a.module())).toEqual({chunks: [], symbols: [], segments: []});
    });

    it('should fail at module close when false', function() {
      const a = new Assembler(Cpu.P02);
      a.assert({op: 'num', num: 0});
      a.module();
      expect(a.getMessages().map(m => [m.level, m.message]))
          .toEqual([['error', 'Assertion failed']]);
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
          asserts: [{expr: {op: '>', meta: {size: 1},
                            args: [off(0), {op: 'num', num: 8, meta: {size: 1}}]},
                     action: 'error'}],
        }],
        symbols: [], segments: []});
    });

    it('should parse every action spelling', function() {
      const a = new Assembler(Cpu.P02);
      const parse = (action: string) =>
          a.parseAssert([ASSERT, num(1), COMMA, ident(action)])[1];
      expect(parse('warn')).toBe('warning');
      expect(parse('warning')).toBe('warning');
      expect(parse('error')).toBe('error');
      expect(parse('ldwarn')).toBe('ldwarning');
      expect(parse('ldwarning')).toBe('ldwarning');
      expect(parse('lderror')).toBe('lderror');
    });

    it('should default the action to error', function() {
      const a = new Assembler(Cpu.P02);
      expect(a.parseAssert([ASSERT, num(1)])[1]).toBe('error');
    });

    it('should reject an unknown action', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.parseAssert([ASSERT, num(1), COMMA, ident('bogus')]))
          .toThrow(/Bad assertion action: bogus/);
    });

    it('should allow a message with the action omitted', function() {
      const a = new Assembler(Cpu.P02);
      const [, action, message] =
          a.parseAssert([ASSERT, num(1), COMMA, str('msg')]);
      expect(action).toBe('error');
      expect(message).toBe('msg');
    });

    it('should report the message without doubling it', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([ASSERT, num(0), COMMA, str('msg')]);
      a.module();
      expect(a.getMessages().map(m => m.message)).toEqual(['msg']);
    });

    it('should accept a .sprintf message', function() {
      expect(assembleErrors('.assert 0, error, .sprintf("bad %d here", 5)'))
          .toEqual(['bad 5 here (PC=$8000)']);
    });

    it('should accept a .concat message with the action omitted', function() {
      expect(assembleErrors('.assert 0, .concat("a", "b")'))
          .toEqual(['ab (PC=$8000)']);
    });

    it('should reject a non-string message', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.parseAssert([ASSERT, num(0), COMMA, ident('error'),
                                  COMMA, num(5)]))
          .toThrow(/Expected a constant string message/);
    });

    it('should reject a multi-token message', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.parseAssert([ASSERT, num(0), COMMA, ident('error'),
                                  COMMA, LP, str('msg'), RP]))
          .toThrow(/Expected a constant string message/);
    });

    it('should reject extra arguments', function() {
      const a = new Assembler(Cpu.P02);
      expect(() => a.parseAssert([ASSERT, num(0), COMMA, ident('error'),
                                  COMMA, str('msg'), COMMA, ident('extra')]))
          .toThrow(/Too many arguments to \.assert/);
    });

    it('should default the message when none is given', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([ASSERT, num(0)]);
      a.module();
      expect(a.getMessages().map(m => m.message)).toEqual(['Assertion failed']);
    });

    it('should fold a forward reference by module close', function() {
      expect(assembleErrors('  nop\n.assert Foo = $8000, error, "wrong spot"\n' +
                            'Foo:\n  rts\n'))
          .toEqual(['wrong spot (PC=$8001)']);
    });

    it('should report a warning action without failing', function() {
      expect(assembleWarnings('.assert 0, warning, "soft"\n'))
          .toEqual(['soft (PC=$8000)']);
    });

    it('should not evaluate ldwarning at assemble time', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([ASSERT, num(0), COMMA, ident('ldwarning')]);
      a.module();
      expect(a.getMessages()).toEqual([]);
    });

    it('should not evaluate lderror at assemble time', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([ASSERT, num(0), COMMA, ident('lderror')]);
      a.module();
      expect(a.getMessages()).toEqual([]);
    });

    it('should report every failing assertion', function() {
      expect(assembleErrors('.assert 0, error, "first"\n' +
                            '.assert 0, error, "second"\n'))
          .toEqual(['first (PC=$8000)', 'second (PC=$8000)']);
    });

    it('should not materialize a chunk for a passing assertion', function() {
      const a = new Assembler(Cpu.P02);
      a.directive([ASSERT, num(1)]);
      expect(strip(a.module())).toEqual({chunks: [], symbols: [], segments: []});
    });

    it('round-trips action and message through the object file', function() {
      const m = assembleModule('.import Foo\n' +
                               '.assert Foo > 8, ldwarning, "check Foo"\n');
      const m2 = deserializeObjectFile(serializeObjectFile(m));
      const a = m2.chunks![0].asserts![0];
      expect(a.action).toBe('ldwarning');
      expect(a.message).toBe('check Foo');
      expect(a.expr).toEqual(m.chunks![0].asserts![0].expr);
    });

    it('rejects a v1 object file with bare-expression asserts', function() {
      const v1 = {
        version: 1,
        chunks: [{segments: [], data: '',
                  asserts: [{op: 'num', num: 0, meta: {size: 1}}]}],
      };
      const bytes = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(v1)));
      // Structural validation runs before the version check, so this is
      // refused on the missing `action` rather than the stale version.
      expect(() => deserializeObjectFile(bytes, 'old.o'))
          .toThrow(/asserts\[0\]\.action/);
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
    // it('should allow symbols outside of scope to keep size', function() {
    //   const a = new Assembler(Cpu.P02);
    //   a.assign('bar', 5);
    //   a.scope('foo');
    //   a.instruction([ident('sta'), ident('bar')]);
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

    it('should not emit an empty chunk when opened outside a segment', function() {
      const m = assembleModule(`
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
       function() {
      const m = assembleModule(`.scope Constants\n  FOO = 1\n.endscope\n`);
      expect(m.chunks).toEqual([]);
    });

    // The size of a scope still has to be measured from the first byte the scope
    // actually emits, even though the chunk doesn't exist when the scope opens.
    it('should size a scope that opens before its chunk exists', function() {
      const m = assembleModule(`
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

    // Regression test: the same name `.import`-ed in two separate sibling
    // `.proc` blocks used to report the second occurrence as `Symbol 'foo'
    // already defined`. `globalScopes`/`closeScopes` only tracked one scope
    // per name, so the second proc's local symbol got merged into the
    // first's instead of resolving as its own independent import.
    it('should allow importing the same symbol from two sibling procs', function() {
      const main = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.proc FirstUser
.import foo
  lda #foo
  rts
.endproc
.proc SecondUser
.import foo
  lda #foo
  rts
.endproc
`;
      const lib = `.segment "CODE"
foo = $ff
.export foo
`;
      const result = compile([
        {type: 'source', code: main, name: 'main.s'} as AssemblyInput,
        {type: 'source', code: lib, name: 'lib.s'} as AssemblyInput,
      ], {});
      if (!result.success) throw new Error(JSON.stringify(result));
      expect(Array.from(result.outputs[0].data))
          .toEqual([0xa9, 0xff, 0x60, 0xa9, 0xff, 0x60]);
    });
  });

  describe('late-assembly query recording', function() {
    it('records one query for a plain .import used as an address', function() {
      const a = new Assembler(Cpu.P02);
      a.import('foo');
      a.instruction([ident('lda'), ident('foo')]);
      expect(a.lateAssemblyQueries).toEqual([{name: 'foo', guess: 2, source: undefined}]);
    });

    it('records no query for .importzp', function() {
      const a = new Assembler(Cpu.P02);
      a.importzp('foo');
      a.instruction([ident('lda'), ident('foo')]);
      expect(a.lateAssemblyQueries).toEqual([]);
    });

    it('records no query for a local zeropage symbol', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5);
      a.instruction([ident('lda'), ident('foo')]);
      expect(a.lateAssemblyQueries).toEqual([]);
    });

    it('records no query for a local in-module symbol', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 0x1234);
      a.instruction([ident('lda'), ident('foo')]);
      expect(a.lateAssemblyQueries).toEqual([]);
    });

    it('does not change assembled bytes', function() {
      const a = new Assembler(Cpu.P02);
      a.import('foo');
      a.instruction([ident('lda'), ident('foo')]);
      expect(a.lateAssemblyQueries.length).toBe(1);
      expect(Array.from(strip(a.module()).chunks![0].data)).toEqual([0xad, 0xff, 0xff]);
    });
  });

  describe('linkEnv consultation', function() {
    const zpEnv: LinkTimeEnv =
        {addrSize: () => 1, bank: () => undefined, segmentBank: () => undefined};
    const absEnv: LinkTimeEnv =
        {addrSize: () => 2, bank: () => undefined, segmentBank: () => undefined};

    it('sizes a bare import as zp when linkEnv says so, and records no query', function() {
      const a = new Assembler(Cpu.P02);
      a.linkEnv = zpEnv;
      a.import('foo');
      a.instruction([ident('lda'), ident('foo')]);
      expect(a.lateAssemblyQueries).toEqual([]);
      expect(Array.from(strip(a.module()).chunks![0].data)).toEqual([0xa5, 0xff]);
    });

    it('keeps a bare import abs when linkEnv agrees, and records no query', function() {
      const a = new Assembler(Cpu.P02);
      a.linkEnv = absEnv;
      a.import('foo');
      a.instruction([ident('lda'), ident('foo')]);
      expect(a.lateAssemblyQueries).toEqual([]);
      expect(Array.from(strip(a.module()).chunks![0].data)).toEqual([0xad, 0xff, 0xff]);
    });
  });

  describe('.bank via evalEnv (linkEnv + live chunk state)', function() {
    // With `linkEnv` set, `resolveSymbol` resolves a plain import's `im` expr
    // immediately, so `.bank(import)` folds to a byte right at `append()` -
    // no Substitution, no wait for closeScopes.
    it('resolves .bank(import) via linkEnv.bank as soon as the import is referenced', function() {
      const a = new Assembler(Cpu.P02);
      a.linkEnv = {addrSize: () => undefined,
                   bank: sym => sym === 'Target' ? 4 : undefined,
                   segmentBank: () => undefined};
      a.import('Target');
      a.directive([cs('.byte'), cs('.bankbyte'), LP, ident('Target'), RP]);
      const chunk = strip(a.module()).chunks![0];
      expect(chunk.subs ?? []).toEqual([]);
      expect(Array.from(chunk.data)).toEqual([4]);
    });

    it('leaves .bank(import) as an unresolved Substitution without a linkEnv', function() {
      const a = new Assembler(Cpu.P02);
      a.import('Target');
      a.directive([cs('.byte'), cs('.bankbyte'), LP, ident('Target'), RP]);
      const chunk = strip(a.module()).chunks![0];
      expect(chunk.subs?.length).toBe(1);
    });

    it('resolves .bank(*) via linkEnv.segmentBank on the current chunk', function() {
      const a = new Assembler(Cpu.P02);
      a.linkEnv = {addrSize: () => undefined, bank: () => undefined,
                   segmentBank: segs => segs.includes('BANK1') ? 9 : undefined};
      a.segment({name: 'BANK1'});
      a.directive([cs('.byte'), cs('.bankbyte'), LP, Tokens.STAR, RP]);
      expect(Array.from(strip(a.module()).chunks![0].data)).toEqual([9]);
    });

    it('resolves .bank(localLabel) via linkEnv.segmentBank, without an export', function() {
      const a = new Assembler(Cpu.P02);
      a.linkEnv = {addrSize: () => undefined, bank: () => undefined,
                   segmentBank: segs => segs.includes('BANK1') ? 6 : undefined};
      a.segment({name: 'BANK1'});
      a.label('localLabel');
      a.directive([cs('.byte'), cs('.bankbyte'), LP, ident('localLabel'), RP]);
      expect(Array.from(strip(a.module()).chunks![0].data)).toEqual([6]);
    });

    it('leaves .bank(*) unresolved without a linkEnv (pass 1 unaffected)', function() {
      const a = new Assembler(Cpu.P02);
      a.segment({name: 'BANK1'});
      a.directive([cs('.byte'), cs('.bankbyte'), LP, Tokens.STAR, RP]);
      const chunk = strip(a.module()).chunks![0];
      expect(chunk.subs?.length).toBe(1);
    });

    it('resolves .bank(forwardLabel) once the label is defined later in the module', function() {
      const a = new Assembler(Cpu.P02);
      a.linkEnv = {addrSize: () => undefined, bank: () => undefined,
                   segmentBank: segs => segs.includes('BANK1') ? 7 : undefined};
      a.directive([cs('.byte'), cs('.bankbyte'), LP, ident('forwardLabel'), RP]);
      a.segment({name: 'BANK1'});
      a.label('forwardLabel');
      const sub = strip(a.module()).chunks![0].subs![0];
      expect(sub.expr).toEqual({op: 'num', num: 7, meta: {size: 1}});
    });

    it('resolves .addrsize(import) the same way, immediately', function() {
      const a = new Assembler(Cpu.P02);
      a.linkEnv = {addrSize: sym => sym === 'Target' ? 1 : undefined,
                   bank: () => undefined, segmentBank: () => undefined};
      a.import('Target');
      a.directive([cs('.byte'), cs('.addrsize'), LP, ident('Target'), RP]);
      const chunk = strip(a.module()).chunks![0];
      expect(chunk.subs ?? []).toEqual([]);
      expect(Array.from(chunk.data)).toEqual([1]);
    });
  });

  describe('.if/.elseif/.else/.endif directives (pass 1, unreachable via the ' +
      'preprocessor today - constructed directly to exercise the assembler path)',
      function() {
    it('guesses false, records a condQuery, and skips the dead branch with no side effects',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
        [cs('.endif')],
      ]));
      expect(a.lateAssemblyCondQueries.length).toBe(1);
      // Label1 lived in the guessed-dead branch, so it was never defined -
      // exporting it would otherwise fail with "Exported symbol undefined".
      const {lateAssembly, ...rest} = strip(a.module());
      expect(rest).toEqual({chunks: [], segments: [], symbols: []});
      expect(lateAssembly!.condQueries.length).toBe(1);
    });

    it('processes the `.else` branch since the `.if` is always guessed false',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
        [cs('.else')],
        [ident('Label2'), COLON],
        [cs('.endif')],
      ]));
      a.export('Label2');
      expect(a.lateAssemblyCondQueries.length).toBe(1);
      const {lateAssembly, ...rest} = strip(a.module());
      expect(rest).toEqual({
        chunks: [{overwrite: 'allow', segments: [], name: 'Label2', data: Uint8Array.of()}],
        segments: [],
        symbols: [{export: 'Label2', expr: off(0)}],
      });
      expect(lateAssembly!.condQueries.length).toBe(1);
    });

    it('keeps guessing false through an `.elseif` chain down to the final `.else`',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
        [cs('.elseif'), num(2)],
        [ident('Label2'), COLON],
        [cs('.else')],
        [ident('Label3'), COLON],
        [cs('.endif')],
      ]));
      a.export('Label3');
      // Both the `.if` and the `.elseif` defer, but only one query is recorded -
      // the whole chain is a single "not decided" unit at pass 1.
      expect(a.lateAssemblyCondQueries.length).toBe(1);
      const {lateAssembly, ...rest} = strip(a.module());
      expect(rest).toEqual({
        chunks: [{overwrite: 'allow', segments: [], name: 'Label3', data: Uint8Array.of()}],
        segments: [],
        symbols: [{export: 'Label3', expr: off(0)}],
      });
      expect(lateAssembly!.condQueries.length).toBe(1);
    });

    it('drops the whole chain when no `.else` is present', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
        [cs('.elseif'), num(2)],
        [ident('Label2'), COLON],
        [cs('.endif')],
      ]));
      expect(a.lateAssemblyCondQueries.length).toBe(1);
      const m = strip(a.module());
      const {lateAssembly, ...rest} = m;
      expect(rest).toEqual({chunks: [], segments: [], symbols: []});
      expect(lateAssembly!.condQueries.length).toBe(1);
    });

    it('does not lose the skipped branch from the recorded late-assembly stream',
        function() {
      // `skipGuessedDeadBranch` pulls lines straight from `_tokenSource`,
      // bypassing `tokens()`'s own loop - confirm they still land in
      // `lateAssemblyStream` via the wrapped recording source.
      const a = new Assembler(Cpu.P02);
      const lines: Token[][] = [
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
        [cs('.endif')],
      ];
      a.tokens(tokenSource(lines));
      expect((a as unknown as {lateAssemblyStream: Token[][]}).lateAssemblyStream)
          .toEqual(lines);
    });

    it('a stray `.elseif`/`.else`/`.endif` with no open `.if` fails clearly',
        function() {
      // `directive()` records via `this.fail`, which reports through the error
      // collector rather than throwing out of `line()` - same recovery path
      // every other directive error uses.
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([[cs('.elseif'), num(1)]]));
      expect(a.getMessages().map(m => m.message)).toEqual(['.elseif without .if']);

      const b = new Assembler(Cpu.P02);
      b.tokens(tokenSource([[cs('.else')]]));
      expect(b.getMessages().map(m => m.message)).toEqual(['.else without .if']);
    });

    it('fails with EOF looking for .endif when the stream runs out mid-branch',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
      ]));
      expect(a.getMessages().map(m => m.message)).toEqual(['EOF looking for .endif']);
    });
  });

  describe('.if/.elseif/.else/.endif directives (replay: linkEnv answers for real)',
      function() {
    const noEnv: LinkTimeEnv =
        {addrSize: () => undefined, bank: () => undefined, segmentBank: () => undefined};

    it('processes the `.if` branch and skips the rest when its condition is true',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
      ]));
      const replay = replayModule(a.module(), noEnv);
      expect(replay.success).toBe(true);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x11]);
    });

    it('falls through to `.else` when the `.if` condition is false', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
      ]));
      const replay = replayModule(a.module(), noEnv);
      expect(replay.success).toBe(true);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x22]);
    });

    it('evaluates an `.elseif` chain in turn and picks the first true branch',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.elseif'), num(1)],
        [cs('.byte'), num(0x22)],
        [cs('.else')],
        [cs('.byte'), num(0x33)],
        [cs('.endif')],
      ]));
      const replay = replayModule(a.module(), noEnv);
      expect(replay.success).toBe(true);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x22]);
    });

    it('leaves nothing live when every branch is false and there is no `.else`',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.elseif'), num(0)],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
      ]));
      const replay = replayModule(a.module(), noEnv);
      expect(replay.success).toBe(true);
      expect(strip(replay.module).chunks).toEqual([]);
    });

    it('resolves a nested `.if` inside a live branch recursively', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [cs('.if'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
        [cs('.byte'), num(0x33)],
        [cs('.endif')],
      ]));
      const replay = replayModule(a.module(), noEnv);
      expect(replay.success).toBe(true);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x22, 0x33]);
    });

    it('resolves `.bank(import)` via linkEnv even though imports normally only ' +
        'settle at closeScopes', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Target')],
        [cs('.if'), cs('.bankbyte'), LP, ident('Target'), RP, cs('<>'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
      ]));
      const diffBank: LinkTimeEnv =
          {addrSize: () => undefined, bank: () => 4, segmentBank: () => undefined};
      const replay = replayModule(a.module(), diffBank);
      expect(replay.success).toBe(true);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x11]);
    });

    it('resolves `.bank(localLabel)` via linkEnv, without an export', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.segment'), str('BANK1')],
        [ident('localTarget'), COLON],
        [cs('.segment'), str('CODE')],
        [cs('.byte'), num(0x99)], // materialize a CODE chunk before `.if`
        [cs('.if'), cs('.bankbyte'), LP, ident('localTarget'), RP, cs('<>'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
      ]));
      const env: LinkTimeEnv = {addrSize: () => undefined, bank: () => undefined,
                                 segmentBank: segs => segs.includes('BANK1') ? 4 : 0};
      const replay = replayModule(a.module(), env);
      expect(replay.success).toBe(true);
      expect(Array.from(strip(replay.module).chunks![1].data)).toEqual([0x99, 0x11]);
    });

    it('raises Expected a constant at the chain\'s `.if` when the condition still ' +
        'cannot resolve on replay', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Ghost')],
        [cs('.if'), cs('.bankbyte'), LP, ident('Ghost'), RP, cs('<>'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.endif')],
      ]));
      const replay = replayModule(a.module(), noEnv);
      expect(replay.success).toBe(false);
      expect(replay.messages.map(m => m.message)).toEqual(['Expected a constant']);
    });

    it('needs a single scan when no `.if` queries a local forward reference',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Target')],
        [cs('.if'), cs('.bankbyte'), LP, ident('Target'), RP, cs('<>'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
      ]));
      const env: LinkTimeEnv =
          {addrSize: () => undefined, bank: () => 4, segmentBank: () => undefined};
      const replay = replayModule(a.module(), env);
      expect(replay.success).toBe(true);
      expect(replay.scans).toBe(1);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x11]);
    });

    it('needs two scans for a single-hop local forward reference', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.segment'), str('CODE')],
        [cs('.if'), cs('.bankbyte'), LP, ident('forwardLabel'), RP, cs('<>'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
        [ident('forwardLabel'), COLON],
        [cs('.byte'), num(0x33)],
      ]));
      const env: LinkTimeEnv = {addrSize: () => undefined, bank: () => undefined,
                                 segmentBank: segs => segs.includes('BANK1') ? 1 : 0};
      const replay = replayModule(a.module(), env);
      expect(replay.success).toBe(true);
      expect(replay.scans).toBe(2);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x22, 0x33]);
    });

    it('follows a chain of forward references without cutting it short',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.segment'), str('CODE')],
        [cs('.byte'), num(0x99)], // materialize a CODE chunk before `.if`
        // C's segment depends on B's bank, and B's on A's, so each scan
        // settles exactly one more hop of the chain.
        [cs('.if'), cs('.bankbyte'), LP, ident('B'), RP, cs('<>'), num(0)],
        [cs('.segment'), str('BANK1')],
        [cs('.endif')],
        [ident('C'), COLON],
        [cs('.byte'), num(0x03)],
        [cs('.segment'), str('CODE')],
        [cs('.if'), cs('.bankbyte'), LP, ident('A'), RP, cs('='), num(0)],
        [cs('.segment'), str('BANK1')],
        [cs('.endif')],
        [ident('B'), COLON],
        [cs('.byte'), num(0x01)],
        [cs('.segment'), str('CODE')],
        [ident('A'), COLON],
        [cs('.byte'), num(0x02)],
      ]));
      const env: LinkTimeEnv = {addrSize: () => undefined, bank: () => undefined,
                                 segmentBank: segs => segs.includes('BANK1') ? 1 : 0};
      const replay = replayModule(a.module(), env);
      expect(replay.success).toBe(true);
      expect(replay.scans).toBe(3);
      const chunks = strip(replay.module).chunks!;
      expect(chunks.map(c => [c.segments, Array.from(c.data)])).toEqual([
        [['CODE'], [0x99]],
        [['BANK1'], [0x03]],
        [['BANK1'], [0x01]],
        [['CODE'], [0x02]],
      ]);
    });
  });

  describe('eager import resolution on replay (resolveSymbol answers directly)',
      function() {
    it('resolves .bankbyte(import) at the reference site, not via deferredOps',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Other')],
        [ident('lda'), ident('Other')], // forces a size query, so lateAssembly exists
        [cs('.import'), ident('Target')],
        [cs('.byte'), cs('.bankbyte'), LP, ident('Target'), RP],
      ]));
      const env: LinkTimeEnv = {addrSize: () => undefined,
                                 bank: sym => sym === 'Target' ? 4 : undefined,
                                 segmentBank: () => undefined};
      const replay = replayModule(a.module(), env);
      expect(replay.success).toBe(true);
      const chunk = strip(replay.module).chunks![0];
      // Only Other's unresolved address is a Substitution - Target's .bankbyte
      // folded to a byte immediately, without adding one of its own.
      expect(chunk.subs?.length).toBe(1);
      expect(Array.from(chunk.data).at(-1)).toBe(4);
    });

    it('resolves .addrsize(import) the same way', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Other')],
        [ident('lda'), ident('Other')],
        [cs('.import'), ident('Target')],
        [cs('.byte'), cs('.addrsize'), LP, ident('Target'), RP],
      ]));
      const env: LinkTimeEnv = {addrSize: sym => sym === 'Target' ? 1 : undefined,
                                 bank: () => undefined, segmentBank: () => undefined};
      const replay = replayModule(a.module(), env);
      expect(replay.success).toBe(true);
      const chunk = strip(replay.module).chunks![0];
      expect(chunk.subs?.length).toBe(1);
      expect(Array.from(chunk.data).at(-1)).toBe(1);
    });

    it('a genuine redeclaration (import then a real label) still errors, tolerance ' +
        'check does not swallow it', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Other')],
        [ident('lda'), ident('Other')],
        [cs('.import'), ident('foo')],
        [ident('foo'), COLON],
      ]));
      const noEnv: LinkTimeEnv =
          {addrSize: () => undefined, bank: () => undefined, segmentBank: () => undefined};
      const replay = replayModule(a.module(), noEnv);
      expect(replay.success).toBe(false);
      expect(replay.messages.map(m => m.message)).toEqual([`Symbol 'foo' already defined`]);
    });

    it('a plain .import picks up zp size from linkEnv.addrSize, not just ' +
        '.importzp/zeropageGlobals', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Other')],
        [ident('lda'), ident('Other')],
        [cs('.import'), ident('Target')],
        [ident('lda'), ident('Target')],
      ]));
      const env: LinkTimeEnv = {addrSize: sym => sym === 'Target' ? 1 : undefined,
                                 bank: () => undefined, segmentBank: () => undefined};
      const replay = replayModule(a.module(), env);
      expect(replay.success).toBe(true);
      const data = Array.from(strip(replay.module).chunks![0].data);
      expect(data.slice(-2)).toEqual([0xa5, 0xff]); // zp mode, not abs
    });
  });

  describe('.global classification threaded through replay', function() {
    it('records import/export kinds in lateAssembly.globalKinds, empty when there ' +
        'are no .global declarations', function() {
      const noGlobal = assembleModule('.import foo\nlda foo\n');
      expect(noGlobal.lateAssembly!.globalKinds).toEqual({});

      const m = assembleModule(
          '.import Other\nlda Other\n.global AsImport\n.global AsExport\nAsExport:\n');
      expect(m.lateAssembly!.globalKinds).toEqual({AsImport: 'import', AsExport: 'export'});
    });

    it('a .global never locally defined gets the same eager import treatment as ' +
        '.import, in the .bank .if pattern', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.global'), ident('Target')],
        [cs('.if'), cs('.bankbyte'), LP, ident('Target'), RP, cs('<>'), num(0)],
        [cs('.byte'), num(0x11)],
        [cs('.else')],
        [cs('.byte'), num(0x22)],
        [cs('.endif')],
      ]));
      const m = a.module();
      expect(m.lateAssembly!.globalKinds).toEqual({Target: 'import'});
      const diffBank: LinkTimeEnv =
          {addrSize: () => undefined, bank: () => 4, segmentBank: () => undefined};
      const replay = replayModule(m, diffBank);
      expect(replay.success).toBe(true);
      expect(Array.from(strip(replay.module).chunks![0].data)).toEqual([0x11]);
    });

    it('a .global with a local definition is left for the normal forward-reference ' +
        'path, not eagerly resolved', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.import'), ident('Other')],
        [ident('lda'), ident('Other')],
        [cs('.segment'), str('BANK1')],
        [cs('.global'), ident('Target')],
        [cs('.byte'), cs('.bankbyte'), LP, ident('Target'), RP],
        [ident('Target'), COLON],
      ]));
      const m = a.module();
      expect(m.lateAssembly!.globalKinds).toEqual({Target: 'export'});
      const env: LinkTimeEnv = {addrSize: () => undefined, bank: () => undefined,
                                 segmentBank: segs => segs.includes('BANK1') ? 6 : undefined};
      const replay = replayModule(m, env);
      expect(replay.success).toBe(true);
      // A forward-referenced local label folds via the normal deferredOps retry,
      // not resolveSymbol - the byte itself stays a Substitution for the linker,
      // exactly as it would with no `.global` at all.
      const sub = strip(replay.module).chunks![1].subs![0];
      expect(sub.expr).toEqual({op: 'num', num: 6, meta: {size: 1}});
    });

    it('globalKinds round-trips through serializeObjectFile/deserializeObjectFile',
        function() {
      const m = assembleModule('.import Other\nlda Other\n.global Target\nlda Target\n');
      expect(m.lateAssembly!.globalKinds).toEqual({Target: 'import'});
      const bytes = serializeObjectFile(m);
      const m2 = deserializeObjectFile(bytes);
      expect(m2.lateAssembly!.globalKinds).toEqual(m.lateAssembly!.globalKinds);
    });
  });

  // ca65 keeps each .export/.import/.global bound to the scope it was written
  // in, so a file-scope declaration is not satisfied by a .proc-scoped one.
  describe('scoped .export/.global declarations', function() {
    it('rejects a file-scope .export satisfied only inside a .proc', function() {
      expect(assembleErrors(`
.export a_after
.proc pa
.export a_after
a_after:
  rts
.endproc
`)).toEqual([`Exported symbol 'a_after' undefined`]);
    });

    it('rejects a file-scope .export written after the .proc defining the label',
        function() {
      expect(assembleErrors(`
.proc pa
.export a_after
a_after:
  rts
.endproc
.export a_after
`)).toEqual([`Exported symbol 'a_after' undefined`]);
    });

    it('resolves a file-scope .global against a label defined inside a .proc',
        function() {
      // The .global becomes an import because its own scope never defines the
      // name; the .proc's .export publishes it and the linker pairs them up.
      expect(assemble(`
.global a_after
  jsr a_after
.proc pa
.export a_after
a_after:
  rts
.endproc
`)).toEqual([0x20, 0x03, 0x80, 0x60]);
    });
  });

  describe('late-assembly stream capture', function() {
    it('carries a stream and queries for a module with an unresolved size', function() {
      const m = assembleModule('.import foo\nlda foo\n');
      expect(m.lateAssembly).toBeDefined();
      expect(m.lateAssembly!.sizeQueries.length).toBe(1);
      expect(m.lateAssembly!.sizeQueries[0].name).toBe('foo');
      expect(m.lateAssembly!.sizeQueries[0].guess).toBe(2);
      expect(m.lateAssembly!.stream.length).toBeGreaterThan(0);
    });

    it('carries no block when every import is sized', function() {
      const m = assembleModule('.importzp foo\nlda foo\n');
      expect(m.lateAssembly).toBeUndefined();
    });

    it('carries a block for a module with only a deferred `.if` (no size queries)',
        function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
        [cs('.endif')],
      ]));
      const m = a.module();
      expect(m.lateAssembly).toBeDefined();
      expect(m.lateAssembly!.sizeQueries.length).toBe(0);
      expect(m.lateAssembly!.condQueries.length).toBe(1);
    });

    it('does not change assembled bytes', function() {
      const m = assembleModule('.import foo\nlda foo\nrts\n');
      expect(Array.from(m.chunks![0].data)).toEqual([0xad, 0xff, 0xff, 0x60]);
    });
  });

  describe('late-assembly stream capture soundness (debug re-run)', function() {
    it('reproduces an identical stream on a second full-pipeline run', function() {
      const body = '.import foo\nlda foo\nrts\n';
      const m1 = assembleModule(body);
      const m2 = assembleModule(body);
      expect(m1.lateAssembly!.stream.length).toBeGreaterThan(0);
      expect(m2.lateAssembly!.stream).toEqual(m1.lateAssembly!.stream);
      expect(m2.lateAssembly!.sizeQueries).toEqual(m1.lateAssembly!.sizeQueries);
    });

    it('.ifref/.ifsym/.ifconst after a query-recording reference reproduce identically', function() {
      const body = '.import foo\nlda foo\n' +
          '.ifref foo\n.byte 1\n.endif\n' +
          '.ifsym foo\n.byte 2\n.endif\n' +
          '.ifconst foo\n.byte 3\n.endif\n';
      const m1 = assembleModule(body);
      const m2 = assembleModule(body);
      expect(m1.lateAssembly!.sizeQueries.length).toBe(1);
      expect(m2.lateAssembly!.stream).toEqual(m1.lateAssembly!.stream);
      expect(Array.from(m2.chunks![0].data)).toEqual(Array.from(m1.chunks![0].data));
    });

    it('.ifref/.ifsym/.ifconst ahead of the reference (unresolved width) reproduce identically', function() {
      const body = '.ifref foo\n.byte 1\n.endif\n' +
          '.ifsym foo\n.byte 2\n.endif\n' +
          '.ifconst foo\n.byte 3\n.endif\n' +
          '.import foo\nlda foo\n';
      const m1 = assembleModule(body);
      const m2 = assembleModule(body);
      expect(m2.lateAssembly!.stream).toEqual(m1.lateAssembly!.stream);
      expect(Array.from(m2.chunks![0].data)).toEqual(Array.from(m1.chunks![0].data));
    });
  });

  describe('late-assembly replay', function() {
    it('reproduces byte-identical output, sourceMap and labelIndex with no linkEnv', function() {
      const body = '.import foo\nlda foo\nrts\n';
      const result = libAssemble(
          [{type: 'source', code: body, name: 'test.s'} as AssemblyInput],
          {generateDebugInfo: true});
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      const m = result.modules[0];
      expect(m.lateAssembly).toBeDefined();
      expect(m.chunks![0].sourceMap?.size).toBeGreaterThan(0);

      const replay = replayModule(m);
      expect(replay.success).toBe(true);
      expect(replay.messages).toEqual([]);
      expect(replay.module.chunks).toEqual(m.chunks);
      expect(replay.module.symbols).toEqual(m.symbols);
      expect(replay.module.segments).toEqual(m.segments);
      expect(replay.module.debugSymbols).toEqual(m.debugSymbols);
    });

    it('throws when given a module with no lateAssembly block', function() {
      const m = assembleModule('.importzp foo\nlda foo\n');
      expect(m.lateAssembly).toBeUndefined();
      expect(() => replayModule(m)).toThrow(/no lateAssembly block/);
    });
  });

  describe('late-assembly re-assembly side-effect safety', function() {
    // A `LinkTimeEnv` that always disagrees with pass 1's guess, so every
    // query'd module is replayed.
    const alwaysDiffers: LinkTimeEnv = {
      addrSize: () => 1,
      bank: () => undefined,
      segmentBank: () => undefined,
    };
    // Agrees with every guess, so nothing is replayed.
    const neverDiffers: LinkTimeEnv = {
      addrSize: () => 2,
      bank: () => undefined,
      segmentBank: () => undefined,
    };

    it('.warning fires exactly once for a module that gets replayed', function() {
      const body = '.import foo\nlda foo\n.warning "hi"\n';
      const result = libAssemble(
          [{type: 'source', code: body, name: 'test.s'} as AssemblyInput], {});
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      expect(result.modules[0].lateAssembly).toBeDefined();
      expect(result.moduleMessages[0].filter(m => m.message === 'hi').length).toBe(1);

      const replayed = replayModules(result.modules, result.moduleMessages, alwaysDiffers);
      expect(replayed.messages.filter(m => m.message === 'hi').length).toBe(1);
    });

    it('.out fires exactly once for a module that gets replayed', function() {
      const body = '.import foo\nlda foo\n.out "hi"\n';
      const result = libAssemble(
          [{type: 'source', code: body, name: 'test.s'} as AssemblyInput], {});
      if (!result.success) throw new Error(JSON.stringify(result.messages));

      const replayed = replayModules(result.modules, result.moduleMessages, alwaysDiffers);
      expect(replayed.messages.filter(m => m.message === 'hi').length).toBe(1);
    });

    it('a lint finding reports once for a module that gets replayed', function() {
      const body = '.import foo\nlda foo\njsr bar\nrts\nbar:\nrts\n';
      const result = libAssemble(
          [{type: 'source', code: body, name: 'test.s'} as AssemblyInput], {});
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      const findings = (msgs: readonly {code?: string}[]) =>
          msgs.filter(m => m.code === 'jsr-rts-tail-call');
      expect(findings(result.moduleMessages[0]).length).toBe(1);

      const replayed = replayModules(result.modules, result.moduleMessages, alwaysDiffers);
      expect(findings(replayed.messages).length).toBe(1);
    });

    it('a module whose guesses already match linkEnv is not replayed, and keeps its pass-1 messages', function() {
      const body = '.import foo\nlda foo\n.warning "hi"\n';
      const result = libAssemble(
          [{type: 'source', code: body, name: 'test.s'} as AssemblyInput], {});
      if (!result.success) throw new Error(JSON.stringify(result.messages));

      const replayed = replayModules(result.modules, result.moduleMessages, neverDiffers);
      expect(replayed.modules[0]).toBe(result.modules[0]);
      expect(replayed.messages.filter(m => m.message === 'hi').length).toBe(1);
    });

    it('a module with only a deferred `.if` (no size disagreement) is still replayed', function() {
      const a = new Assembler(Cpu.P02);
      a.tokens(tokenSource([
        [cs('.if'), num(1)],
        [ident('Label1'), COLON],
        [cs('.endif')],
      ]));
      const m = a.module();
      expect(m.lateAssembly!.sizeQueries.length).toBe(0);
      expect(m.lateAssembly!.condQueries.length).toBe(1);

      const replayed = replayModules([m], [[]], neverDiffers);
      expect(replayed.modules[0]).not.toBe(m);
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
    it('should use a zp value when the size of the assignment is known', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5);
      a.instruction([ident('lda'), ident('foo')]);
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
    // it('should produce an error when the assignment is negative', function() {
    //   const a = new Assembler(Cpu.P02);
    //   a.assign('foo', -5);
    //   a.instruction([ident('lda'), ident('foo')]);
    //   try {
    //     a.instruction([ident('lda'), ident('foo')]);
    //     expect("").toEqual("Test failed, didn't throw an error.");
    //   } catch (err: any) {
    //     expect(err.message).toEqual("-5 not in range 0-255");
    //   }
    // });
    it('should use a zp value for negative zero', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', -0);
      a.instruction([ident('lda'), ident('foo')]);
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
    it('should use an abs value because foo is resolved to the scope instead', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5);
      a.scope();
      a.assign('foo', 5000);
      a.instruction([ident('lda'), ident('foo')]);
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
    // it('should error since foo is resolved as size 1 when outputting the byte, but when resolved later its 2 bytes', function() {
    //   const a = new Assembler(Cpu.P02);
    //   a.assign('foo', 5);
    //   a.scope();
    //   a.instruction([ident('lda'), ident('foo')]);
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
    it('should use the outer foo when the inner one is not assigned until later', function() {
      const a = new Assembler(Cpu.P02);
      a.assign('foo', 5000);
      a.scope();
      a.instruction([ident('lda'), ident('foo')]);
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
    it('should use an abs value because the symbol is undefined, so it is sized to 2 until the symbol is defined', function() {
      const a = new Assembler(Cpu.P02);
      a.instruction([ident('lda'), ident('foo')]);
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
    it('should use an abs value because the symbol is undefined and it ends up using the global foo anyway', function() {
      const a = new Assembler(Cpu.P02);
      a.scope();
      a.instruction([ident('lda'), ident('foo')]);
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
    it('should error due to duplicate scope', function() {
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
    it('stops assembling the rest of the file', function() {
      expect(assemble(`
  .byte 1
  .end
  .byte 2
`)).toEqual([1]);
    });

    // `###` fails in the preprocessor rather than the assembler, checking that
    // the file is really stopped processing completely
    it('does not require the rest of the file to be valid', function() {
      expect(assemble(`
  .byte 1
  .end
  .notadirective bogus
  ###
`)).toEqual([1]);
    });

    it('is skipped inside a false conditional', function() {
      expect(assemble(`
  .byte 1
  .if 0
  .end
  .endif
  .byte 2
`)).toEqual([1, 2]);
    });
  });

  describe('.forceimport', function() {
    it('imports the symbol like .import', function() {
      const m = assembleModule(`.forceimport foo\n.byte foo\n`);
      expect(strip(m).symbols).toEqual([{expr: {op: 'im', sym: 'foo'}}]);
    });
  });

  describe('.fopt', function() {
    it('is accepted and ignored as its unimplemented still', function() {
      const m = assembleModule(`.fopt comment, "hello"\n.byte 1\n`);
      expect(m.chunks![0].data).toEqual(Uint8Array.of(1));
    });
  });

  describe('.fatal', function() {
    it('aborts the assembly instead of continuing like .error', function() {
      // `.error` is recoverable, so everything after it is still assembled...
      expect(assembleErrors(`
  .error "first"
  .error "second"
`)).toEqual(['first', 'second']);
      // ...while `.fatal` stops immediately, so the second one never runs.
      expect(assembleErrors(`
  .fatal "first"
  .error "second"
`)).toEqual(['first']);
    });

    it('reports its message exactly once', function() {
      expect(assembleErrors(`  .fatal "boom"\n`)).toEqual(['boom']);
    });

    it('requires a single string argument', function() {
      expect(assembleErrors(`  .fatal\n`))
          .toEqual(['Expected constant string after .fatal']);
    });
  });

  describe('.sizeof', function() {
    it('reports the total size of a struct', function() {
      expect(assemble(`
.struct Player
  xpos .byte
  ypos .byte
  hp   .word
.endstruct
  .byte .sizeof(Player)
`)).toEqual([4]);
    });

    it('treats a struct tag as a scope rather than a value', function() {
      // As in ca65, a struct name names a scope whose size is only reachable
      // through `.sizeof` - it is not itself a symbol holding the size.
      // With autoimport on it becomes an implicit import, so the complaint
      // comes from the linker; `.autoimport -` catches it while assembling.
      expect(() => assemble(`
.struct Player
  hp .word
.endstruct
  .byte Player
`)).toThrow(/Symbol never exported Player/);
      expect(assembleErrors(`
.autoimport -
.struct Player
  hp .word
.endstruct
  .byte Player
`)).toEqual([expect.stringMatching(/Symbol 'Player' undefined/)]);
    });

    it('reports the size of an individual struct field', function() {
      expect(assemble(`
.struct Player
  xpos .byte
  hp   .word
  name .byte 8
.endstruct
  .byte .sizeof(Player::xpos), .sizeof(Player::hp), .sizeof(Player::name)
`)).toEqual([1, 2, 8]);
    });

    it('reports the size of a .tag field as the tagged struct size', function() {
      expect(assemble(`
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

    it('reports the size of a .proc', function() {
      expect(assemble(`
.proc Foo
  lda #$00
  rts
.endproc
  .byte .sizeof(Foo)
`)).toEqual([0xa9, 0x00, 0x60, 3]);
    });

    it('includes nested scopes in a .proc size', function() {
      expect(assemble(`
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

    it('resolves a forward reference to a .proc size', function() {
      expect(assemble(`
  .byte .sizeof(Later)
.proc Later
  .byte $01, $02, $03
.endproc
`)).toEqual([3, 1, 2, 3]);
    });

    it('prefers a scope over a symbol of the same name', function() {
      expect(assemble(`
Foo = 99
.scope Foo
  .byte $01, $02
.endscope
  .byte .sizeof(Foo)
`)).toEqual([1, 2, 2]);
    });

    it('reports the size of data declared on a label line', function() {
      expect(assemble(`
buf: .res 10
tbl: .byte $01, $02, $03
  .byte .sizeof(buf), .sizeof(tbl)
`)).toEqual([...new Array(10).fill(0), 1, 2, 3, 10, 3]);
    });

    it('reports zero for a label with no data on its line', function() {
      expect(assemble(`
empty:
  .byte $aa
  .byte .sizeof(empty)
`)).toEqual([0xaa, 0]);
    });

    it('resolves forward references to structs and labels', function() {
      expect(assemble(`
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

    it('rejects .sizeof on an undefined name', function() {
      expect(() => assemble(`  .byte .sizeof(Nope)\n`))
          .toThrow(/Size of 'Nope' is unknown/);
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
      stripExpr(a.expr);
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
