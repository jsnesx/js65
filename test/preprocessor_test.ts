
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {Base64} from '../src/base64.ts';
import type {Expr} from '../src/expr.ts';
import {Preprocessor} from '../src/preprocessor.ts';
import * as Tokens from '../src/token.ts';
import {TokenStream} from '../src/tokenstream.ts';
import {searchFiles} from '../src/libassembler.ts';
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

  async function testError(lines: string[], msg: RegExp) {
    const code = lines.join('\n');
    const toks = new TokenStream();
    toks.enter(new Tokenizer(code, 'input.s'));
    const preprocessor = new Preprocessor(toks, new Assembler());
    await expect((async () => { while (await preprocessor.next()); })())
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

    it('should not split a mnemonic off as a label', async function() {
      // `inx :` is the instruction `inx` plus garbage, not a label named
      // `inx`; splitting it out here is what silently dropped the `inx`.
      await test(['inx : iny'], await instruction('inx : iny'));
      await test(['inx:'], await instruction('inx :'));
    });

    it('should not split a macro name off as a label', async function() {
      // The colon becomes a macro argument instead, which is the error ca65
      // reports for the same source.
      await testError(['.macro mm', '  nop', '.endmacro', 'mm : iny'],
                      /Too many macro parameters/);
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

  describe('.blank', function() {
    it('should produce produce a 1 if empty', async function() {
      await test(['a .blank()'], await instruction('a 1'));
    });
    it('should produce produce a 0 if not empty', async function() {
      await test(['a .blank(a)'], await instruction('a 0'));
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

    // Verified against ca65 V2.19: emits `05 99`. The body stores `.tcount`
    // verbatim and evaluates it at invocation, but `b` is substituted when the
    // body is scanned, so the later `.undefine` does not reach it.
    it('should store token functions unexpanded but substitute defines',
       async function() {
      await test(['.define b c',
            '.macro q a',
            'b .tcount({a})',
            '.endmacro',
            '.undefine b',
            'q a b c d e'],
           await instruction('c 5'));
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

    // Verified against ca65 V2.19 (Git c3e01062e).
    // A `.macro` body is scanned with defines expanded, so a `.define` standing
    // in for `.endmacro` closes the definition.
    it('should end a macro with a .define that expands to .endmacro', async function() {
      await test(['.define end_mac .endmacro',
                  '.macro q',
                  'x 1',
                  'end_mac',
                  'q'],
                 await instruction('x 1'));
    });

    // The flip side: the define has to exist by the time the body is scanned,
    // so declaring it afterwards leaves the `.macro` unterminated. ca65 swallows
    // the `.define` into the body and then fails on the invocation.
    it('should not end a macro with a .define declared after it', function() {
      testError(['.macro q',
                 'x 1',
                 'end_mac',
                 '.define end_mac .endmacro',
                 'q'],
                /endmacro/i);
    });

    // The nested-macro trick. A macro body is scanned but not expanded, so the
    // inner `.macro` is stored verbatim and `end_mac` must NOT be defined yet,
    // or it would close the outer definition early. It gets defined afterwards
    // and only resolves when `outer` runs and the inner body is scanned for real.
    it('should define a macro from inside a macro', async function() {
      await test(['.macro outer',
                  '.macro inner',
                  'x 1',
                  'end_mac',
                  '.endmacro',
                  '.define end_mac .endmacro',
                  'outer',
                  'inner'],
                 await instruction('x 1'));
    });

    // Defining end_mac first closes `outer` at the `end_mac` line instead, which
    // leaves the real `.endmacro` dangling.
    it('should close the outer macro when end_mac is already defined', function() {
      testError(['.define end_mac .endmacro',
                 '.macro outer',
                 '.macro inner',
                 'x 1',
                 'end_mac',
                 '.endmacro',
                 'outer'],
                /endmacro/i);
    });

    // The user-reported macro: builds a comma separated list by rewriting a
    // .define, with the generated push_back macro named via .ident/.concat.
    // ca65 assembles this and emits the bytes 01 02.
    it('should support a nested macro that accumulates a list', async function() {
      await test(['.macro define_array name',
                  '.macro .ident(.concat(.string(name), "_push_back")) value',
                  '.local temp',
                  '.define temp name',
                  '.undefine name',
                  '.ifblank temp',
                  '.define name value',
                  '.else',
                  '.define name temp, value',
                  '.endif',
                  '.undefine temp',
                  'end_mac',
                  '.define name',
                  '.endmacro',
                  '.define end_mac .endmacro',
                  'define_array tbl',
                  'tbl_push_back 1',
                  'tbl_push_back 2',
                  '.byte tbl'],
                 await directive('.byte 1, 2'));
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

    // Same root cause as the .macro case: the body scan reads raw lines, so a
    // define standing in for .endrep never closes the block.
    it('should end a repeat with a .define that expands to .endrep', async function() {
      await test(['.define end_rep .endrep',
                  '.repeat 2',
                  'foo',
                  'end_rep'],
                 await instruction('foo'),
                 await instruction('foo'));
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

    // Same root cause as the .macro case: the body scan reads raw lines, so a
    // define standing in for .endif never closes the block.
    it('should end a conditional with a .define that expands to .endif', async function() {
      await test(['.define end_if .endif',
                  '.if 1',
                  'x y',
                  'end_if',
                  'z'],
                 await instruction('x y'),
                 await instruction('z'));
    });

    // Verified against ca65 V2.19: emits only `77`. Define substitution sits
    // below the IfCond gate, so it still closes a block from a dead branch.
    it('should end a dead conditional with a .define that expands to .endif',
       async function() {
      await test(['.define end_if .endif',
                  '.if 0',
                  'x y',
                  'end_if',
                  'z'],
                 await instruction('z'));
    });

    // Same, one level down: the outer block is dead and both terminators are
    // defines. ca65 emits only `77`.
    it('should end nested dead conditionals with .defined terminators',
       async function() {
      await test(['.define end_if .endif',
                  '.if 0',
                  '.if 1',
                  'x y',
                  'end_if',
                  'end_if',
                  'z'],
                 await instruction('z'));
    });

    // Token functions sit above the gate, so a dead branch never evaluates
    // them. ca65 accepts this and emits only `77`.
    it('should not evaluate token functions in a dead branch', async function() {
      await test(['.if 0',
                  '.ident("nonexistent")',
                  '.endif',
                  'z'],
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

  describe('.left/.right/.mid', function() {
    it('should take the leftmost tokens', async function() {
      await test(['a .left(1, {a b c})'], await instruction('a a'));
    });

    it('should take the rightmost tokens', async function() {
      await test(['a .right(2, {a b c})'], await instruction('a b c'));
    });

    it('should take a slice from the middle', async function() {
      await test(['a .mid(1, 1, {a b c})'], await instruction('a b'));
    });
  });

  describe('.cond', function() {
    it('should return the true branch when the condition is truthy', async function() {
      await test(['a .cond(1, {b}, {c})'], await instruction('a b'));
    });

    it('should return the false branch when the condition is falsy', async function() {
      await test(['a .cond(0, {b}, {c})'], await instruction('a c'));
    });
  });

  describe('.definedmacro', function() {
    it('should find a .macro definition', async function() {
      await test(['.macro foo', '  nop', '.endmacro', 'a .definedmacro(foo)'],
           await instruction('a 1'));
    });

    it('should not find an undefined name', async function() {
      await test(['a .definedmacro(foo)'], await instruction('a 0'));
    });

    it('should not find a plain symbol', async function() {
      await test(['foo = 1', 'a .definedmacro(foo)'],
           await assign('foo = 1'), await instruction('a 0'));
    });
  });

  describe('.delmacro', function() {
    it('should delete a .macro definition', async function() {
      await test(['.macro foo', '  nop', '.endmacro', '.delmacro foo', 'foo'],
           await instruction('foo'));
    });

    it('should accept the .delmac spelling', async function() {
      await test(['.macro foo', '  nop', '.endmacro', '.delmac foo', 'foo'],
           await instruction('foo'));
    });

    it('should allow redefining the macro afterwards', async function() {
      await test(['.macro foo', '  nop', '.endmacro',
            '.delmacro foo',
            '.macro foo', '  rts', '.endmacro',
            'foo'],
           await instruction('rts'));
    });

    it('should reject a .define style macro', async function() {
      await testError(['.define foo bar', '.delmacro foo'],
                      /Not a \.macro: foo/);
    });

    it('should reject an unknown name', async function() {
      await testError(['.delmacro foo'], /Not defined: foo/);
    });
  });

  describe('.undefine', function() {
    it('should reject a .macro style macro', async function() {
      await testError(['.macro foo', '  nop', '.endmacro', '.undefine foo'],
                      /Not a \.define macro: foo/);
    });
  });

  describe('.time', function() {
    it('should substitute the current time in seconds', async function() {
      // Nondeterministic by nature, so check if its within a range instead
      const before = Math.floor(Date.now() / 1000);
      const toks = new TokenStream();
      toks.enter(new Tokenizer('a .time', 'input.s'));
      const line = await new Preprocessor(toks, new Assembler()).next();
      const after = Math.floor(Date.now() / 1000);
      const tok = line![1];
      expect(tok.token).toBe('num');
      expect((tok as Tokens.NumberToken).num).toBeGreaterThanOrEqual(before);
      expect((tok as Tokens.NumberToken).num).toBeLessThanOrEqual(after);
    });
  });

  describe('.version', function() {
    it('should substitute a bare pseudo-variable', async function() {
      await test(['a .version'], await instruction('a 531')); // $0213
    });

    it('should not consume parentheses', async function() {
      // ca65 rejects `.version()`, so the parens must survive as themselves.
      await test(['a .version ( 1 )'], await instruction('a 531 ( 1 )'));
    });
  });

  describe('.asize/.isize', function() {
    it('should report 8-bit registers', async function() {
      await test(['a .asize .isize'], await instruction('a 8 8'));
    });
  });

  describe('.cpu', function() {
    it('should report the supported instruction sets', async function() {
      await test(['a .cpu'], await instruction('a 3')); // 6502 and 6502X
    });

    it('should be usable in an .if condition', async function() {
      await test(['.if .cpu .bitand 2', // CPU_ISET_6502X
            'yep',
            '.else',
            'nope',
            '.endif'],
           await instruction('yep'));
    });

    it('should not consume parentheses', async function() {
      // ca65 rejects `.cpu()`, so the parens must survive as themselves.
      await test(['a .cpu ( 1 )'], await instruction('a 3 ( 1 )'));
    });
  });

  describe('.ref/.referenced', function() {
    it('should report an unreferenced symbol as 0', async function() {
      await test(['a .referencedsymbol(foo)'], await instruction('a 0'));
    });

    it('should accept the .referenced', async function() {
      await test(['a .referenced(foo)'], await instruction('a 0'));
    });

    it('should accept the .ref', async function() {
      await test(['a .ref(foo)'], await instruction('a 0'));
    });

    it('should report a defined symbol as referenced', async function() {
      await test(['foo = 1', 'a .ref(foo)'],
           await assign('foo = 1'), await instruction('a 1'));
    });
  });

  describe('.ismnemonic', function() {
    it('should recognize an opcode', async function() {
      await test(['a .ismnemonic(lda)'], await instruction('a 1'));
    });

    it('should recognize an opcode in upper case', async function() {
      await test(['a .ismnemonic(LDA)'], await instruction('a 1'));
    });

    it('should not recognize a non-opcode', async function() {
      await test(['a .ismnemonic(foo)'], await instruction('a 0'));
    });

    it('should accept the .ismnem spelling', async function() {
      await test(['a .ismnem(nop)'], await instruction('a 1'));
    });
  });

  describe('.match/.xmatch', function() {
    it('should match identical raw tokens', async function() {
      await test(['a .match(#, #)'], await instruction('a 1'));
    });

    it('should not match different tokens', async function() {
      await test(['a .match(x, 0)'], await instruction('a 0'));
    });

    it('.match should treat all identifiers as equal', async function() {
      await test(['a .match(x, y)'], await instruction('a 1'));
    });

    it('.xmatch should require identical identifier names', async function() {
      await test(['a .xmatch(a, b)'], await instruction('a 0'));
    });
  });

  describe('.if short-circuit', function() {
    it('should not evaluate the right side of .and when the left side is false', async function() {
      await test(['.if .defined(fwd) .and (fwd)',
            'nope',
            '.else',
            'yep',
            '.endif'],
           await instruction('yep'));
    });

    it('should not evaluate the right side of .or when the left side is true', async function() {
      await test(['.if 1 .or (fwd)',
            'yep',
            '.else',
            'nope',
            '.endif'],
           await instruction('yep'));
    });
    it('should not evaluate the right side of .or when the middle arg is true, checking left to right', async function() {
      await test(['.if 0 .or 1 .or (fwd)',
            'yep',
            '.else',
            'nope',
            '.endif'],
           await instruction('yep'));
    });
  });

  describe('.incbin', function() {
    function bytestr(start = 0, end?: number): string {
      return `.bytestr STR[$${new Base64().encode(BINARY.subarray(start, end))}]`;
    }

    it('should read the whole file', async function() {
      expect(await testFiles(['.incbin "data.bin"'])).toEqual([bytestr()]);
    });

    it('should apply an offset', async function() {
      expect(await testFiles(['.incbin "data.bin", 3'])).toEqual([bytestr(3)]);
    });

    it('should apply an offset and length', async function() {
      expect(await testFiles(['.incbin "data.bin", 3, 4'])).toEqual([bytestr(3, 7)]);
    });

    it('should resolve constants in the offset and length', async function() {
      expect(await testFiles(['OFFS = 1 + 2', 'LEN = 4',
                              '.incbin "data.bin", OFFS, LEN']))
          .toEqual([await assign('OFFS = 1 + 2'), await assign('LEN = 4'),
                    bytestr(3, 7)]);
    });

    it('should keep a label that precedes it on the line', async function() {
      expect(await testFiles(['Tiles: .incbin "data.bin", 0, 2']))
          .toEqual([await label('Tiles:'), bytestr(0, 2)]);
    });

    it('should take its path from a macro parameter', async function() {
      expect(await testFiles(['.macro ChrFile File',
                              '  .incbin File, 0, 2',
                              '.endmacro',
                              'ChrFile "data.bin"']))
          .toEqual([bytestr(0, 2)]);
    });

    it('should reject a non-constant offset', async function() {
      await expect(testFiles(['.incbin "data.bin", fwd']))
          .rejects.toThrow(/Expected a constant: symbol fwd/);
    });
  });

  describe('.include', function() {
    it('should splice the file into the stream', async function() {
      expect(await testFiles(['lda #3', '.include "other.s"', 'sta $4']))
          .toEqual([await instruction('lda #3'), await instruction('lda #5'),
                    await instruction('sta $4')]);
    });

    it('should report a file it cannot find', async function() {
      await expect(testFiles(['.include "nope.s"']))
          .rejects.toThrow(/Could not find file nope.s/);
    });
  });

  describe('.macpack', function() {
    it('should splice the package into the stream', async function() {
      // longbranch defines jeq, which expands to a branch around a jmp.
      expect(await testFiles(['.macpack longbranch', 'jeq target']))
          .toEqual([await instruction('bne *+5'), await instruction('jmp target')]);
    });

    it('should reject an unknown package', async function() {
      await expect(testFiles(['.macpack nosuchpack']))
          .rejects.toThrow(/Unknown macpack: nosuchpack/);
    });
  });

  // Reading a line is not the same as reaching it: the `.inc` family pulls in
  // outside source, so it must not run until the line is actually dispatched.
  describe('deferred source loading', function() {
    for (const [what, directive] of [['.include', '.include "other.s"'],
                                     ['.incbin', '.incbin "data.bin"']] as const) {
      it(`should not run ${what} in an untaken .if branch`, async function() {
        const reads: string[] = [];
        expect(await testFiles(['.if 0', directive, '.endif', 'nop'], reads))
            .toEqual([await instruction('nop')]);
        expect(reads).toEqual([]);
      });

      it(`should not run ${what} in an unexpanded macro body`, async function() {
        const reads: string[] = [];
        expect(await testFiles(['.macro unused', directive, '.endmacro', 'nop'], reads))
            .toEqual([await instruction('nop')]);
        expect(reads).toEqual([]);
      });

      it(`should not run ${what} in an unrepeated .repeat body`, async function() {
        const reads: string[] = [];
        expect(await testFiles(['.repeat 0', directive, '.endrep', 'nop'], reads))
            .toEqual([await instruction('nop')]);
        expect(reads).toEqual([]);
      });
    }

    // `.macpack` reads no file, so what shows whether it ran is whether the
    // package's macros ended up defined.
    for (const [where, guard] of [
        ['an untaken .if branch', ['.if 0', '.macpack longbranch', '.endif']],
        ['an unexpanded macro body',
         ['.macro unused', '.macpack longbranch', '.endmacro']],
        ['an unrepeated .repeat body',
         ['.repeat 0', '.macpack longbranch', '.endrep']]] as const) {
      it(`should not run .macpack in ${where}`, async function() {
        expect(await testFiles([...guard, 'jeq target']))
            .toEqual([await instruction('jeq target')]);
      });
    }

    it('should still run them in a taken .if branch', async function() {
      const reads: string[] = [];
      expect(await testFiles(['.if 1', '.include "other.s"', '.incbin "data.bin"',
                              '.endif'], reads))
          .toEqual([await instruction('lda #5'),
                    `.bytestr STR[$${new Base64().encode(BINARY)}]`]);
      expect(reads).toEqual(['other.s', 'data.bin']);
    });

    it('should run .include once the macro is expanded', async function() {
      const reads: string[] = [];
      expect(await testFiles(['.macro pull', '.include "other.s"', '.endmacro',
                              'pull', 'pull'], reads))
          .toEqual([await instruction('lda #5'), await instruction('lda #5')]);
      expect(reads).toEqual(['other.s', 'other.s']);
    });

    it('should run .incbin once the macro is expanded', async function() {
      const reads: string[] = [];
      const out = await testFiles(['.macro pull', '.incbin "data.bin"', '.endmacro',
                                   'pull'], reads);
      expect(out).toEqual([`.bytestr STR[$${new Base64().encode(BINARY)}]`]);
      expect(reads).toEqual(['data.bin']);
    });

    it('should run .macpack once the macro is expanded', async function() {
      expect(await testFiles(['.macro pull', '.macpack longbranch', '.endmacro',
                              'pull', 'jeq target']))
          .toEqual([await instruction('bne *+5'), await instruction('jmp target')]);
    });
  });

  // TODO - test .local, both for symbols AND for defines.

  // TODO - tests for .if, make sure it evaluates numbers, etc...

  describe('deferred marker pass-through', function() {
    // No source syntax produces a `deferred` marker yet - hand-build the
    // token stream directly, standing in for a future deferred `.if` block.
    function tokenSource(lines: Tokens.Token[][]): Tokens.Source {
      let i = 0;
      return {next: () => lines[i++]};
    }
    const marker = (str: string, deferred: boolean): Tokens.Token =>
        deferred ? {token: 'cs', str, deferred} : {token: 'cs', str};

    function run(line: Tokens.Token[]): Tokens.Token[]|undefined {
      const toks = new TokenStream();
      toks.enter(tokenSource([line]));
      return new Preprocessor(toks, new Assembler()).next();
    }

    for (const m of ['.if', '.elseif', '.else', '.endif']) {
      it(`passes a tagged ${m} straight through without dispatching it`, function() {
        const out = run([marker(m, true)]);
        expect(out?.map(Tokens.name).join(' ')).toEqual(m);
      });
    }

    it('still errors on an untagged stray .elseif', function() {
      expect(() => run([marker('.elseif', false)])).toThrow(/with no \.if/);
    });
  });

  describe('deferred .if', function() {
    // A minimal `Env` stub, standing in for the assembler so a `.bank(X)`
    // condition can be made to depend on an import or a chunk-relative
    // label without driving a real `Assembler`/linker.
    class StubEnv {
      readonly imports = new Set<string>();
      readonly locals = new Map<string, Expr>();
      definedSymbol(sym: string): boolean {
        return this.imports.has(sym) || this.locals.has(sym);
      }
      constantSymbol(): boolean { return false; }
      referencedSymbol(): boolean { return false; }
      isMnemonic(): boolean { return false; }
      allowsPcAssignment(): boolean { return false; }
      allowsLabelWithoutColon(): boolean { return false; }
      allowsUbiquitousIdents(): boolean { return false; }
      allowsMultiOpsPerLine(): boolean { return false; }
      evaluate(expr: Expr): number|undefined {
        return expr.op === 'num' && !expr.meta?.rel ? expr.num : undefined;
      }
      definedValue(sym: string): Expr|undefined {
        // An import has no compile-time value yet, matching the real
        // Assembler mid-file, before `closeScopes()` resolves it.
        return this.imports.has(sym) ? undefined : this.locals.get(sym);
      }
      assignSym(): void {}
      setSym(): void {}
      encodeChar(): number|undefined { return undefined; }
    }

    function run(env: StubEnv, lines: string[]): string[] {
      const toks = new TokenStream();
      toks.enter(new Tokenizer(lines.join('\n'), 'input.s'));
      const pre = new Preprocessor(toks, env);
      const out: string[] = [];
      for (let line = pre.next(); line; line = pre.next()) {
        out.push(line.map(Tokens.name).join(' '));
      }
      return out;
    }

    it('defers on an unresolved import, keeping both branches verbatim', async function() {
      const env = new StubEnv();
      env.imports.add('anImport');
      const out = run(env, [
          '.if .bank(anImport) <> 0', 'x y', '.else', 'a b', '.endif', 'z']);
      expect(out).toEqual([
          await directive('.if .bank(anImport) <> 0'),
          await instruction('x y'),
          await directive('.else'),
          await instruction('a b'),
          await directive('.endif'),
          await instruction('z')]);
    });

    it('defers on a chunk-relative local label, keeping both branches verbatim',
       async function() {
      const env = new StubEnv();
      env.locals.set('localLabel', {op: 'num', num: 0, meta: {rel: true, chunk: 0}});
      const out = run(env, [
          '.if .bank(localLabel) = 3', 'x y', '.else', 'a b', '.endif', 'z']);
      expect(out).toEqual([
          await directive('.if .bank(localLabel) = 3'),
          await instruction('x y'),
          await directive('.else'),
          await instruction('a b'),
          await directive('.endif'),
          await instruction('z')]);
    });

    it('leaves an already-resolvable .if byte-identical to today', async function() {
      const out = run(new StubEnv(), ['.if 1', 'x y', '.else', 'a b', '.endif', 'z']);
      expect(out).toEqual([await instruction('x y'), await instruction('z')]);
    });

    it('still expands a .define from both branches once deferred (documented wart)',
       async function() {
      const env = new StubEnv();
      env.imports.add('anImport');
      const out = run(env, [
          '.if .bank(anImport) <> 0', '.define A 1', '.else', '.define B 2', '.endif',
          'lda #A', 'lda #B']);
      expect(out).toEqual([
          await directive('.if .bank(anImport) <> 0'),
          await directive('.else'),
          await directive('.endif'),
          await instruction('lda #1'),
          await instruction('lda #2')]);
    });

    it('still resolves a resolvable .if nested inside a deferred block', async function() {
      const env = new StubEnv();
      env.imports.add('anImport');
      const out = run(env, [
          '.if .bank(anImport) <> 0',
          '.if 1', 'x y', '.else', 'a b', '.endif',
          '.else', 'c d', '.endif', 'z']);
      expect(out).toEqual([
          await directive('.if .bank(anImport) <> 0'),
          await instruction('x y'),
          await directive('.else'),
          await instruction('c d'),
          await directive('.endif'),
          await instruction('z')]);
    });

    it('still errors immediately on a genuinely undefined symbol', function() {
      expect(() => run(new StubEnv(), ['.if undefinedSym <> 0', 'x y', '.endif']))
          .toThrow(/Expected a constant/);
    });
  });

});

/** The one text file and the one binary file `testFiles` knows about. */
const TEXT_FILES: Record<string, string> = {'other.s': 'lda #5\n'};
const BINARY = util.fromByteString('0123456789');

/**
 * Runs the preprocessor over `lines` against a tiny fake file system, pushing
 * the name of every file it actually asks for onto `reads`. That list is how
 * the tests tell "resolved the directive" apart from "merely read past it".
 */
async function testFiles(lines: string[], reads: string[] = []): Promise<string[]> {
  const readText = searchFiles((_base: string, name: string) => {
    reads.push(name);
    const code = TEXT_FILES[name];
    if (code == null) throw new Error(`no such file: ${name}`);
    return code;
  });
  const readBinary = searchFiles((_base: string, name: string) => {
    reads.push(name);
    if (name !== 'data.bin') throw new Error(`no such file: ${name}`);
    return BINARY;
  });
  const toks = new TokenStream(readText, readBinary);
  toks.enter(new Tokenizer(lines.join('\n'), 'input.s'));
  const pre = new Preprocessor(toks, new Assembler());
  const out: string[] = [];
  for (let line = pre.next(); line; line = pre.next()) {
    out.push(line.map(Tokens.name).join(' '));
  }
  return out;
}

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
