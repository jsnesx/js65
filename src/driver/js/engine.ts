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

let engine: JsEngine | undefined;

export function setJsEngine(e: JsEngine | undefined): void {
  engine = e;
}

/** Undefined when the frontend registered none; stage 0 turns that into an error. */
export function jsEngine(): JsEngine | undefined {
  return engine;
}
