// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect, afterAll} from 'bun:test';
import {jsEngine, setJsEngine, type JsEngine} from '../src/driver/js/engine.ts';
import {functionEngine} from '../src/driver/js/function.ts';

// The registry is module-global; nothing registers one under bun test, so leave it that way.
afterAll(() => setJsEngine(undefined));

describe('functionEngine', () => {
  it('binds each scope entry as a top-level name', () => {
    const out: number[] = [];
    functionEngine.run('out.push(a + b);', {out, a: 1, b: 2});
    expect(out).toEqual([3]);
  });

  it('binds an object the block can call methods on', () => {
    const bytes: number[] = [];
    const a = {byte: (v: number) => { bytes.push(v); return a; }};
    functionEngine.run('for (const t of tiles) a.byte(t);', {a, tiles: [1, 2, 3]});
    expect(bytes).toEqual([1, 2, 3]);
  });

  it('runs in strict mode, so an undeclared assignment throws', () => {
    expect(() => functionEngine.run('leaked = 1;', {}))
        .toThrow(/leaked is not defined/);
  });

  it('propagates a runtime error from the block', () => {
    expect(() => functionEngine.run('throw new Error("boom");', {}))
        .toThrow('boom');
  });

  it('propagates a syntax error from the block', () => {
    expect(() => functionEngine.run('this is not javascript', {})).toThrow(SyntaxError);
  });

  it('reports a CSP block rather than the raw EvalError', () => {
    const real = globalThis.Function;
    // A page without 'unsafe-eval' fails here at construction.
    globalThis.Function = function() {
      throw new EvalError(`call to Function() blocked by CSP`);
    } as unknown as FunctionConstructor;
    try {
      expect(() => functionEngine.run('void 0;', {}))
          .toThrow(/blocked by this page's Content-Security-Policy/);
    } finally {
      globalThis.Function = real;
    }
  });

  it('does not leak bindings between two runs', () => {
    functionEngine.run('const local = 5;', {});
    expect(() => functionEngine.run('void local;', {}))
        .toThrow(/local is not defined/);
  });
});

describe('the engine registry', () => {
  // A frontend without eval never calls setJsEngine, and stage 0 reports that.
  it('is empty until a frontend registers one', () => {
    setJsEngine(undefined);
    expect(jsEngine()).toBeUndefined();
  });

  it('hands back whatever the frontend registered', () => {
    setJsEngine(functionEngine);
    expect(jsEngine()).toBe(functionEngine);
  });

  it('lets a frontend supply its own implementation', () => {
    const calls: string[] = [];
    const fake: JsEngine = {run: (code) => { calls.push(code); }};
    setJsEngine(fake);
    jsEngine()!.run('anything', {});
    expect(calls).toEqual(['anything']);
  });
});
