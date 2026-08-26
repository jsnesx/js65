
// SPDX-License-Identifier: MPL-2.0

import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import { ErrorCollector, fail, type AssemblerMessage } from './error.ts';
import type { Expr } from './expr.ts';
import type { Module, Segment } from './module.ts';
import * as Tokens from './token.ts';
import type { CancelSignal } from './libassembler.ts';

export interface LinkTimeEnv {
  /** 1 for zeropage, 2 for absolute, undefined if unknown. */
  addrSize(sym: string): 1|2|undefined;
  /** Bank of the segment holding the symbol, if declared. */
  bank(sym: string): number|undefined;
  /** Bank shared by every candidate segment, if declared and they agree. */
  segmentBank(segNames: readonly string[]): number|undefined;
  /** Address size (1 or 2) shared by every candidate segment, if they agree. */
  segmentAddrSize?(segNames: readonly string[]): 1|2|undefined;
  /** Segment list for local labels forward-referenced by an `.if` */
  localForwardRefs?: ReadonlyMap<string, readonly string[]>;
  /** Set if we can't resolve all conditionals in this pass */
  tolerateUnresolvedIf?: boolean;
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

/**
 * Picks a value shared by every candidate segment that declares one,
 * failing (naming the offending segments) if any two disagree.
 */
function resolveCandidates<T>(segNames: readonly string[],
                               segments: ReadonlyMap<string, Segment>,
                               pick: (seg: Segment) => T|undefined,
                               onDisagree: (disagreeing: string[]) => never): T|undefined {
  let answer: T|undefined;
  const disagreeing: string[] = [];
  for (const segName of segNames) {
    const seg = segments.get(segName);
    if (!seg) continue;
    const value = pick(seg);
    if (value === undefined) continue;
    if (answer === undefined) answer = value;
    else if (value !== answer) disagreeing.push(segName);
  }
  if (disagreeing.length) onDisagree(disagreeing);
  return answer;
}

// Helper function for finding info about a sym from the total
// list of modules and segments known at link time.
function resolve<T>(name: string, modules: readonly Module[],
                     segments: ReadonlyMap<string, Segment>,
                     pick: (seg: Segment) => T|undefined): T|undefined {
  const found = findChunk(name, modules);
  if (!found) return undefined;
  return resolveCandidates(found.segments, segments, pick, () => {
    fail(`${name}: disagreement across segments ${found.segments.join(', ')}`,
         found.expr);
  });
}

/** Builds a LinkTimeEnv from the merged segment table and loaded modules. */
export function buildLinkTimeEnv(
    modules: readonly Module[],
    segments: ReadonlyMap<string, Segment>): LinkTimeEnv {
  return {
    addrSize: name => resolve(name, modules, segments,
        seg => seg.addressing === 1 ? 1 : 2),
    bank: name => resolve(name, modules, segments, seg => seg.bank),
    segmentBank: segNames => resolveCandidates(segNames, segments,
        seg => seg.bank, () => {
          fail(`disagreement across segments ${segNames.join(', ')}`);
        }),
    segmentAddrSize: segNames => resolveCandidates(segNames, segments,
        seg => seg.addressing === 1 ? 1 : 2, () => {
          fail(`disagreement across segments ${segNames.join(', ')}`);
        }),
  };
}

/** Result of re-assembling a module from its recorded `lateAssembly` stream. */
export interface ReplayResult {
  /** Whether replay succeeded (no errors) */
  success: boolean;
  /** The re-assembled module */
  module: Module;
  /** Messages from the replayed pass */
  messages: AssemblerMessage[];
  /** How many assembler runs the replay needed. */
  scans: number;
}

function segmentsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Compares the names of `.if` conditions actually queried. */
function queriedSegmentsEqual(a: ReadonlyMap<string, readonly string[]>,
                              b: ReadonlyMap<string, readonly string[]>,
                              queried: ReadonlySet<string>): boolean {
  for (const name of queried) {
    const x = a.get(name), y = b.get(name);
    if (!x !== !y) return false;
    if (x && y && !segmentsEqual(x, y)) return false;
  }
  return true;
}

/** Names the queried labels whose placement disagrees between two scans. */
function unstableDiagnostic(a: ReadonlyMap<string, readonly string[]>,
                            b: ReadonlyMap<string, readonly string[]>,
                            queried: ReadonlySet<string>,
                            name?: string): string {
  const unstable = [...queried].filter(n => !queriedSegmentsEqual(a, b, new Set([n])));
  return `${name ? `${name}: ` : ''}${unstable.map(n => `'${n}'`).join(', ')} lands in ` +
      `a different segment depending on a link-time '.if' that queries it. ` +
      `Restructure to avoid the cycle`;
}

/**
 * Rebuilds a module from its recorded `lateAssembly` stream, with the full
 * symbol and segment lists known so it can settle all unknown syms and sizes.
 */
export function replayModule(
  module: Module,
  linkEnv?: LinkTimeEnv,
  signal?: CancelSignal,
): ReplayResult {
  const lateAssembly = module.lateAssembly;
  if (!lateAssembly) {
    throw new Error(`replayModule: ${module.name ?? 'module'} has no lateAssembly block`);
  }
  const {stream} = lateAssembly;
  let scans = 0;
  const run = (localForwardRefs: ReadonlyMap<string, readonly string[]>|undefined,
               tolerant: boolean) => {
    scans++;
    const asm = new Assembler(Cpu.P02, lateAssembly.opts);
    asm.linkEnv = linkEnv && {...linkEnv, localForwardRefs, tolerateUnresolvedIf: tolerant};
    asm.globalKinds = lateAssembly.globalKinds;
    let i = 0;
    const source: Tokens.Source = {next: () => i < stream.length ? stream[i++] : undefined};
    asm.tokens(source, signal);
    return asm;
  };

  let asm: Assembler;
  // Each scan should resolve at least one conditional so we run it multiple times to
  // resolve each of the conditionals until its stable
  let replayed: Module|undefined;
  if (lateAssembly.condQueries.length) {
    let known: ReadonlyMap<string, readonly string[]> = new Map();
    const everQueried = new Set<string>();
    for (let iter = 0; ; iter++) {
      const scan = run(known, true);
      const scanned = scan.module();
      const next = scan.collectLocalSegments();
      for (const name of scan.localRefQueries)
        everQueried.add(name);
      if (queriedSegmentsEqual(known, next, scan.localRefQueries)) {
        if (scan.toleratedIfs === 0) {
          // No unresolved conditionals, and segments are now stable.
          asm = scan;
          replayed = scanned;
        } else {
          // If the segments haven't changed but we are still processing unresolvable
          // conditionals, then lets get it to error out with this pass.
          asm = run(next, false);
        }
        break;
      }
      if (iter >= everQueried.size) {
        fail(unstableDiagnostic(known, next, scan.localRefQueries, module.name));
      }
      known = next;
    }
  } else {
    // Regular case for running the late pass with no special conditionals
    asm = run(undefined, false);
  }

  replayed ??= asm.module();
  replayed.name = module.name;
  const messages = asm.getMessages();
  const hasErrors = messages.some(m => m.level === 'error');
  return {success: !hasErrors, module: replayed, messages: [...messages], scans};
}

/** Result of replaying whichever modules a `LinkTimeEnv` disagrees with. */
export interface ReplayModulesResult {
  success: boolean;
  modules: Module[];
  messages: AssemblerMessage[];
}

/** Whether any query in `module`'s `lateAssembly` block gets a different answer from `linkEnv`. */
function needsReplay(module: Module, linkEnv: LinkTimeEnv): boolean {
  if ((module.lateAssembly?.condQueries.length ?? 0) > 0) return true;
  const queries = module.lateAssembly?.sizeQueries;
  if (!queries?.length) return false;
  return queries.some(q => {
    const answer = linkEnv.addrSize(q.name);
    return answer !== undefined && answer !== q.guess;
  });
}

/** Assembles a list of modules a second time if they need recompiling to resolve in the latepass */
export function replayModules(
  modules: Module[],
  moduleMessages: readonly (readonly AssemblerMessage[])[],
  linkEnv: LinkTimeEnv,
  signal?: CancelSignal,
): ReplayModulesResult {
  const collector = new ErrorCollector();
  const outModules: Module[] = [];
  for (let i = 0; i < modules.length; i++) {
    const module = modules[i];
    collector.openAsmPass();
    if (!needsReplay(module, linkEnv)) {
      collector.merge(moduleMessages[i] ?? []);
      collector.flushAsmPass();
      outModules.push(module);
      continue;
    }
    collector.discardAsmPass();
    const replay = replayModule(module, linkEnv, signal);
    collector.merge(replay.messages);
    outModules.push(replay.module);
  }
  const messages = [...collector.getMessages()];
  return {success: !collector.hasErrors(), modules: outModules, messages};
}
