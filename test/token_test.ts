
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import { Token } from '../src/token.ts';
import * as Tokens from '../src/token.ts';

const {LP, LB, RP, RB} = Tokens;

describe('Token', function() {
  describe('Tokens.eq', function() {
    it('should return true for different instances', function() {
      expect(Tokens.eq(op(':'), op(':'))).toBe(true);
      expect(Tokens.eq(str('x'), str('x'))).toBe(true);
      expect(Tokens.eq(ident('x'), ident('x'))).toBe(true);
      expect(Tokens.eq(cs('.x'), cs('.x'))).toBe(true);
      expect(Tokens.eq(num(1), num(1))).toBe(true);
    });
    it('should return false for different token types', function() {
      expect(Tokens.eq(str('x'), ident('x'))).toBe(false);
    });
    it('should return false for different operators', function() {
      expect(Tokens.eq(op('::'), op(':'))).toBe(false);
    });
    it('should return false for different numbers', function() {
      expect(Tokens.eq(num(1), num(2))).toBe(false);
    });
    it('should return false for different strings', function() {
      expect(Tokens.eq(str('x'), str('y'))).toBe(false);
    });
    it('should return false for different identifiers', function() {
      expect(Tokens.eq(ident('x'), ident('y'))).toBe(false);
    });
    it('should return false for different dirctives', function() {
      expect(Tokens.eq(cs('.x'), cs('.y'))).toBe(false);
    });
    it('should return false for all groups', function() {
      expect(Tokens.eq(grp(), grp())).toBe(false);
    });
    it('should return false any undefined', function() {
      expect(Tokens.eq(undefined, num(1))).toBe(false);
      expect(Tokens.eq(num(1), undefined)).toBe(false);
      expect(Tokens.eq(undefined, undefined)).toBe(false);
    });
  });
  describe('Tokens.match', function() {
    it('should return true for different instances', function() {
      expect(Tokens.match(op(':'), op(':'))).toBe(true);
      expect(Tokens.match(str('x'), str('x'))).toBe(true);
      expect(Tokens.match(ident('x'), ident('x'))).toBe(true);
      expect(Tokens.match(cs('.x'), cs('.x'))).toBe(true);
      expect(Tokens.match(num(1), num(1))).toBe(true);
    });
    it('should return false for different token types', function() {
      expect(Tokens.match(str('x'), ident('x'))).toBe(false);
    });
    it('should return false for different operators', function() {
      expect(Tokens.match(op('::'), op(':'))).toBe(false);
    });
    it('should return true for different numbers', function() {
      expect(Tokens.match(num(1), num(2))).toBe(true);
    });
    it('should return true for different strings', function() {
      expect(Tokens.match(str('x'), str('y'))).toBe(true);
    });
    it('should return false for different identifiers', function() {
      expect(Tokens.match(ident('x'), ident('y'))).toBe(false);
    });
    it('should return false for different directives', function() {
      expect(Tokens.match(cs('.x'), cs('.y'))).toBe(false);
    });
    it('should return true for any groups', function() {
      expect(Tokens.match(grp(num(1)), grp(str('x')))).toBe(true);
    });
  });
  describe('Tokens.identsFromCList', function() {
    it('should return empty for an empty list', function() {
      expect(Tokens.identsFromCList([])).toEqual([]);
    });
    it('should return a single identifier from a singleton list', function() {
      expect(Tokens.identsFromCList([ident('x')])).toEqual(['x']);
    });
    it('should return two identifiers', function() {
      expect(Tokens.identsFromCList([ident('x'), op(','), ident('y')]))
          .toEqual(['x', 'y']);
    });
    it('should throw from bad separator', function() {
      expect(() => Tokens.identsFromCList([ident('x'), op(':'), ident('y')]))
          .toThrow(/Expected comma: :/);
    });
    it('should throw from extra identifier', function() {
      expect(() => Tokens.identsFromCList([ident('x'), ident('y')]))
          .toThrow(/Expected comma: y/);
    });
    it('should throw from non-identifier', function() {
      expect(() => Tokens.identsFromCList([ident('x'), op(','), cs('.y')]))
          .toThrow(/Expected identifier: .y/i);
    });
  });
  describe('Tokens.findBalanced', function() {
    it('should find a close paren', function() {
      expect(Tokens.findBalanced([ident('x'), LP, num(1), RP, num(2)], 1))
          .toBe(3);
    });
    it('should find a close square bracket', function() {
      expect(Tokens.findBalanced([ident('x'), LB, num(1), RB, num(2)], 1))
          .toBe(3);
    });
    it('should skip over nested balanced groups', function() {
      expect(Tokens.findBalanced([num(1), LP, RB, LP, RP, RB, RP, num(2)], 1))
          .toBe(6);
    });
    it('should throw on a non-grouping token', function() {
      expect(() => Tokens.findBalanced([num(1), LP, RP, num(2)], 0))
          .toThrow(/non-grouping token/);
    });
    it('should return -1 on a non-balanced group', function() {
      expect(Tokens.findBalanced([num(1), LP, num(2)], 1)).toBe(-1);
    });
  });
  describe('Tokens.parseArgList', function() {
    it('should return a single empty arg for an empty list', function() {
      expect(Tokens.parseArgList([])).toEqual([[]]);
    });
    it('should return a singleton token', function() {
      expect(Tokens.parseArgList([num(1)])).toEqual([[num(1)]]);
    });
    it('should return multiple tokens in an arg', function() {
      expect(Tokens.parseArgList([num(1), num(2)])).toEqual([[num(1), num(2)]]);
    });
    it('should split args on comma', function() {
      expect(Tokens.parseArgList([num(1), op(','), num(2)]))
          .toEqual([[num(1)], [num(2)]]);
    });
    it('should skip a nested comma', function() {
      expect(Tokens.parseArgList([num(1), LP, op(','), RP, num(2)]))
          .toEqual([[num(1), LP, op(','), RP, num(2)]]);
    });
    it('should ignore square brackets', function() {
      expect(Tokens.parseArgList([num(1), LB, op(','), RB, num(2)]))
          .toEqual([[num(1), LB], [RB, num(2)]]);
    });
    it('should fail to parse unbalanced parentheses', function() {
      expect(() => Tokens.parseArgList([num(1), RP, op(','), LP, num(2)]))
          .toThrow(/Unbalanced paren/);
    });
  });
  describe('Tokens.count', function() {
    it('should return 0 for an empty list', function() {
      expect(Tokens.count([])).toBe(0);
    });
    it('should return 1 for an singleton list', function() {
      expect(Tokens.count([LP])).toBe(1);
    }); 
    it('should return 2 for an doubleton list', function() {
      expect(Tokens.count([LP, RP])).toBe(2);
    });
    it('should recurse into groups', function() {
      expect(Tokens.count([grp(LP, RP), grp(LB, RB)])).toBe(8);
    });
  });
  describe('Tokens.isRegister', function() {
    it('should return true for registers', function() {
      expect(Tokens.isRegister(ident('a'), 'a')).toBe(true);
      expect(Tokens.isRegister(ident('A'), 'a')).toBe(true);
      expect(Tokens.isRegister(ident('x'), 'x')).toBe(true);
      expect(Tokens.isRegister(ident('X'), 'x')).toBe(true);
      expect(Tokens.isRegister(ident('y'), 'y')).toBe(true);
      expect(Tokens.isRegister(ident('Y'), 'y')).toBe(true);
    });
    it('should return false for wrong register', function() {
      expect(Tokens.isRegister(ident('a'), 'x')).toBe(false);
      expect(Tokens.isRegister(ident('x'), 'a')).toBe(false);
    });
    // TODO - fake registers return true, but TS won't allow passing it
  });
});

function ident(str: string): Token {
  return {token: 'ident', str};
}
function str(str: string): Token {
  return {token: 'str', str};
}
function op(str: string): Token {
  return {token: 'op', str};
}
function cs(str: string): Token {
  return {token: 'cs', str};
}
function num(num: number): Token {
  return {token: 'num', num};
}
function grp(...inner: Token[]): Token {
  return {token: 'grp', inner};
}
