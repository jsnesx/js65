
// SPDX-License-Identifier: MPL-2.0

import { runActions, type CodeRunner } from './actions.ts';
import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import { ErrorCollector, fail, type AssemblerMessage } from './error.ts';
import type { Expr } from './expr.ts';
import type { JsPreprocessResult } from './jspreprocessor.ts';
import { LintPragmas } from './lint.ts';
import { lowerLinkerConfig, parseLinkerConfig } from './linkerconfig.ts';
import { InactiveRegionIndex, MacroIndex, SymbolIndex } from './lspindex.ts';
import { Segment, type LateAssemblyInput, type Module } from './module.ts';
import { JsActionTable, type AssemblerOptions, type SymbolDefine,
         type TokenizerOptions } from './options.ts';
import { Targets } from './preamble.ts';
import { Preprocessor } from './preprocessor.ts';
import * as Tokens from './token.ts';
import { Tokenizer } from './tokenizer.ts';
import { newSourceLog, sourceLogKey, TokenStream, type ResolvedFile, type SourceContents,
         type SourceLog } from './tokenstream.ts';
import type { CancelSignal, FileCallbacks } from './libassembler.ts';

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

/** The parts of a project that decide which segments exist before linking. */
export interface SegmentSources {
  linkerConfig?: string;
  linkerConfigPath?: string;
  target?: string;
}

export function mergeModuleSegments(
    modules: readonly Module[],
    config?: SegmentSources): Map<string, Segment> {
  const byName = new Map<string, Segment>();
  const add = (seg: Segment) => {
    if (seg.mirror || seg.pool) return;
    const prior = byName.get(seg.name);
    byName.set(seg.name, prior ? Segment.merge(prior, seg) : {...seg});
  };
  if (config?.linkerConfig != null) {
    try {
      const cfg = parseLinkerConfig(config.linkerConfig,
                                    config.linkerConfigPath ?? 'linker.cfg');
      for (const seg of lowerLinkerConfig(cfg)) add(seg);
    } catch (_e) {
      // A malformed config is already reported by the link pass.
    }
  } else if (config?.target != null) {
    const target = Targets.get(config.target.toLowerCase());
    for (const seg of target?.segments ?? []) add(seg);
  }
  for (const m of modules) {
    for (const seg of m.segments ?? []) add(seg);
  }
  return byName;
}

/** What one input is assembled with, beyond the assembler's own options. */
export interface InputSetup {
  defines?: SymbolDefine[];
  macroIndex?: MacroIndex;
  inactiveRegionIndex?: InactiveRegionIndex;
  /** Runs `jsPreprocess`. Replay leaves it out, since its code is already staged. */
  stage?: (code: string, name: string) => JsPreprocessResult;
}

function applyDefines(asm: Assembler, pre: Preprocessor,
                      defines: readonly SymbolDefine[] | undefined,
                      opts: TokenizerOptions) {
  for (const {name, value} of defines ?? []) {
    const toks = new Tokenizer(value, '<command line>', opts).next() ?? [];
    // Drop the trailing EOL the tokenizer appends so a lone number is length 1.
    const body = toks.length && Tokens.eq(toks[toks.length - 1], Tokens.EOL)
        ? toks.slice(0, -1) : toks;
    if (body.length === 1 && body[0].token === 'num') {
      asm.commandLineSet(name, body[0].num);
      continue;
    }
    if (!body.length) {
      // `-D FOO=` with an empty value expands to nothing like CPP would do
      pre.parseDefine([Tokens.DEFINE, {token: 'ident', str: name}]);
      continue;
    }
    pre.parseDefine([Tokens.DEFINE, {token: 'ident', str: name}, ...body]);
  }
}

/** Snapshot taken before `.feature` lines start changing the live options. */
function initialOpts(opts: AssemblerOptions): AssemblerOptions {
  const tok = opts.tokenizerOptions;
  return {...opts, tokenizerOptions: tok && {...tok}};
}

