
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {Preprocessor} from '../src/preprocessor.ts';
import * as Tokens from '../src/token.ts';
import {TokenStream} from '../src/tokenstream.ts';
import {Tokenizer} from '../src/tokenizer.ts';
import * as util from '../src/util.ts';
import { Assembler } from '../src/assembler.ts';

const [_] = [util];

describe('Preprocessor', function() {

  async function test(lines: string[], ...want: string[]) {
    const code = lines.join('\n');
    const toks = new TokenStream();
    toks.enter(new Tokenizer(code, 'input.s'));
    const out: string[] = [];
    const env = new Assembler();
    const preprocessor = new Preprocessor(toks, env);
    for (let line = await preprocessor.next(); line; line = await preprocessor.next()) {
      out.push(line.map(Tokens.name).join(' '));
    }
    expect(out).toEqual(want);
  }

  function testError(lines: string[], msg: RegExp) {
    const code = lines.join('\n');
    const toks = new TokenStream();
    toks.enter(new Tokenizer(code, 'input.s'));
    // deno-lint-ignore no-explicit-any
    const preprocessor = new Preprocessor(toks, {} as any);
    expect((async () => { while (await preprocessor.next()); })())
        .rejects.toThrow(msg);
  }

  describe('pass-through', function() {
    it('should pass through an instruction', async function() {
      await test(['lda #$01'], await instruction('lda #$01'));
    });

    it('should pass through two instructions', async function() {
      await test(['lda #$01', 'sta $02'],
           await instruction('lda #$01'),
           await instruction('sta $02'));
    });

    it('should pass through a label', async function() {
      await test(['foo:'], await label('foo:'));
    });

    it('should pass through an immutable assignment', async function() {
      await test(['foo = 1'], await assign('foo = 1'));
    });

    it('should pass through a mutable assignment', async function() {
      await test(['foo .set 1'], await assign('foo .set 1'));
    });

    it('should pass through a directive', async function() {
      await test(['.reloc'], await directive('.reloc'));
    });
  });

  describe('.define', function() {
    it('should expand with no parameters', async function() {
      await test(['.define foo x 1 y 2 z', 'foo foo'],
           await instruction('x 1 y 2 z x 1 y 2 z'));
    });

    it('should expand a C-style macro with parameters', async function() {
      await test(['.define foo(x, y) [ x : y ]', 'a foo(2, 3)'],
           await instruction('a [ 2 : 3 ]'));
    });

    it('should expand a TeX-style macro with parameters', async function() {
      await test(['.define foo {x y} [ x : y ]', 'a foo 2 3'],
           await instruction('a [ 2 : 3 ]'));
    });

    it('should expand an overloaded TeX-style macro', async function() {
      await test(['.define foo {x, rest .eol} [ x ] foo rest',
            '.define foo {x} [x]',
            'a foo 1, 2, 3'],
           await instruction('a [ 1 ] [ 2 ] [ 3 ]'));
    });

    it('should expand a macro with .eol in the production', async function() {
      await test(['.define foo {x y} [ x ] .eol b y 5',
            '.define bar {x} ( x )',
            'a foo 1 bar'],
           await instruction('a [ 1 ]'),
           await instruction('b ( 5 )'));
    });

    it('should be able to refer to not-yet-defined macros', async function() {
      await test(['.define foo bar',
            '.out foo',
            '.define bar baz',
            '.out foo',
            '.undefine bar',
            '.define bar qux',
            '.out foo'],
           await directive('.out bar'),
           await directive('.out baz'),
           await directive('.out qux'));
    });

    it('should allow not expanding the production', async function() {
      await test(['.define foo (x) .noexpand .tcount(x(a b))',
            '.define bar (x) x x x',
            'a foo bar'],
           await instruction('a 6'));
    });

    it('should terminate instead of recursing infinitely', function() {
      testError(['.define x x', 'x'], /Maximum expansion depth reached: x/);
    });
  });

  describe('.tcount', function() {
    it('should count the number of tokens', async function() {
      await test(['a .tcount(1 1 1)'],
           await instruction('a 3'));
    });

    it('should absorb one layer of braces', async function() {
      await test(['a .tcount({1 1 1})'],
           await instruction('a 3'));
    });

    it('should count the second layer of braces', async function() {
      await test(['a .tcount({{1 1 1}})'],
           await instruction('a 5'));
    });
  });

  describe('.string', function() {
    it('should produce a string', async function() {
      await test(['a .string(b)'], await instruction('a "b"'));
    });
  });

  describe('.concat', function() {
    it('should join strings', async function() {
      await test(['a .concat("b", "c", "d")'], await instruction('a "bcd"'));
    });

    it('should expand its argument first', async function() {
      await test(['a .concat("b", .string(c), "d")'], await instruction('a "bcd"'));
    });
  });

  describe('.ident', function() {
    it('should produce an identifier', async function() {
      await test(['.ident("b")'], await instruction('b'));
    });

    it('should expand its argument first', async function() {
      await test(['.ident(.concat("a", .string(b), "c"))'],
           await instruction('abc'));
    });
  });

  describe('.skip', function() {
    it('should skip over .define', async function() {
      await test(['.define abc def',
            '.skip .define abc xyz',
            '.undefine abc',
            'def'],
           await instruction('xyz'));
    });

    it('should descend into groups', async function() {
      await test(['.define bar a',
            '.define foo (x) .skip .noexpand .skip { bar bar x }',
            '.undefine bar',
            'foo 5'],
           await instruction('a bar 5'));
    });
  });

  describe('.macro', function() {
    it('should expand', async function() {
      await test(['.macro q a, b, c',
            'a b',
            'b c',
            'c a',
            '.endmacro',
            'q x, y, z'],
           await instruction('x y'),
           await instruction('y z'),
           await instruction('z x'));
    });

    it('should not pre-expand production', async function() {
      await test(['.define b c',
            '.macro q a',
            'b .tcount({a})',
            '.endmacro',
            '.undefine b',
            'q a b c d e'],
           await instruction('b 5'));
    });

    it('should fill in unfilled args with blank', async function() {
      await test(['.macro q a,b,c',
            'x .tcount({a}) .tcount({b}) .tcount({c})',
            '.endmacro',
            'q ,a a c c'],
           await instruction('x 0 4 0'));
    });

    it('should recurse', async function() {
      await test(['.macro q a,b,c',
            'x a',
            '.ifnblank b',
            'q b,c',
            '.endif',
            '.endmacro',
            'q 3,1,2'],
           await instruction('x 3'),
           await instruction('x 1'),
           await instruction('x 2'));
    });

    it('should support .exitmacro', async function() {
      await test(['.macro q a,b,c',
            'x a',
            '.ifblank b',
            '.exitmacro',
            '.endif',
            'q b,c',
            '.endmacro',
            'q 3,1,2'],
           await instruction('x 3'),
           await instruction('x 1'),
           await instruction('x 2'));
    });

    it('should allow .defined inside .elseif conditionals', async function() {
      // This test is not checking to see if the .defined works itself, just that further preprocessing steps
      // work inside of the .elseif
      await test(['.macro q a,b',
                 '.if .defined(.ident(.string(a)))',
                 'nope',
                 '.elseif .defined(.ident(.string(b)))',
                 'alsonope',
                 '.else',
                 'yep',
                 '.endif',
                 '.endmacro',
                 'q a,b'
                ],
                 await instruction('yep'));
    });

    it('should terminate instead of recursing infinitely', function() {
      testError(['.macro q',
                 'q',
                 '.endmacro',
                 'q'],
                /stack overflow/i);
    });
  });

  describe('.repeat', function() {
    it('should repeat its argument', async function() {
      await test(['.repeat 5',
            'foo',
            '.endrep'],
           await instruction('foo'),
           await instruction('foo'),
           await instruction('foo'),
           await instruction('foo'),
           await instruction('foo'));
    });

    it('should expand the current position', async function() {
      await test(['.repeat 5, i',
            'foo i',
            '.endrep'],
           await instruction('foo 0'),
           await instruction('foo 1'),
           await instruction('foo 2'),
           await instruction('foo 3'),
           await instruction('foo 4'));
    });

    it('should support nested repeats', async function() {
      await test(['.repeat 4, i',
            '.repeat i, j',
            'foo j i',
            '.endrep',
            '.endrep'],
           await instruction('foo 0 1'),
           await instruction('foo 0 2'),
           await instruction('foo 1 2'),
           await instruction('foo 0 3'),
           await instruction('foo 1 3'),
           await instruction('foo 2 3'));
    });
  });

  describe('.if', function() {
    it('should expand the then branch', async function() {
      await test(['.if 1',
            'x y',
            '.else',
            'a b',
            '.endif',
            'z'],
           await instruction('x y'),
           await instruction('z'));
    });

    it('should expand the else branch', async function() {
      await test(['.if 0',
            'x y',
            '.else',
            'a b',
            '.endif',
            'z'],
           await instruction('a b'),
           await instruction('z'));
    });

    it('should handle else-if', async function() {
      await test(['.if 0',
            'a b',
            '.elseif 1',
            'c d',
            '.elseif 2',
            'e f',
            '.else',
            'g h',
            '.endif',
            'z'],
           await instruction('c d'),
           await instruction('z'));
    });

    it('should handle nested ifs', async function() {
      await test(['.if 0',
            '  a',
            '  .if 1',
            '    b',
            '  .else',
            '    c',
            '  .endif',
            '  d',
            '.else',
            '  e',
            '  .if 1',
            '    f',
            '  .else',
            '    g',
            '  .endif',
            '  h',
            '.endif',
            'z'],
           await instruction('e'),
           await instruction('f'),
           await instruction('h'),
           await instruction('z'));
    });
  });

  it("should handle .ifp02", async function() {
    await test([
        '.ifp02',
        'a',
        '.else',
        'b',
        '.endif'
      ],
      await instruction('a')
    );
  });

  it("should handle unsupported .ifps", async function() {
    for (const code of '4510 816 c02 dtv sc02'.split(' ')) {
      await test([
          `.ifp${code}`,
          'a',
          '.else',
          'b',
          '.endif'
        ],
        await instruction('b')
      );
    }
  });

  describe('.sprintf', function() {
    async function testSprintf(fmt: string, arg: string | number | null, want: string) {
      let argStr = '';
      if (arg !== null)
        argStr = (typeof arg == 'string') 
          ? `, "${arg}"` : `, ${arg}`;

      test(
        [`.byte .sprintf("${fmt}"${argStr})`],
        await instruction(`.byte "${want}"`)
      )
      
    }
    it('should work with no arguments', async function() {
      await testSprintf('test', null, 'test');
    });
    it('should work with various arguments', async function() {
      await testSprintf('%%', null, '%');
      await testSprintf('%s', 'test', 'test');
      await testSprintf('%5s', 'test', ' test');
      await testSprintf('%1.3s', 'test', 'tes');
      await testSprintf('%d', -2, '-2');
      await testSprintf('%-3i', -3, '-3 ');
      await testSprintf('%o', 40, '50');
      await testSprintf('%3u', 5, '  5');
      await testSprintf('%X', 60, '3C');
      await testSprintf('%06x', 0x7c, '00007c');
      await testSprintf('%-6c', 0x41, 'A     ');
    });
    it('should work with all the arguments', async function() {
      await test(
        ['.byte .sprintf("a %% b %s c %d d %-3i e %o f %3u g %X h %06x i %-6c", "test", -2, -3, 4, 5, 60, $70, $41)'],
        await instruction('.byte "a % b test c -2 d -3  e 4 f   5 g 3C h 000070 i A     "')
      );
    });
    it('should work with an expression and constant', async function() {
      await test(
        [
          '.define x 2',
          '.byte .sprintf("%d", x * 2 + 1)',
        ],
        await instruction('.byte "5"')
      );
    });
    it('should work with an expression and `=` defined constant', async function() {
      await test(
        [
          'ConstValue = 2',
          'ExprValue = ConstValue + 2',
          '.byte .sprintf("%d", ExprValue * 2 + 1)',
        ],
        await assign('ConstValue = 2'), await assign('ExprValue = ConstValue + 2'), await instruction('.byte "9"')
      );
    });
    it('should work with an expression and `.set` defined constant', async function() {
      await test(
        [
          'ExprValue .set 2',
          'ExprValue .set ExprValue + 1',
          '.byte .sprintf("%d", ExprValue * 2 + 1)',
        ],
        await assign('ExprValue .set 2'), await assign('ExprValue .set ExprValue + 1'), await instruction('.byte "7"')
      );
    });
    // This test doesn't work at this point
    // it('should work with difference between labels', async function() {
    //   await test(
    //     [
    //       'Label1:',
    //       '.byte 3',
    //       'Label2:',
    //       '.byte 4',
    //       '.byte .sprintf("%d", Label2 - Label1)',
    //     ],
    //     await label('Label1'),
    //     await instruction('.byte 3'),
    //     await label('Label2'),
    //     await instruction('.byte 4'),
    //     await instruction('.byte "1"'),
    //   );
    // });
  });

  // TODO - test .local, both for symbols AND for defines.

  // TODO - tests for .if, make sure it evaluates numbers, etc...

});

function instruction(line: string) { return parseLine(line); }
function label(line: string) { return parseLine(line); }
function assign(line: string) { return parseLine(line); }
function directive(line: string) { return parseLine(line); }

async function parseLine(line: string) {
  const ts = new TokenStream();
  ts.enter(new Tokenizer(line));
  const toks = await ts.next();
  return toks!.map(Tokens.name).join(' ');
}
