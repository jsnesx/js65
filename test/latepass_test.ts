
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {buildLinkTimeEnv} from '../src/latepass.ts';
import type {Module, Segment, Symbol} from '../src/module.ts';

function chunk(segments: string[]) {
  return {segments, data: new Uint8Array(0)};
}

function exported(name: string, chunkIndex: number): Symbol {
  return {export: name, expr: {op: 'num', num: 0, meta: {chunk: chunkIndex}}};
}

function moduleWith(chunks: string[][], symbols: Symbol[]): Module {
  return {chunks: chunks.map(chunk), symbols};
}

describe('buildLinkTimeEnv', function() {
  it('resolves to zp when every candidate segment is zp', function() {
    const modules = [moduleWith([['ZP']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['ZP', {name: 'ZP', addressing: 1}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBe(1);
  });

  it('resolves to abs when a segment does not declare zp addressing', function() {
    const modules = [moduleWith([['CODE']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['CODE', {name: 'CODE'}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBe(2);
  });

  it('errors naming the segments when a pool/mirror chunk spans zp and non-zp', function() {
    const modules = [moduleWith([['ZP', 'CODE']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['ZP', {name: 'ZP', addressing: 1}],
      ['CODE', {name: 'CODE'}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(() => env.addrSize('foo')).toThrow(/ZP, CODE/);
  });

  it('returns undefined when the symbol is not exported by any module', function() {
    const modules = [moduleWith([['CODE']], [])];
    const segments = new Map<string, Segment>([['CODE', {name: 'CODE'}]]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBeUndefined();
  });

  it('returns undefined for an exported symbol that is not a chunk address', function() {
    const modules = [moduleWith([['CODE']],
        [{export: 'foo', expr: {op: 'num', num: 5}}])];
    const segments = new Map<string, Segment>([['CODE', {name: 'CODE'}]]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBeUndefined();
  });

  it('resolves bank when every candidate segment agrees', function() {
    const modules = [moduleWith([['BANK1']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['BANK1', {name: 'BANK1', bank: 3}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.bank('foo')).toBe(3);
  });

  it('errors naming the segments when candidate banks disagree', function() {
    const modules = [moduleWith([['BANK1', 'BANK2']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['BANK1', {name: 'BANK1', bank: 1}],
      ['BANK2', {name: 'BANK2', bank: 2}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(() => env.bank('foo')).toThrow(/BANK1, BANK2/);
  });

  it('ignores a candidate segment with no declared bank instead of erroring', function() {
    const modules = [moduleWith([['BANK1', 'UNBANKED']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['BANK1', {name: 'BANK1', bank: 1}],
      ['UNBANKED', {name: 'UNBANKED'}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.bank('foo')).toBe(1);
  });

  it('returns undefined when a candidate segment is not in the merged table', function() {
    const modules = [moduleWith([['GHOST']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>();
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBeUndefined();
  });

  describe('segmentBank', function() {
    it('resolves bank when every candidate segment agrees', function() {
      const segments = new Map<string, Segment>([
        ['BANK1', {name: 'BANK1', bank: 3}],
      ]);
      const env = buildLinkTimeEnv([], segments);
      expect(env.segmentBank(['BANK1'])).toBe(3);
    });

    it('errors naming the segments when candidate banks disagree', function() {
      const segments = new Map<string, Segment>([
        ['BANK1', {name: 'BANK1', bank: 1}],
        ['BANK2', {name: 'BANK2', bank: 2}],
      ]);
      const env = buildLinkTimeEnv([], segments);
      expect(() => env.segmentBank(['BANK1', 'BANK2'])).toThrow(/BANK1, BANK2/);
    });

    it('returns undefined when a candidate segment name is absent from the merged table', function() {
      const segments = new Map<string, Segment>();
      const env = buildLinkTimeEnv([], segments);
      expect(env.segmentBank(['GHOST'])).toBeUndefined();
    });
  });
});
