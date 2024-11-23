
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';

import { Token } from '../src/token.ts';
import * as Tokens from '../src/token.ts';
import {Tokenizer, Options} from '../src/tokenizer.ts';
import * as util from '../src/util.ts';
import { TokenStream } from '../src/tokenstream.ts';

const [_] = [util];

//const MATCH = Symbol();

async function tokenize(str: string, opts: Options = {}): Promise<Token[][]> {
  const out : Token[][] = [];
  const tokenizer = new Tokenizer(str, 'input.s', opts);
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
       {token: 'op', str: '#'}, {token: 'num', num: 0x1f, width: 1}],
      [{token: 'cs', str: '.org'}, {token: 'num', num: 0x1c, width: 1},
       {token: 'op', str: ':'}, {token: 'num', num: 0x1234, width: 2}],
      [{token: 'cs', str: '.ifdef'}, {token: 'ident', str: 'XX'}],
      [{token: 'cs', str: '.define'}, {token: 'ident', str: 'YY'}],
      [{token: 'cs', str: '.define'}, {token: 'ident', str: 'YYZ'},
       {token: 'num', num: 0b10101100, width: 1}],
      [{token: 'ident', str: 'pla'}],
      [{token: 'ident', str: 'sta'},
       {token: 'lp'}, {token: 'num', num: 0x11, width: 1}, {token: 'rp'},
       {token: 'op', str: ','}, {token: 'ident', str: 'y'}],
      [{token: 'cs', str: '.elseif'}, {token: 'ident', str: 'YY'}],
      [{token: 'ident', str: 'pha'}],
      [{token: 'cs', str: '.endif'}],
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
        {token: 'op', str: '#'}, {token: 'num', num: 0x03}],
      [{token: 'ident', str: 'lda'},
        {token: 'op', str: '#'}, {token: 'num', num: 0x05}],
      [{token: 'ident', str: 'sta'},
        {token: 'num', num: 0x04, width: 1}],
    ])
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
      [{token: 'cs', str: '.assert'}, {token: 'op', str: '*'},
       {token: 'op', str: '='}, {token: 'num', num: 0x0c, width: 1},
       {token: 'op', str: ':'}, {token: 'num', num: 0x8000, width: 2}],
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
      [{token: 'num', num: 123},
       {token: 'num', num: 0o123},
       {token: 'num', num: 0b10110, width: 1},
       {token: 'num', num: 0x123d, width: 2}],
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

  it('should fail to parse a bad hex number', function() {
    expect(tokenize('  adc $1g')).rejects.toThrow(/Bad hex number.*at input.s:1:6 near '\$1g'/s);
  });

  it('should fail to parse a bad decimal number', function() {
    expect(tokenize('  12a')).rejects.toThrow(/Bad decimal.*at input.s:1:2 near '12a'/s);
  });

  it('should fail to parse a bad octal number', function() {
    expect(tokenize('  018')).rejects.toThrow(/Bad octal.*at input.s:1:2 near '018'/s);
  });

  it('should fail to parse a bad binary number', function() {
    expect(tokenize('  %012')).rejects.toThrow(/Bad binary.*at input.s:1:2 near '%012'/s);
  });

  it('should fail to parse a bad character', function() {
    expect(tokenize('  `abc')).rejects.toThrow(/Syntax error.*at input.s:1:2/s);
  });

  it('should fail to parse a bad string', function() {
    expect(tokenize('  "abc')).rejects.toThrow(/EOF while looking for "/);
  });

  it('should not parse .2 as a directive', function() {
    expect(tokenize(' .2')).rejects.toThrow(/Syntax error.*at input.s:1:1/s);
  });
});