/** Assembles one input into `asm`, for pass 1 and the late pass. */
export function assembleInput(
  asm: Assembler,
  input: LateAssemblyInput,
  setup: InputSetup,
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents,
  signal?: { readonly aborted: boolean },
): Module {
  const opts = asm.opts.tokenizerOptions ?? {};
  const lateOpts = initialOpts(asm.opts);
  const files = newSourceLog();
  const newStream = () => new TokenStream(
      callbacks?.resolveText, callbacks?.resolveBinary, opts, sourceContents,
      asm.errorCollector, files);
  const newPreprocessor = (toks: TokenStream) => {
    const pre = new Preprocessor(toks, asm, undefined, asm.errorCollector,
                                 setup.macroIndex, setup.inactiveRegionIndex);
    applyDefines(asm, pre, setup.defines, opts);
    return pre;
  };

  let module: Module;
  if (input.type === 'actions') {
    let moduleName = input.name;
    const runCode: CodeRunner = (asm, code, name) => {
      const toks = newStream();
      // Use the first name provided through a code action as the outer module name
      if (moduleName === input.name && name) moduleName = name;
      toks.enter(new Tokenizer(code, moduleName, opts, sourceContents, asm.errorCollector));
      newPreprocessor(toks).run(signal);
    };
    runActions(asm, input.actions, runCode);
    module = asm.module();
    module.name = moduleName;
  } else {
    const toks = newStream();
    const staged = setup.stage?.(input.code, input.name);
    const code = staged ? staged.code : input.code;
    const tokenizer = new Tokenizer(code, input.name, opts, sourceContents, asm.errorCollector);
    // The tokenizer wiped out any of the .js* directives
    // but for the dbg info later, we want to put it back
    if (staged?.usedJavascript) sourceContents?.data.set(input.name, input.code);
    toks.enter(tokenizer);
    newPreprocessor(toks).run(signal);
    module = asm.module();
    module.name = input.name;
    const romPatch = staged?.romPatch?.();
    if (romPatch) module.romPatch = romPatch;
    if (staged?.jsPost) module.jsPost = staged.jsPost;
    input = {type: 'source', code, name: input.name};
  }

  const late = module.lateAssembly;
  if (late) {
    late.opts = lateOpts;
    late.input = input;
    late.files = files;
    if (setup.defines?.length) late.defines = setup.defines;
  }
  return module;
}

/** Overrides for a replay, on top of the options the module recorded. */
export interface ReplayOptions {
  /** Index to collect the replayed scopes and symbols into. */
  symbolIndex?: SymbolIndex;
  macroIndex?: MacroIndex;
  inactiveRegionIndex?: InactiveRegionIndex;
  errorLimit?: number;
}

/** Serves `.include`/`.incbin` from what pass 1 loaded. */
function sourceLogCallbacks(files: SourceLog|undefined): FileCallbacks {
  const lookup = <T>(map: ReadonlyMap<string, ResolvedFile<T>>|undefined,
                     bases: readonly string[], filename: string): ResolvedFile<T>|undefined => {
    const key = sourceLogKey(bases, filename);
    const hit = map?.get(key);
    // Pass 1 saw it missing, so let the stream report it at the line.
    if (!hit && files?.missing?.includes(key)) return undefined;
    if (!hit) fail(`replay needs ${filename}, which the first pass did not load`);
    return hit;
  };
  return {
    resolveText: (bases, filename) => lookup(files?.text, bases, filename),
    resolveBinary: (bases, filename) => lookup(files?.binary, bases, filename),
  };
}

/** Per-scan copy, since `.feature` edits it. Rebuilds classes a `.o` loses. */
function replayOpts(opts: AssemblerOptions): AssemblerOptions {
  const tok = opts.tokenizerOptions ?? {};
  const jsActions = (t?: JsActionTable) => t instanceof JsActionTable ? t : undefined;
  return {
    ...opts,
    jsActions: jsActions(opts.jsActions),
    tokenizerOptions: {
      ...tok,
      jsActions: jsActions(tok.jsActions),
      lintPragmas: tok.lintPragmas instanceof LintPragmas ? tok.lintPragmas :
          tok.lintPragmas && new LintPragmas(),
    },
  };
}

