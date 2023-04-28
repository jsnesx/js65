import {describe, it} from 'std/testing/bdd.ts';
import {expect} from 'chai';
import {Macro} from '../macro.ts';
import {Token} from '../token.ts';
import {Tokenizer} from '../tokenizer.ts';
import * as util from '../util.ts';

const [] = [util];

const nullId = {next() { return 1; }};

describe('Macro', function() {

  function testExpand(macro: string, input: string, output: string) {
    const mac = Macro.from(...source(tok(macro)));
    const code = tok(input)[0];
    expect(mac.expand(code, nullId).map(ts => ts.map(strip)))
        .to.eql(tok(output));
  }

  describe('with no parameters', function() {
    it('should expand', function() {
      testExpand('.macro foo\n  .bar baz\n  qux\n.endmacro',
                 'foo',
                 '  .bar baz\n  qux');
    });
    it('should fail if parameters given', function() {
      expect(() => testExpand('.macro foo\n  .bar baz\n.endmacro',
                              'foo bar', ''))
          .to.throw(Error, /Too many macro parameters: bar/);
    });
  });
  describe('with one parameter', function() {
    it('should expand with no parameters', function() {
      testExpand('.macro foo a\n  .bar a\n  a qux\n.endmacro',
                 'foo',
                 '  .bar\n  qux');
    });
    it('should recurse into groups', function() {
      testExpand('.macro foo a\n  .bar a\n  {a qux}\n.endmacro',
                 'foo x y',
                 '  .bar x y\n  {x y qux}');
    });
    it('should fail if two parameters given', function() {
      expect(() => testExpand('.macro foo a\n  .bar a\n.endmacro',
                              'foo bar, baz', ''))
          .to.throw(Error, /Too many macro parameters: baz/);
    });
  });
});

function strip(t: Token): Token {
  delete t.source;
  if (t.token === 'grp') t.inner.map(strip);
  return t;
};

function tok(str: string): Token[][] {
  const t = new Tokenizer(str);
  const out = [];
  for (let line = t.next(); line; line = t.next()) {
    out.push(line.map(strip));
  }
  return out;
}

function source<T>(ts: T[][]): [T[], {next(): T[]}] {
  let i = 1;
  return [ts[0], {next() { return ts[i++] || []; }}];
}
