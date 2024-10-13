
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {Macro} from '../src/macro.ts';
import {Token} from '../src/token.ts';
import {Tokenizer} from '../src/tokenizer.ts';
import * as util from '../src/util.ts';

const [_] = [util];

const nullId = {next() { return 1; }};

describe('Macro', function() {

  async function testExpand(macro: string, input: string, output: string) {
    const toks = await tok(macro);
    const mac = await Macro.from(...source(toks));
    const code = (await tok(input))[0];
    expect(mac.expand(code, nullId).map(ts => ts.map(strip)))
        .toEqual(await tok(output));
  }

  describe('with no parameters', function() {
    it('should expand', async function() {
      await testExpand('.macro foo\n  .bar baz\n  qux\n.endmacro',
                 'foo',
                 '  .bar baz\n  qux');
    });
    it('should fail if parameters given', function() {
      expect(testExpand('.macro foo\n  .bar baz\n.endmacro',
                              'foo bar', ''))
          .rejects.toThrowError(/Too many macro parameters: bar/);
    });
  });
  describe('with one parameter', function() {
    it('should expand with no parameters', async function() {
      await testExpand('.macro foo a\n  .bar a\n  a qux\n.endmacro',
                 'foo',
                 '  .bar\n  qux');
    });
    it('should recurse into groups', async function() {
      await testExpand('.macro foo a\n  .bar a\n  {a qux}\n.endmacro',
                 'foo x y',
                 '  .bar x y\n  {x y qux}');
    });
    it('should fail if two parameters given', function() {
      expect(testExpand('.macro foo a\n  .bar a\n.endmacro',
                              'foo bar, baz', ''))
          .rejects.toThrowError(/Too many macro parameters: baz/);
    });
  });
});

function strip(t: Token): Token {
  delete t.source;
  if (t.token === 'grp') t.inner.map(strip);
  return t;
}

async function tok(str: string): Promise<Token[][]> {
  const t = new Tokenizer(str);
  const out : Token[][] = [];
  for (let line = await t.next(); line; line = await t.next()) {
    out.push(line.map(strip));
  }
  return out;
}

function source<T>(ts: T[][]): [T[], {next(): Promise<T[]>}] {
  let i = 1;
  return [ts[0], {async next() { return await Promise.resolve(ts[i++] || []); }}];
}
