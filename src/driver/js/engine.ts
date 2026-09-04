// SPDX-License-Identifier: MPL-2.0

/**
 * When possible, a frontend can provide an `eval` engine for running
 * the JS preprocessor.
 */
export interface JsEngine {
  /**
   * Evaluates `code` with `scope`'s entries bound as top-level names.
   * Throws on a syntax or runtime error
   */
  run(code: string, scope: Record<string, unknown>): void;
}

export const JS_SOURCE_URL = 'js65-jsblock';

export interface JsFrame {
  name?: string;
  /** 1-based line within `code`. */
  line: number;
  /** 1-based column within that line. */
  column: number;
}

const FRAMES = Symbol.for('js65.jsFrames');

export function setJsFrames(err: unknown, frames: readonly JsFrame[]): void {
  if (!frames.length || !err || typeof err !== 'object') return;
  Object.defineProperty(err, FRAMES, {value: frames, configurable: true});
}

/** Try to load the frames that the engine may have set with `setJsFrames` */
export function getJsFrames(err: unknown): readonly JsFrame[] | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return (err as Record<symbol, readonly JsFrame[] | undefined>)[FRAMES];
}

let engine: JsEngine | undefined;

export function setJsEngine(e: JsEngine | undefined): void {
  engine = e;
}

/** Undefined when the frontend registered none; stage 0 turns that into an error. */
export function jsEngine(): JsEngine | undefined {
  return engine;
}
