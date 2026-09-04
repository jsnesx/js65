// SPDX-License-Identifier: MPL-2.0

import * as Bmp from './bmp.generated.ts';
import * as Png from './png.generated.ts';

export const JS_MODULES: Map<string, string> = new Map(
  [
    ['bmp', Bmp.text],
    ['png', Png.text],
  ]
);

export function jsModuleNames(): string[] {
  return [...JS_MODULES.keys()].sort();
}
