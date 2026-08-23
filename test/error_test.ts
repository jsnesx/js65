
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {ErrorCollector} from '../src/error.ts';

describe('ErrorCollector provisional passes', function() {
  it('discard drops only the provisional messages', function() {
    const c = new ErrorCollector();
    c.add('warning', 'before');
    c.openAsmPass();
    c.add('warning', 'during 1');
    c.add('warning', 'during 2');
    c.discardAsmPass();
    c.add('warning', 'after');
    expect(c.getMessages().map(m => m.message)).toEqual(['before', 'after']);
  });

  it('flush keeps the provisional messages', function() {
    const c = new ErrorCollector();
    c.add('warning', 'before');
    c.openAsmPass();
    c.add('warning', 'during');
    c.flushAsmPass();
    c.add('warning', 'after');
    expect(c.getMessages().map(m => m.message))
        .toEqual(['before', 'during', 'after']);
  });

  it('rejects nesting', function() {
    const c = new ErrorCollector();
    c.openAsmPass();
    expect(() => c.openAsmPass()).toThrow();
  });

  it('rejects discard or flush with no open provisional pass', function() {
    const c = new ErrorCollector();
    expect(() => c.discardAsmPass()).toThrow();
    expect(() => c.flushAsmPass()).toThrow();
  });

  it('discarding a provisional pass restores the error count for the limit', function() {
    const c = new ErrorCollector(3);
    c.openAsmPass();
    c.add('error', 'a');
    c.add('error', 'b');
    c.discardAsmPass();
    // Budget is back to fresh: 2 errors fit, the 3rd trips the limit.
    c.add('error', 'c');
    c.add('error', 'd');
    expect(() => c.add('error', 'e')).toThrow();
  });

  it('flushing a provisional pass keeps the error count charged against the limit', function() {
    const c = new ErrorCollector(3);
    c.openAsmPass();
    c.add('error', 'a');
    c.add('error', 'b');
    c.flushAsmPass();
    // Budget was already spent in the pass; the next error trips it.
    expect(() => c.add('error', 'c')).toThrow();
  });
});
