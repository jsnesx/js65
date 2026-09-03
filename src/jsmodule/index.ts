// SPDX-License-Identifier: MPL-2.0

export const JS_MODULES: Map<string, string> = new Map();

export function jsModuleNames(): string[] {
  return [...JS_MODULES.keys()].sort();
}
