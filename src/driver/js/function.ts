// SPDX-License-Identifier: MPL-2.0

import {JS_SOURCE_URL, setJsFrames, type JsEngine, type JsFrame} from './engine.ts';

// need unsafe-eval to make a Function
function isCspRefusal(err: unknown): boolean {
  return err instanceof EvalError ||
      /content security policy|unsafe-eval|blocked by csp/i.test((err as Error)?.message ?? '');
}

function compile(code: string, names: readonly string[]): (...args: unknown[]) => void {
  return new Function(
      ...names, `"use strict";\n${code}\n//# sourceURL=${JS_SOURCE_URL}`) as
      (...args: unknown[]) => void;
}

// `at f (js65-jsblock:4:21)` (V8/JSC) and `f@js65-jsblock:4:21` (SpiderMonkey).
const FRAME_LINE = new RegExp(`${JS_SOURCE_URL}:(\\d+):(\\d+)`);
const FRAME_NAME = /^\s*at\s+([^\s(]+)\s*\(|^\s*([^@\s]+)@/;
// JSC points at the failing line of a compile this way while V8 reports no line at all.
const PARSE_LINE = /^\s*at <parse> \(:(\d+)\)/m;

let headerOffset: number | undefined;

/**
 * Measure the line overhead from the engine's Function, which is something that we
 * can't know how many lines it effectively adds. We do this with a quick throw
 * and count the number of lines till the first line of our code.
 */
function headerLines(): number {
  if (headerOffset !== undefined) return headerOffset;
  headerOffset = 0;
  try {
    compile('throw new Error("js65 probe");', [])();
  } catch (err) {
    const m = FRAME_LINE.exec((err as Error)?.stack ?? '');
    if (m) headerOffset = Number(m[1]) - 1;
  }
  return headerOffset;
}

/** Pulls the frames that belong to `code` out of an engine's stack trace. */
function framesOf(err: unknown): JsFrame[] {
  const stack = (err as Error)?.stack;
  if (typeof stack !== 'string') return [];
  const offset = headerLines();
  const frames: JsFrame[] = [];
  for (const raw of stack.split('\n')) {
    const m = FRAME_LINE.exec(raw);
    if (!m) continue;
    const line = Number(m[1]) - offset;
    if (line < 1) continue;
    const name = FRAME_NAME.exec(raw);
    frames.push({name: name?.[1] ?? name?.[2], line, column: Number(m[2])});
  }
  return frames;
}

export const functionEngine: JsEngine = {
  run(code, scope) {
    const names = Object.keys(scope);
    let fn;
    try {
      fn = compile(code, names);
    } catch (err) {
      if (isCspRefusal(err)) {
        throw new Error(`JavaScript is blocked by this page's Content-Security-Policy`);
      }
      const m = PARSE_LINE.exec((err as Error)?.stack ?? '');
      const line = m ? Number(m[1]) - headerLines() : 0;
      if (line >= 1) setJsFrames(err, [{line, column: 1}]);
      throw err;
    }
    try {
      fn(...names.map(n => scope[n]));
    } catch (err) {
      setJsFrames(err, framesOf(err));
      throw err;
    }
  },
};
