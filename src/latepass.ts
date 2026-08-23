
// SPDX-License-Identifier: MPL-2.0

import { fail } from './error.ts';
import type { Expr } from './expr.ts';
import type { Module, Segment } from './module.ts';

export interface LinkTimeEnv {
  /** 1 for zeropage, 2 for absolute, undefined if unknown. */
  addrSize(sym: string): 1|2|undefined;
  /** Bank of the segment holding the symbol, if declared. */
  bank(sym: string): number|undefined;
}

/** A symbol's defining chunk, found by walking the loaded modules. */
function findChunk(name: string, modules: readonly Module[]):
    {segments: readonly string[], expr: Expr}|undefined {
  for (const mod of modules) {
    for (const symbol of mod.symbols ?? []) {
      if (symbol.export !== name) continue;
      const chunkIndex = symbol.expr?.meta?.chunk;
      if (chunkIndex == null) return undefined; // exported but not an address
      const chunk = mod.chunks?.[chunkIndex];
      if (!chunk) return undefined;
      return {segments: chunk.segments, expr: symbol.expr!};
    }
  }
  return undefined;
}

// Helper function for finding info about a sym from the total
// list of modules and segments known at link time.
function resolve<T>(name: string, modules: readonly Module[],
                     segments: ReadonlyMap<string, Segment>,
                     pick: (seg: Segment) => T|undefined): T|undefined {
  const found = findChunk(name, modules);
  if (!found) return undefined;
  let answer: T|undefined;
  const disagreeing: string[] = [];
  for (const segName of found.segments) {
    const seg = segments.get(segName);
    if (!seg) continue;
    const value = pick(seg);
    if (value === undefined) continue;
    if (answer === undefined) answer = value;
    else if (value !== answer) disagreeing.push(segName);
  }
  if (disagreeing.length) {
    fail(`${name}: disagreement across segments ${found.segments.join(', ')}`,
         found.expr);
  }
  return answer;
}

/** Builds a LinkTimeEnv from the merged segment table and loaded modules. */
export function buildLinkTimeEnv(
    modules: readonly Module[],
    segments: ReadonlyMap<string, Segment>): LinkTimeEnv {
  return {
    addrSize: name => resolve(name, modules, segments,
        seg => seg.addressing === 1 ? 1 : 2),
    bank: name => resolve(name, modules, segments, seg => seg.bank),
  };
}
