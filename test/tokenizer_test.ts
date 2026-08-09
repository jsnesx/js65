
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import { Base64 } from '../src/base64.ts';
import { type Token } from '../src/token.ts';
import * as Tokens from '../src/token.ts';
import {Tokenizer, type Options} from '../src/tokenizer.ts';
import * as util from '../src/util.ts';
import { TokenStream } from '../src/tokenstream.ts';
import { ErrorCollector } from '../src/assembler.ts';

const [_] = [util];

// Validate that the error has the proper source info on it
async function expectSourceError(promise: Promise<unknown>, message: RegExp,
                                 line: number, column: number) {
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Tokens.SourceError);
  expect((err as Error).message).toMatch(message);
  expect((err as Tokens.SourceError).source)
      .toMatchObject({file: 'input.s', line, column});
}

//const MATCH = Symbol();

async function tokenize(str: string, opts: Options = {},
                        errorCollector?: ErrorCollector): Promise<Token[][]> {
  const out : Token[][] = [];
  const tokenizer = new Tokenizer(str, 'input.s', opts, undefined, errorCollector);
  for (let line = await tokenizer.next(); line; line = await tokenizer.next()) {
    out.push(line.map(strip));
  }
  return out;
}

async function tokenstream(str: string, included: string, opts: Options = {}): Promise<Token[][]> {
  const out : Token[][] = [];
  const readfile = async(_path: string, _filename: string) => {
      return await Promise.resolve(included);
  }
  const readfilebin = async(_path: string, _filename: string) => {
      return await Promise.resolve(new TextEncoder().encode(included));
  }
  const tokenstream = new TokenStream(readfile, readfilebin, opts);
  const tokenizer = new Tokenizer(str, 'input.s', opts);
  tokenstream.enter(tokenizer);
  for (let line = await tokenstream.next(); line; line = await tokenstream.next()) {
    const o = line.map(strip);
    // console.log(`o: ${JSON.stringify(o)}`);
    out.push(o);
  }
  return out;
}

function strip(token: Token): Token {
  delete token.source;
  if (token.token === 'grp') token.inner.forEach(strip);
  return token;
}

