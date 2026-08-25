
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
}

function segmentsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function localSegmentsEqual(a: ReadonlyMap<string, readonly string[]>,
                             b: ReadonlyMap<string, readonly string[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, segs] of a) {
    const other = b.get(name);
    if (!other || !segmentsEqual(segs, other)) return false;
  }
  return true;
}

/** Bounds the scanning loop below against a circular `.if`. */
const MAX_LOCAL_REF_SCAN_ITERATIONS = 8;

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
  const run = (localForwardRefs: ReadonlyMap<string, readonly string[]>|undefined,
               tolerant: boolean) => {
    const asm = new Assembler(Cpu.P02, lateAssembly.opts);
    asm.linkEnv = linkEnv && {...linkEnv, localForwardRefs, tolerateUnresolvedIf: tolerant};
    asm.globalKinds = lateAssembly.globalKinds;
    let i = 0;
    const source: Tokens.Source = {next: () => i < stream.length ? stream[i++] : undefined};
    asm.tokens(source, signal);
    return asm;
  };

  let asm: Assembler;
  if (lateAssembly.condQueries.length) {
    // Retry scanning over and over to try and resolve all banks for data
    // that reference forward labels. This sucks and needs replacing.
    let known: ReadonlyMap<string, readonly string[]> = new Map();
    asm = run(known, true);
    let converged = false;
    for (let iter = 0; iter < MAX_LOCAL_REF_SCAN_ITERATIONS; iter++) {
      asm.module(); // finalize the scope tree (closeScopes/resolveDeferredOps)
      const next = asm.collectLocalSegments();
      if (localSegmentsEqual(known, next)) { converged = true; break; }
      known = next;
      asm = run(known, true);
    }
    // If we failed to converge, force a bad compilation so it errors out
    asm = run(converged ? known : undefined, false);
  } else {
    asm = run(undefined, false);
  }

  const replayed = asm.module();
  replayed.name = module.name;
  const messages = asm.getMessages();
  const hasErrors = messages.some(m => m.level === 'error');
  return {success: !hasErrors, module: replayed, messages: [...messages]};
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

/**
 * Replays each module whose recorded guesses disagree with `linkEnv`,
 * replacing it in the result. `moduleMessages` (from `assemble()`) must be
 * aligned with `modules`. A replayed module's pass-1 messages are discarded
 * wholesale via `ErrorCollector`'s provisional scope (never merged with
 * pass-2's), so nothing reports twice.
 */
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
