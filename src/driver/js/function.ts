// SPDX-License-Identifier: MPL-2.0

import type { JsEngine } from './engine.ts';

export const functionEngine: JsEngine = {
  run(code, scope) {
    const names = Object.keys(scope);
    const fn = new Function(...names, `"use strict";\n${code}`);
    fn(...names.map(n => scope[n]));
  },
};
