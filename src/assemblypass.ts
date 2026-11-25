
// SPDX-License-Identifier: MPL-2.0

import { runActions, type CodeRunner } from './frontend/actions.ts';
import { Assembler } from './frontend/assembler.ts';
import { Cpu } from './cpu.ts';
import { ErrorCollector, fail, type AssemblerMessage } from './error.ts';
import type { Expr } from './expr.ts';
import { diffRom, growableRom, jsPreprocess } from './jspreprocessor.ts';
import { LintPragmas } from './frontend/lint.ts';
import { lowerLinkerConfig, parseLinkerConfig } from './linkerconfig.ts';
import { InactiveRegionIndex, MacroIndex, SymbolIndex } from './lspindex.ts';
import { Segment, type JsPost, type JsReplay, type LateAssemblyInput, type Module } from './module.ts';
import { JsActionTable, type AssemblerOptions, type SymbolDefine,
         type TokenizerOptions } from './options.ts';
import { Targets } from './preamble.ts';
import { Preprocessor } from './frontend/preprocessor.ts';
import * as Tokens from './token.ts';
import { Tokenizer } from './tokenizer.ts';
import { newSourceLog, sourceLogKey, SourceContents, TokenStream, type ResolvedFile,
         type SourceLog } from './tokenstream.ts';
import { utf8Length } from './frontend/debugtables.ts';
import { createHash } from 'sha1-uint8array';
import { joinDir } from './util.ts';
import type { CancelSignal, FileCallbacks } from './libassembler.ts';

const assembledJsBases = new WeakMap<JsReplay, Uint8Array>();
const romSha1s = new WeakMap<Uint8Array, string>();

function romSha1(rom: Uint8Array): string {
  let sha = romSha1s.get(rom);
  if (sha === undefined) romSha1s.set(rom, sha = createHash().update(rom).digest('hex'));
  return sha;
}

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

/** Defaults to bank 0 if we are sure that this segment doesn't have a bank num */
function bankOrDefault(segNames: readonly string[],
                       segments: ReadonlyMap<string, Segment>,
                       bank: number|undefined): number|undefined {
  if (bank !== undefined || !segNames.length) return bank;
  return segNames.every(s => segments.has(s)) ? 0 : undefined;
}

// Helper function for finding info about a sym from the total
// list of modules and segments known at link time.
function resolve<T>(name: string, modules: readonly Module[],
                     segments: ReadonlyMap<string, Segment>,
                     pick: (seg: Segment) => T|undefined,
                     fallback?: (segNames: readonly string[], answer: T|undefined) => T|undefined,
                    ): T|undefined {
  const found = findChunk(name, modules);
  if (!found) return undefined;
  const answer = resolveCandidates(found.segments, segments, pick, () => {
    fail(`${name}: disagreement across segments ${found.segments.join(', ')}`,
         found.expr);
  });
  return fallback ? fallback(found.segments, answer) : answer;
}

