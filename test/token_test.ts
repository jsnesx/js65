import {describe, it} from 'std/testing/bdd.ts';
import {expect} from 'chai';
import { Token } from '/src/token.ts';
import * as Tokens from '/src/token.ts';

const {LP, LB, RP, RB} = Tokens;

describe('Token', function() {
  describe('Tokens.eq', function() {
    it('should return true for different instances', function() {
      expect(Tokens.eq(op(':'), op(':'))).to.equal(true);
      expect(Tokens.eq(str('x'), str('x'))).to.equal(true);
      expect(Tokens.eq(ident('x'), ident('x'))).to.equal(true);
      expect(Tokens.eq(cs('.x'), cs('.x'))).to.equal(true);
      expect(Tokens.eq(num(1), num(1))).to.equal(true);
    });
    it('should return false for different token types', function() {
      expect(Tokens.eq(str('x'), ident('x'))).to.equal(false);
    });
    it('should return false for different operators', function() {
      expect(Tokens.eq(op('::'), op(':'))).to.equal(false);
    });
    it('should return false for different numbers', function() {
      expect(Tokens.eq(num(1), num(2))).to.equal(false);
    });
    it('should return false for different strings', function() {
      expect(Tokens.eq(str('x'), str('y'))).to.equal(false);
    });
    it('should return false for different identifiers', function() {
      expect(Tokens.eq(ident('x'), ident('y'))).to.equal(false);
    });
    it('should return false for different dirctives', function() {
      expect(Tokens.eq(cs('.x'), cs('.y'))).to.equal(false);
    });
    it('should return false for all groups', function() {
      expect(Tokens.eq(grp(), grp())).to.equal(false);
    });
    it('should return false any undefined', function() {
      expect(Tokens.eq(undefined, num(1))).to.equal(false);
      expect(Tokens.eq(num(1), undefined)).to.equal(false);
      expect(Tokens.eq(undefined, undefined)).to.equal(false);
    });
  });
  describe('Tokens.match', function() {
    it('should return true for different instances', function() {
      expect(Tokens.match(op(':'), op(':'))).to.equal(true);
      expect(Tokens.match(str('x'), str('x'))).to.equal(true);
      expect(Tokens.match(ident('x'), ident('x'))).to.equal(true);
      expect(Tokens.match(cs('.x'), cs('.x'))).to.equal(true);
      expect(Tokens.match(num(1), num(1))).to.equal(true);
    });
    it('should return false for different token types', function() {
      expect(Tokens.match(str('x'), ident('x'))).to.equal(false);
    });
    it('should return false for different operators', function() {
      expect(Tokens.match(op('::'), op(':'))).to.equal(false);
    });
    it('should return true for different numbers', function() {
      expect(Tokens.match(num(1), num(2))).to.equal(true);
    });
    it('should return true for different strings', function() {
      expect(Tokens.match(str('x'), str('y'))).to.equal(true);
    });
    it('should return false for different identifiers', function() {
      expect(Tokens.match(ident('x'), ident('y'))).to.equal(false);
    });
    it('should return false for different directives', function() {
      expect(Tokens.match(cs('.x'), cs('.y'))).to.equal(false);
    });
    it('should return true for any groups', function() {
      expect(Tokens.match(grp(num(1)), grp(str('x')))).to.equal(true);
    });
  });
  describe('Tokens.identsFromCList', function() {
    it('should return empty for an empty list', function() {
      expect(Tokens.identsFromCList([])).to.eql([]);
    });
    it('should return a single identifier from a singleton list', function() {
      expect(Tokens.identsFromCList([ident('x')])).to.eql(['x']);
    });
    it('should return two identifiers', function() {
      expect(Tokens.identsFromCList([ident('x'), op(','), ident('y')]))
          .to.eql(['x', 'y']);
    });
    it('should throw from bad separator', function() {
      expect(() => Tokens.identsFromCList([ident('x'), op(':'), ident('y')]))
          .to.throw(Error, /Expected comma: :/);
    });
    it('should throw from extra identifier', function() {
      expect(() => Tokens.identsFromCList([ident('x'), ident('y')]))
          .to.throw(Error, /Expected comma: y/);
    });
    it('should throw from non-identifier', function() {
      expect(() => Tokens.identsFromCList([ident('x'), op(','), cs('.y')]))
          .to.throw(Error, /Expected identifier: .y/i);
    });
  });
  describe('Tokens.findBalanced', function() {
    it('should find a close paren', function() {
      expect(Tokens.findBalanced([ident('x'), LP, num(1), RP, num(2)], 1))
          .to.equal(3);
    });
    it('should find a close square bracket', function() {
      expect(Tokens.findBalanced([ident('x'), LB, num(1), RB, num(2)], 1))
          .to.equal(3);
    });
    it('should skip over nested balanced groups', function() {
      expect(Tokens.findBalanced([num(1), LP, RB, LP, RP, RB, RP, num(2)], 1))
          .to.equal(6);
    });
    it('should throw on a non-grouping token', function() {
      expect(() => Tokens.findBalanced([num(1), LP, RP, num(2)], 0))
          .to.throw(Error, /non-grouping token/);
    });
    it('should return -1 on a non-balanced group', function() {
      expect(Tokens.findBalanced([num(1), LP, num(2)], 1)).to.equal(-1);
    });
  });
  describe('Tokens.parseArgList', function() {
    it('should return a single empty arg for an empty list', function() {
      expect(Tokens.parseArgList([])).to.eql([[]]);
    });
    it('should return a singleton token', function() {
      expect(Tokens.parseArgList([num(1)])).to.eql([[num(1)]]);
    });
    it('should return multiple tokens in an arg', function() {
      expect(Tokens.parseArgList([num(1), num(2)])).to.eql([[num(1), num(2)]]);
    });
    it('should split args on comma', function() {
      expect(Tokens.parseArgList([num(1), op(','), num(2)]))
          .to.eql([[num(1)], [num(2)]]);
    });
    it('should skip a nested comma', function() {
      expect(Tokens.parseArgList([num(1), LP, op(','), RP, num(2)]))
          .to.eql([[num(1), LP, op(','), RP, num(2)]]);
    });
    it('should ignore square brackets', function() {
      expect(Tokens.parseArgList([num(1), LB, op(','), RB, num(2)]))
          .to.eql([[num(1), LB], [RB, num(2)]]);
    });
    it('should fail to parse unbalanced parentheses', function() {
      expect(() => Tokens.parseArgList([num(1), RP, op(','), LP, num(2)]))
          .to.throw(Error, /Unbalanced paren/);
    });
  });
  describe('Tokens.count', function() {
    it('should return 0 for an empty list', function() {
      expect(Tokens.count([])).to.equal(0);
    });
    it('should return 1 for an singleton list', function() {
      expect(Tokens.count([LP])).to.equal(1);
    }); 
    it('should return 2 for an doubleton list', function() {
      expect(Tokens.count([LP, RP])).to.equal(2);
    });
    it('should recurse into groups', function() {
      expect(Tokens.count([grp(LP, RP), grp(LB, RB)])).to.equal(8);
    });
  });
  describe('Tokens.isRegister', function() {
    it('should return true for registers', function() {
      expect(Tokens.isRegister(ident('a'), 'a')).to.equal(true);
      expect(Tokens.isRegister(ident('A'), 'a')).to.equal(true);
      expect(Tokens.isRegister(ident('x'), 'x')).to.equal(true);
      expect(Tokens.isRegister(ident('X'), 'x')).to.equal(true);
      expect(Tokens.isRegister(ident('y'), 'y')).to.equal(true);
      expect(Tokens.isRegister(ident('Y'), 'y')).to.equal(true);
    });
    it('should return false for wrong register', function() {
      expect(Tokens.isRegister(ident('a'), 'x')).to.equal(false);
      expect(Tokens.isRegister(ident('x'), 'a')).to.equal(false);
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