/** Result of re-assembling a module from its recorded `lateAssembly` input. */
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
  options?: ReplayOptions,
): ReplayResult {
  const lateAssembly = module.lateAssembly;
  if (!lateAssembly) {
    throw new Error(`replayModule: ${module.name ?? 'module'} has no lateAssembly block`);
  }
  const {input, files, defines} = lateAssembly;
  if (!input) {
    throw new Error(`replayModule: ${module.name ?? 'module'} has no recorded input`);
  }
  const {symbolIndex, macroIndex, inactiveRegionIndex, errorLimit} = options ?? {};
  const baseOpts = errorLimit != null ?
      {...lateAssembly.opts, errorLimit} : lateAssembly.opts;
  const autoImportNames = new Set((module.autoImports ?? []).map(a => a.name));
  const callbacks = sourceLogCallbacks(files);
  let scans = 0;
  // Only the last scan is real, so each collects into its own index and the
  // winner is adopted. `lateAssembly.opts` holds the pass-1 index by reference,
  // so leaving it in place would re-enter the live one on every scan.
  let scanIndex: SymbolIndex|undefined;
  let scanMacros: MacroIndex|undefined;
  let scanRegions: InactiveRegionIndex|undefined;
  const run = (localForwardRefs: ReadonlyMap<string, readonly string[]>|undefined,
               tolerant: boolean) => {
    scans++;
    scanIndex = symbolIndex && new SymbolIndex();
    scanMacros = macroIndex && new MacroIndex();
    scanRegions = inactiveRegionIndex && new InactiveRegionIndex();
    const opts = replayOpts(symbolIndex ? {...baseOpts, symbolIndex: scanIndex} : baseOpts);
    const asm = new Assembler(Cpu.P02, opts, {
      linkEnv: linkEnv && {...linkEnv, localForwardRefs, tolerateUnresolvedIf: tolerant},
      globalKinds: lateAssembly.globalKinds,
      autoImportNames,
    });
    const scanned = assembleInput(
        asm, input, {defines, macroIndex: scanMacros, inactiveRegionIndex: scanRegions},
        callbacks, undefined, signal);
    return {asm, scanned};
  };

  let asm: Assembler;
  // Each scan should resolve at least one conditional so we run it multiple times to
  // resolve each of the conditionals until its stable
  let replayed: Module;
  if (lateAssembly.condQueries.length) {
    let known: ReadonlyMap<string, readonly string[]> = new Map();
    const everQueried = new Set<string>();
    for (let iter = 0; ; iter++) {
      const {asm: scan, scanned} = run(known, true);
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
          ({asm, scanned: replayed} = run(next, false));
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
    ({asm, scanned: replayed} = run(undefined, false));
  }

  replayed.name = module.name;
  // Staged at pass 1 and link-independent; replay runs without a stage.
  if (module.romPatch) replayed.romPatch = module.romPatch;
  if (module.jsPost) replayed.jsPost = module.jsPost;
  if (symbolIndex && scanIndex) symbolIndex.adopt(scanIndex);
  if (macroIndex && scanMacros) macroIndex.adopt(scanMacros);
  if (inactiveRegionIndex && scanRegions) inactiveRegionIndex.adopt(scanRegions);
  const messages = asm.getMessages();
  const hasErrors = messages.some(m => m.level === 'error');
  return {success: !hasErrors, module: replayed, messages: [...messages], scans};
}

/** Result of replaying whichever modules a `LinkTimeEnv` disagrees with. */
export interface ReplayModulesResult {
  success: boolean;
  modules: Module[];
  messages: AssemblerMessage[];
  /** Indices of the modules that were actually re-assembled. */
  replayed: number[];
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
  options?: ReplayOptions,
): ReplayModulesResult {
  const collector = new ErrorCollector(options?.errorLimit);
  const outModules: Module[] = [];
  const replayed: number[] = [];
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
    const replay = replayModule(module, linkEnv, signal, options);
    collector.merge(replay.messages);
    outModules.push(replay.module);
    replayed.push(i);
  }
  const messages = [...collector.getMessages()];
  return {success: !collector.hasErrors(), modules: outModules, messages, replayed};
}
