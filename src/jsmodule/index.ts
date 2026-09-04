// SPDX-License-Identifier: MPL-2.0

import * as Bmp from './bmp.generated.ts';
import * as Png from './png.generated.ts';
import { JS_MODULE_MAPS } from './maps.generated.ts';
import { parseSourceMap, type SourceMap } from './sourcemap.ts';

export const JS_MODULES: Map<string, string> = new Map(
  [
    ['bmp', Bmp.text],
    ['png', Png.text],
  ]
);

export function jsModuleNames(): string[] {
  return [...JS_MODULES.keys()].sort();
}

const parsedMaps = new Map<string, SourceMap | undefined>();

/**
 * Parsed source map for a bundled module, or undefined when this build shipped
 * none (browser bundles are generated with --no-maps).
 */
export function jsModuleMap(name: string): SourceMap | undefined {
  if (!parsedMaps.has(name)) {
    parsedMaps.set(name, parseSourceMap(JS_MODULE_MAPS.get(name)));
  }
  return parsedMaps.get(name);
}
