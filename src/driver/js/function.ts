// SPDX-License-Identifier: MPL-2.0

import type { JsEngine } from './engine.ts';

// need unsafe-eval to make a Function
function isCspRefusal(err: unknown): boolean {
  return err instanceof EvalError ||
      /content security policy|unsafe-eval|blocked by csp/i.test((err as Error)?.message ?? '');
}

export const functionEngine: JsEngine = {
  run(code, scope) {
    const names = Object.keys(scope);
    let fn;
    try {
      fn = new Function(...names, `"use strict";\n${code}`);
    } catch (err) {
      if (isCspRefusal(err)) {
        throw new Error(`JavaScript is blocked by this page's Content-Security-Policy`);
      }
      throw err;
    }
    fn(...names.map(n => scope[n]));
  },
};