describe('Tokenizer.line', function() {
  it('should tokenize a source file', async function() {
    const toks = await tokenize(`
      ; comment is ignored
      label:
        lda #$1f ; also ignored
      .org $1c:$1234
      .ifdef XX
        .define YY
        .define YYZ %10101100
        pla
        sta ($11),y
      .elseif YY
        pha
      .endif`);

    expect(toks).toEqual([
      [{token: 'ident', str: 'label'}, Tokens.COLON],
      [{token: 'ident', str: 'lda'},
       {token: 'op', str: '#'}, {token: 'num', num: 0x1f, width: 1, radix: 16}],
      [{token: 'cs', str: '.org', rawStr: '.org'}, {token: 'num', num: 0x1c, width: 1, radix: 16},
       {token: 'op', str: ':'}, {token: 'num', num: 0x1234, width: 2, radix: 16}],
      [{token: 'cs', str: '.ifdef', rawStr: '.ifdef'}, {token: 'ident', str: 'XX'}],
      [{token: 'cs', str: '.define', rawStr: '.define'}, {token: 'ident', str: 'YY'}],
      [{token: 'cs', str: '.define', rawStr: '.define'}, {token: 'ident', str: 'YYZ'},
       {token: 'num', num: 0b10101100, width: 1, radix: 2}],
      [{token: 'ident', str: 'pla'}],
      [{token: 'ident', str: 'sta'},
       {token: 'lp'}, {token: 'num', num: 0x11, width: 1, radix: 16}, {token: 'rp'},
       {token: 'op', str: ','}, {token: 'ident', str: 'y'}],
      [{token: 'cs', str: '.elseif', rawStr: '.elseif'}, {token: 'ident', str: 'YY'}],
      [{token: 'ident', str: 'pha'}],
      [{token: 'cs', str: '.endif', rawStr: '.endif'}],
    ]);
  });

  it('should include a file as part of the stream', async function() {
    expect(await tokenstream(`
      lda #3
      .include "something.s"
      sta $4
    `, `
      lda #5
    `,)).toEqual([
      [{token: 'ident', str: 'lda'},
        {token: 'op', str: '#'}, {token: 'num', num: 0x03, radix: 10}],
      [{token: 'ident', str: 'lda'},
        {token: 'op', str: '#'}, {token: 'num', num: 0x05, radix: 10}],
      [{token: 'ident', str: 'sta'},
        {token: 'num', num: 0x04, width: 1, radix: 16}],
    ])
  });

  describe('.incbin', function() {
    const dataStr = '0123456789';
    const data = util.fromByteString(dataStr);

    async function testIncBin(startOffs?: number, length?: number) {
      let source = ['.incbin "something.bin"', startOffs, length].filter(x => x !== undefined).join(", ");
      if (startOffs === undefined) startOffs = 0;
      if (length === undefined) length = dataStr.length - startOffs;
      
      expect(await tokenstream(source, dataStr), source).toEqual([
        [{token: 'cs', str: '.bytestr'}, {token: 'str', str: new Base64().encode(data.subarray(startOffs, startOffs! + length!))}],
      ]);
    };

    it('should work with path only', async () => {return await testIncBin()});

    it('should work with path and offset', async () => {return await testIncBin(3)});

    it('should work with path, offset, and length', async () => {return await testIncBin(3, 4)});
  });

  it('should tokenize a label', async function() { 
    expect(await tokenize('foo:')).toEqual([
      [{token: 'ident', str: 'foo'}, {token: 'op', str: ':'}],
    ]);
  });

  it('should ignore comments', async function() { 
    expect(await tokenize('x ; ignored')).toEqual([
      [{token: 'ident', str: 'x'}],
    ]);
  });

  it('should tokenize an .assert', async function() {
    expect(await tokenize('.assert * = $0c:$8000')).toEqual([
      [{token: 'cs', str: '.assert', rawStr: '.assert'}, {token: 'op', str: '*'},
       {token: 'op', str: '='}, {token: 'num', num: 0x0c, width: 1, radix: 16},
       {token: 'op', str: ':'}, {token: 'num', num: 0x8000, width: 2, radix: 16}],
    ]);
  });

  it('should tokenize a string literal with escapes', async function() {
    expect(await tokenize(String.raw`"a\u1234\x12\;\"'"`)).toEqual([
      [{token: 'str', str: 'a\u1234\x12;"\''}],
    ]);
  });

  it('should tokenize grouping characters', async function() {
    expect(await tokenize('{([}])')).toEqual([
      [{token: 'grp',
        inner: [{token: 'lp'}, {token: 'lb'}]},
       {token: 'rb'},
       {token: 'rp'}],
    ]);
  });

  it('should tokenize a line with mismatched parens', async function() {
    expect(await tokenize('qux foo({x}, {y)}, {z})')).toEqual([
      [{token: 'ident', str: 'qux'},
       {token: 'ident', str: 'foo'},
       {token: 'lp'},
       {token: 'grp', inner: [{token: 'ident', str: 'x'}]},
       {token: 'op', str: ','},
       {token: 'grp', inner: [{token: 'ident', str: 'y'}, {token: 'rp'}]},
       {token: 'op', str: ','},
       {token: 'grp', inner: [{token: 'ident', str: 'z'}]},
       {token: 'rp'}],
    ]);
  });

  it('should tokenize all kinds of numbers', async function() {
    expect(await tokenize('123 0123 %10110 $123d')).toEqual([
      [{token: 'num', num: 123, radix: 10},
       {token: 'num', num: 123, radix: 10},
       {token: 'num', num: 0b10110, width: 1, radix: 2},
       {token: 'num', num: 0x123d, width: 2, radix: 16}],
    ]);
  });

  it('should tokenize relative and anonymous labels', async function() {
    expect(await tokenize('bcc :++')).toEqual([
      [{token: 'ident', str: 'bcc'},
       {token: 'ident', str: ':++'}],
    ]);
    expect(await tokenize('bcc :+3')).toEqual([
      [{token: 'ident', str: 'bcc'},
       {token: 'ident', str: ':+3'}],
    ]);
    expect(await tokenize('bne :---')).toEqual([
      [{token: 'ident', str: 'bne'},
       {token: 'ident', str: ':---'}],
    ]);
    expect(await tokenize('beq :-7')).toEqual([
      [{token: 'ident', str: 'beq'},
       {token: 'ident', str: ':-7'}],
    ]);
    expect(await tokenize('beq ++')).toEqual([
      [{token: 'ident', str: 'beq'},
       {token: 'op', str: '++'}],
    ]);
    expect(await tokenize('bvc -')).toEqual([
      [{token: 'ident', str: 'bvc'},
       {token: 'op', str: '-'}],
    ]);
    expect(await tokenize('bpl :>>>rts')).toEqual([
      [{token: 'ident', str: 'bpl'},
       {token: 'ident', str: ':>>>rts'}],
    ]);
    expect(await tokenize('bpl :rts')).toEqual([
      [{token: 'ident', str: 'bpl'},
       {token: 'ident', str: ':rts'}],
    ]);
    expect(await tokenize('bpl :<<rts')).toEqual([
      [{token: 'ident', str: 'bpl'},
       {token: 'ident', str: ':<<rts'}],
    ]);
  });

  it('should properly translate aliases', async function() {
    for (const [rawStr, str] of Tokens.CS_TOKEN_ALIAS_MAP) {
      expect(await tokenize(rawStr), rawStr).toEqual([
        [{token: 'cs', str, rawStr}]
      ]);
    }
  });

  it('should properly recognize capitalized directives', async function() {
    expect(await tokenize(".IncBin")).toEqual([
      [{token: 'cs', str: ".incbin", rawStr: ".IncBin"}]
    ]);
    expect(await tokenize(".lOCAl")).toEqual([
      [{token: 'cs', str: ".local", rawStr: ".lOCAl"}]
    ]);
  });

  it('should fail to parse a bad hex number', async function() {
    await expectSourceError(tokenize('  adc $1g'), /Bad hex number.*near '\$1g'/s, 1, 6);
  });

  it('should fail to parse a bad decimal number', async function() {
    await expectSourceError(tokenize('  12a'), /Bad decimal.*near '12a'/s, 1, 2);
  });

  it('should fail to parse a bad leading-zero number', async function() {
    await expectSourceError(tokenize('  01a'), /Bad decimal.*near '01a'/s, 1, 2);
  });

  it('should fail to parse a bad binary number', async function() {
    await expectSourceError(tokenize('  %012'), /Bad binary.*near '%012'/s, 1, 2);
  });

  it('should fail to parse a bad character', async function() {
    await expectSourceError(tokenize('  `abc'), /Syntax error/s, 1, 2);
  });

  it('should fail to parse a string unterminated at eof', async function() {
    await expectSourceError(tokenize('  "abc'), /Unterminated string, expected "/s, 1, 2);
  });

  it('should fail to parse a string unterminated at eol', async function() {
    await expectSourceError(tokenize('  "abc\n  lda #$12\n'),
                            /Unterminated string, expected "/s, 1, 2);
  });

  it('should fail to parse an unterminated char literal', async function() {
    await expectSourceError(tokenize("  .byte 'a\n"),
                            /Unterminated string, expected '/s, 1, 8);
  });

  it('should recover from an unterminated string when collecting errors', async function() {
    const collector = new ErrorCollector();
    const toks = await tokenize('  .byte "abc\n  lda #$12\n', {}, collector);
    // The string is terminated at the end of the line and the next line is fine.
    expect(toks).toEqual([
      [{token: 'cs', str: '.byte', rawStr: '.byte'}, {token: 'str', str: 'abc'}],
      [{token: 'ident', str: 'lda'}, {token: 'op', str: '#'},
       {token: 'num', num: 0x12, width: 1, radix: 16}],
    ]);
    expect(collector.getMessages()).toMatchObject([{
      level: 'error',
      message: `Unterminated string, expected "`,
      source: {file: 'input.s', line: 1, column: 8},
    }]);
  });

  it('should not parse .2 as a directive', async function() {
    await expectSourceError(tokenize(' .2'), /Syntax error/s, 1, 1);
  });

  // Verify that the original js65 tokenizer uses the original behavior
  describe('js65 token override checks', function() {
    it('should lex % as a binary literal prefix', async function() {
      expect(await tokenize('  .byte %0101, %11111111\n')).toEqual([[
        {token: 'cs', str: '.byte', rawStr: '.byte'},
        {token: 'num', num: 0b0101, width: 1, radix: 2},
        {token: 'op', str: ','},
        {token: 'num', num: 0b11111111, width: 1, radix: 2},
      ]]);
    });

    it('should treat ; as a comment to end of line', async function() {
      expect(await tokenize('  lda #1 ; sta $2\n  nop\n')).toEqual([
        [{token: 'ident', str: 'lda'}, {token: 'op', str: '#'},
         {token: 'num', num: 1, radix: 10}],
        [{token: 'ident', str: 'nop'}],
      ]);
    });

    it('should treat newlines as statement terminators', async function() {
      expect(await tokenize('  nop\n  nop\n')).toEqual([
        [{token: 'ident', str: 'nop'}],
        [{token: 'ident', str: 'nop'}],
      ]);
    });

    it('should read a leading-zero number as decimal', async function() {
      expect(await tokenize('  .byte 010\n')).toEqual([[
        {token: 'cs', str: '.byte', rawStr: '.byte'},
        {token: 'num', num: 10, radix: 10},
      ]]);
    });

    it('should lex # as an operator', async function() {
      expect(await tokenize('  lda #$12\n')).toEqual([[
        {token: 'ident', str: 'lda'}, {token: 'op', str: '#'},
        {token: 'num', num: 0x12, width: 1, radix: 16},
      ]]);
    });
  });
});