/** Builds a LinkTimeEnv from the merged segment table and loaded modules. */
export function buildLinkTimeEnv(
    modules: readonly Module[],
    segments: ReadonlyMap<string, Segment>): LinkTimeEnv {
  return {
    addrSize: name => resolve(name, modules, segments,
        seg => seg.addressing === 1 ? 1 : 2),
    bank: name => resolve(name, modules, segments, seg => seg.bank,
        (segNames, bank) => bankOrDefault(segNames, segments, bank)),
    segmentBank: segNames => bankOrDefault(segNames, segments,
        resolveCandidates(segNames, segments, seg => seg.bank, () => {
          fail(`disagreement across segments ${segNames.join(', ')}`);
        })),
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
  javascript?: {
    allowJavascript?: boolean;
    baseRom?: Uint8Array;
    includePaths?: string[];
    callbacks?: FileCallbacks;
    /** Serves JS reads from this snapshot instead of recording new ones. */
    replay?: JsReplay;
  };
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

/**
 * Wrap the callbacks to record what was read during the first pass
 * so that the later passes can reread them.
 */
function recordJsReads(callbacks: FileCallbacks, snapshot: JsReplay): FileCallbacks {
  const miss = (key: string) => {
    const missing = snapshot.files.missing ??= [];
    if (!missing.includes(key)) missing.push(key);
  };
  return {
    resolveText(bases, path) {
      const key = sourceLogKey(bases, path);
      const found = callbacks.resolveText(bases, path);
      if (found) snapshot.files.text.set(key, found);
      else miss(key);
      return found;
    },
    resolveBinary(bases, path) {
      const key = sourceLogKey(bases, path);
      const found = callbacks.resolveBinary(bases, path);
      if (!found) {
        miss(key);
        return undefined;
      }
      const content = typeof found.content === 'string' ?
          new TextEncoder().encode(found.content) : found.content;
      snapshot.files.binary.set(key, {baseIndex: found.baseIndex, content});
      // Blocks may write to their inputs, so keep the recorded bytes private.
      return {baseIndex: found.baseIndex, content: content.slice()};
    },
    listDir: callbacks.listDir && (dir => {
      const directories = snapshot.directories ??= new Map();
      try {
        const entries = callbacks.listDir!(dir);
        directories.set(dir, entries);
        return entries;
      } catch (err) {
        // A glob reads an unlistable directory as empty.
        directories.set(dir, []);
        throw err;
      }
    }),
  };
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
  if (asm.opts.generateDebugInfo) sourceContents ??= new SourceContents();
  const js = setup.javascript;
  if (js) {
    asm.opts.jsActions = asm.opts.jsActions?.fork() ?? new JsActionTable();
    opts.jsActions = asm.opts.jsActions;
  }
  const recording = !js?.replay;
  const snapshot: JsReplay = js?.replay ?? {files: newSourceLog(), includePaths: js?.includePaths};
  const unreadListings: string[] = [];
  const jsCallbacks = js?.replay ? replayJsReads(js.replay, unreadListings) :
      js?.callbacks && recordJsReads(js.callbacks, snapshot);
  let rom: Uint8Array<ArrayBuffer> | undefined;
  const base = js?.baseRom ?? new Uint8Array(0);
  let usedJavascript = false;
  const posts: JsPost[] = [];
  // A post block is forced to run once per module even if its included multiple times
  const posted = new Set<string>();
  const stage = (code: string, file: string) => {
    const staged = jsPreprocess(code, file, {
      jsActions: asm.opts.jsActions!, allowJavascript: js?.allowJavascript,
      callbacks: jsCallbacks, includePaths: js?.includePaths, binIncludePaths: opts.binIncludePaths,
      baseRom: base, moduleRom: () => rom ??= growableRom(base),
      registerPost: post => {
        const key = `${post.file}\0${post.blocks[0].line}`;
        if (posted.has(key)) return;
        posted.add(key);
        const last = posts[posts.length - 1];
        if (last && last.prelude === post.prelude) last.blocks.push(...post.blocks);
        else posts.push(post);
      },
    });
    if (unreadListings.length) {
      const dir = unreadListings[0];
      unreadListings.length = 0;
      fail(`replay needs a listing of ${dir}, which the first pass did not read`, {file, line: 1, column: 0});
    }
    usedJavascript ||= staged.usedJavascript;
    if (recording && staged.blocks && base.length) snapshot.baseRomLength = base.length;
    return staged.code;
  };
  const tokenize = (code: string, file: string) => {
    const text = js ? stage(code, file) : code;
    const tokenizer = new Tokenizer(text, file, opts, sourceContents, asm.errorCollector);
    if (text !== code) sourceContents?.data.set(file, code);
    return tokenizer;
  };
  const preload = (code: string, file: string) => {
    try {
      stage(code, file);
    } catch {
      // Report speculative errors only when replay takes this branch.
      usedJavascript = true;
    }
  };
  const newStream = () => new TokenStream(
      callbacks?.resolveText, callbacks?.resolveBinary, opts, sourceContents,
      asm.errorCollector, files, tokenize, js && preload);
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
    toks.enter(tokenize(input.code, input.name));
    newPreprocessor(toks).run(signal);
    module = asm.module();
    module.name = input.name;
  }
  const patch = rom && diffRom(base, rom);
  if (patch) module.romPatch = patch;
  if (posts.length) module.jsPost = posts[0];
  if (posts.length > 1) module.additionalJsPosts = posts.slice(1);

  if (module.debug) fillFileInfo(module, sourceContents, files, callbacks);

  const late = module.lateAssembly;
  if (late) {
    late.opts = lateOpts;
    late.input = input;
    late.files = files;
    if (usedJavascript && recording) {
      late.javascript = snapshot;
      if (snapshot.baseRomLength) snapshot.baseRomSha1 = romSha1(base);
      if (js?.allowJavascript) assembledJsBases.set(snapshot, base);
    }
    if (setup.defines?.length) late.defines = setup.defines;
  }
  return module;
}

/** Fills in the size and mtime of each file, and adds the `.incbin` ones. */
function fillFileInfo(module: Module, sourceContents: SourceContents|undefined,
                      log: SourceLog, callbacks?: FileCallbacks) {
  const debug = module.debug!;
  const known = new Set(debug.files.map(f => f.name));
  const add = (key: string, baseIndex: number, size: number) => {
    const parts = key.split('\0');
    const filename = parts.pop()!;
    const name = joinDir(parts[baseIndex] ?? '', filename);
    if (known.has(name)) return;
    known.add(name);
    debug.files.push({name, size, mtime: 0});
  };
  // ca65 lists every file it opened, even one that produced no lines.
  for (const [key, text] of log.text) add(key, text.baseIndex, utf8Length(text.content));
  for (const [key, bin] of log.binary) add(key, bin.baseIndex, bin.content.length);
  for (const file of debug.files) {
    if (!file.size) {
      const text = sourceContents?.data.get(file.name);
      if (text !== undefined) file.size = utf8Length(text);
    }
    file.mtime ||= callbacks?.stat?.(file.name) ?? 0;
  }
}

/** Keeps the sizes and times pass 1 found, since a replay has no way to stat. */
function carryFileInfo(from: Module, to: Module) {
  const old = new Map((from.debug?.files ?? []).map(f => [f.name, f]));
  for (const file of to.debug?.files ?? []) {
    const prev = old.get(file.name);
    if (!prev) continue;
    file.size = prev.size;
    file.mtime = prev.mtime;
  }
}

/** Overrides for a replay, on top of the options the module recorded. */
export interface ReplayOptions {
  allowJavascript?: boolean;
  baseRom?: Uint8Array;
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

/**
 * Handle includes from js when running the replay and fail on anything that is attempted
 * to be read that wasn't read in the first pass.
 */
function replayJsReads(js: JsReplay, unread: string[]): FileCallbacks {
  const logged = sourceLogCallbacks(js.files);
  return {
    resolveText: logged.resolveText,
    resolveBinary: (bases, path) => {
      const found = logged.resolveBinary(bases, path) as ResolvedFile<Uint8Array>|undefined;
      return found && {baseIndex: found.baseIndex, content: found.content.slice()};
    },
    listDir: dir => {
      const entries = js.directories?.get(dir);
      if (!entries) unread.push(dir);
      return entries ?? [];
    },
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
  const js = lateAssembly.javascript;
  const assembledBase = js && assembledJsBases.get(js);
  const allowJavascript = options?.allowJavascript ?? (assembledBase !== undefined);
  let baseRom = assembledBase;
  if (!baseRom && js?.baseRomLength) {
    const linkRom = options?.baseRom;
    baseRom = linkRom && linkRom.length > js.baseRomLength ?
        linkRom.subarray(0, js.baseRomLength) : linkRom;
    if (allowJavascript && (baseRom?.length !== js.baseRomLength || romSha1(baseRom) !== js.baseRomSha1)) {
      const message = `Replaying JavaScript requires the original base ROM ` +
          `(${js.baseRomLength} bytes, SHA-1 ${js.baseRomSha1 ?? 'unknown'})`;
      const source = module.name ? {file: module.name, line: 1, column: 0} : undefined;
      return {success: false, module, messages: [{level: 'error', message, source}], scans: 0};
    }
  }
  const javascript = js && {allowJavascript, baseRom, includePaths: js.includePaths, replay: js};
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
        asm, input, {defines, javascript, macroIndex: scanMacros, inactiveRegionIndex: scanRegions},
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
  if (replayed.lateAssembly && js) {
    replayed.lateAssembly.files = files;
    replayed.lateAssembly.javascript = js;
  }
  carryFileInfo(module, replayed);
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
