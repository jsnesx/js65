// SPDX-License-Identifier: MPL-2.0


import * as fs from 'node:fs';
import * as path from 'node:path';

import {assemble, link, searchFiles, type AssemblyInput, type AssemblerOptions, type CancelSignal,
        type FileCallbacks} from '../../../src/libassembler.ts';
import type {AssemblerMessage, SourceInfo} from '../../../src/error.ts';
import {InactiveRegionIndex, MacroIndex, SymbolIndex} from '../../../src/lspindex.ts';
import type {Module, Segment} from '../../../src/module.ts';
import {lowerLinkerConfig, parseLinkerConfig} from '../../../src/linkerconfig.ts';
import {joinDir} from '../../../src/util.ts';
import type {Diagnostic} from 'vscode-languageserver-protocol';

import {
  type Js65Project,
  type Js65Config,
  findProjectFile,
  loadProject,
  standaloneProject,
  toPosix,
  projectsOwningFile,
} from '../project.ts';
import {messageToDiagnostic, uriToPath, pathToUri} from '../convert.ts';
import {FileCache, type FileDelta, type FileSnapshot} from './filecache.ts';

/** One cached assemble run for a single project. */
export interface ProjectAnalysis {
  readonly project: Js65Project;
  /** Symbol index the LSP navigates against, populated by the assembler. */
  readonly index: SymbolIndex;
  /** Macro/define table the run built for hover. */
  readonly macros: MacroIndex;
  /** Conditional branches this run skipped, for greying them out in the editor. */
  readonly inactiveRegions: InactiveRegionIndex;
  /** Every source/.include/.incbin path the run touched used for invalidation. */
  readonly touchedFiles: ReadonlySet<string>;
  /** True if the project was assembled in standalone (no `js65.json`) mode. */
  readonly standalone: boolean;
  /**
   * Modules the assemble produced, retained so `link()` can run on save
   * without reassembling. Empty when the assemble failed outright.
   */
  readonly modules: readonly Module[];
  readonly ramSegments: ReadonlySet<string>;
}

export interface AnalysisResult {
  /** URI -> diagnostics for that file. */
  readonly diagnostics: ReadonlyMap<string, Diagnostic[]>;
  /** Per-project results, keyed by project name. */
  readonly projects: ReadonlyMap<string, ProjectAnalysis>;
  /** Source URIs that contributed diagnostics this run, for empty-publish logic. */
  readonly touchedUris: ReadonlySet<string>;
}

/** Options for the analyzer. */
export interface AnalyzerOptions {
  /** Debounce window in ms. Default 200 */
  debounceMs?: number;
  /** Project root fallback when no `js65.json` is found. */
  workspaceRoot: string;
  fsImpl?: typeof fs;
  /** Sink for analyzer log output. */
  onLog?: (msg: string) => void;
  /** Cap on messages a single project's assemble may report. */
  errorLimit?: number;
}

interface PendingRun {
  paths: ReadonlySet<string>;
  signal: CancelToken;
}

/** A mutable cancel signal. */
class CancelToken {
  aborted = false;
  get signal(): CancelSignal { return this; }
}

export class Analyzer {
  /** Open documents keyed by their POSIX-normalized path. */
  private readonly openDocs = new Map<string, {version?: number, text: string}>();
  /**
   * Every file the assemble may read. In a worker this is the whole filesystem, kept current
   * by snapshots and deltas the host pushes; in-process it backs an `fsImpl` read-through.
   */
  private readonly cache = new FileCache();
  /** Most recent project, discovered lazily and cached per workspace root. */
  private project: Js65Config | undefined;
  /** Last analysis result, used by feature modules for navigation. */
  private lastResult: AnalysisResult | undefined;
  /** Pending debounce + cancellation state. */
  private pending: PendingRun | undefined;
  /** CancelToken of the run that has actually started. */
  private inFlight: CancelToken | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Callbacks waiting for the analyzer to go idle. see `settled()`. */
  private waiters: Array<() => void> = [];

  /** Diagnostics callback which the server wires to `sendNotification`. */
  onDiagnostics?: (result: AnalysisResult) => void;

  constructor(private opts: AnalyzerOptions) {}

  /** Replace the workspace root fallback such as when LSP `initialize` lands. */
  setWorkspaceRoot(root: string): void { this.opts.workspaceRoot = root; }

  /** Replace the whole resident file map, as on project load or reload. */
  setFiles(snapshot: FileSnapshot): void {
    this.cache.reset(snapshot);
  }

  applyFileDelta(delta: FileDelta): void {
    this.cache.apply(delta);
  }

  /** Replace the current project such as when `js65.json` changes. */
  setProject(project: Js65Config | undefined): void {
    this.project = project;
    this.scheduleAll();
  }

  discoverProject(absFile: string): Js65Config | undefined {
    const projectFile = findProjectFile(absFile, this.opts.fsImpl ?? fs);
    if (!projectFile) return undefined;
    try {
      return loadProject(projectFile, this.opts.fsImpl ?? fs);
    } catch (err) {
      this.log(`failed to load ${projectFile}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Track an open document. Triggers an analysis pass. */
  open(uri: string, text: string, version?: number): void {
    const p = uriToPath(uri);
    this.openDocs.set(toPosix(p), {version, text});
    this.cache.openBuffer(p, text);
    this.ensureProjectFor(p);
    this.schedule([p]);
  }

  /** Track a document change. Triggers a debounced analysis pass. */
  change(uri: string, text: string, version?: number): void {
    const p = uriToPath(uri);
    this.openDocs.set(toPosix(p), {version, text});
    this.cache.openBuffer(p, text);
    this.schedule([p]);
  }

  /** Forget a closed document. Triggers a re-analysis (other files may have
   *  been reading this one through `.include`). */
  close(uri: string): void {
    const p = uriToPath(uri);
    this.openDocs.delete(toPosix(p));
    this.cache.closeBuffer(p);
    this.schedule([p]);
  }

  getResult(): AnalysisResult | undefined { return this.lastResult; }

  settled(timeoutMs = 10000): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      this.waiters.push(finish);
      const timer = setTimeout(finish, timeoutMs);
      // Don't hold the process open on a timer nobody is waiting for.
      (timer as unknown as {unref?: () => void}).unref?.();
    });
  }

  /** True while a pass is debouncing, queued, or awaiting the assembler. */
  private isBusy(): boolean {
    return this.debounceTimer !== undefined || this.pending !== undefined ||
        this.inFlight !== undefined;
  }

  /** Release `settled()` waiters, but only once the analyzer is truly idle. */
  private notifySettled(): void {
    if (this.isBusy()) return;
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }

  getProject(name: string): ProjectAnalysis | undefined {
    return this.lastResult?.projects.get(name);
  }

  peekDoc(uri: string): string | undefined {
    const p = uriToPath(uri);
    return this.openDocs.get(toPosix(p))?.text;
  }

  /** All known projects from the current config, in declaration order. */
  get projects(): readonly Js65Project[] {
    return this.project?.projects ?? [];
  }

  private makeCallbacks(touched: Set<string>): FileCallbacks & {
    readText: (base: string, rel: string) => string,
  } {
    // Only *successful* reads are recorded. The include path search involves
    // lots of unsuccessful reads trying to find the right path so skip those,
    // which searchFiles handles by only returning the base that hit.
    const cached = this.cache.callbacks(touched);
    const fsImpl = this.opts.fsImpl;
    if (!fsImpl) return cached;

    const bytes = new Map<string, Uint8Array>();
    const texts = new Map<string, string>();
    // A test `fsImpl` may hand back a string where node hands back a Buffer, so normalize to
    // bytes here and let each caller decode as it needs.
    const readThrough = (posix: string): Uint8Array | undefined => {
      const memo = bytes.get(posix);
      if (memo) return memo;
      try {
        const raw = fsImpl.readFileSync(pathFromPosix(posix)) as unknown as Uint8Array | string;
        const found = typeof raw === 'string'
            ? new TextEncoder().encode(raw)
            : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        bytes.set(posix, found);
        return found;
      } catch {
        return undefined;
      }
    };
    const readText = (base: string, rel: string): string => {
      const posix = joinDir(toPosix(base), toPosix(rel));
      if (this.cache.has(posix)) return cached.readText(base, rel);
      let text = texts.get(posix);
      if (text === undefined) {
        const found = readThrough(posix);
        if (found === undefined) throw new Error(`ENOENT ${posix}`);
        text = new TextDecoder().decode(found);
        texts.set(posix, text);
      }
      touched.add(posix);
      return text;
    };
    return {
      readText,
      resolveText: searchFiles(readText),
      resolveBinary: searchFiles((base, rel) => {
        const posix = joinDir(toPosix(base), toPosix(rel));
        if (this.cache.has(posix)) return cached.resolveBinary([base], rel)?.content;
        const found = readThrough(posix);
        if (found === undefined) throw new Error(`ENOENT ${posix}`);
        touched.add(posix);
        return found;
      }),
    };
  }

  /** Ensure a project is loaded for the given file, lazy-loading if needed. */
  private ensureProjectFor(absFile: string): void {
    if (this.project !== undefined) return; // explicit set or already-missing
    const found = this.discoverProject(absFile);
    if (found) this.project = found;
  }

  /** Schedule an analysis pass for the files owning the changed paths. */
  private schedule(changedPaths: string[]): void {
    // A close with no docs left still has to run: the pass is what produces the
    // empty publish that clears the closed file's squiggles.
    if (!this.openDocs.size && !this.lastResult) return;
    if (this.pending) this.pending.signal.aborted = true;
    if (this.inFlight) this.inFlight.aborted = true;
    // Union rather than replace: editing file A then file B inside one debounce
    // window must rebuild both projects, not just B's.
    const paths = new Set<string>([
      ...(this.pending?.paths ?? []),
      ...changedPaths.map(toPosix),
    ]);
    const token = new CancelToken();
    this.pending = {paths, signal: token};
    const debounceMs = this.opts.debounceMs ?? 200;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const p = this.pending!;
      this.pending = undefined;
      this.inFlight = p.signal;
      // Never leave `run()` unguarded: an escaped rejection here is an
      // unhandled rejection, which under Node's default takes the process down.
      void this.run(p.paths, p.signal).catch(err => {
        // Clear the token this pass owned, or `settled()` waiters would block
        // until their timeout on a run that is already over.
        if (this.inFlight === p.signal) this.inFlight = undefined;
        this.reportInternalError(err);
        this.notifySettled();
      });
    }, debounceMs);
  }

  /** Report an error that escaped an analysis pass. Never throws. */
  private reportInternalError(err: unknown): void {
    this.log(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }

  /** Route a log line to the injected sink, defaulting to stderr. */
  private log(msg: string): void {
    const sink = this.opts.onLog;
    if (sink) {
      sink(`js65-lsp: ${msg}`);
    } else {
      // stderr only. stdout belongs to the JSON-RPC stream.
      console.error(`js65-lsp: ${msg}`);
    }
  }

  /** Schedule a full rebuild (e.g. after a project-file change). */
  private scheduleAll(): void {
    if (!this.openDocs.size && !this.lastResult) return;
    this.schedule([...this.openDocs.keys()]);
  }

  private async run(changedPaths: ReadonlySet<string>, token: CancelToken): Promise<void> {
    if (token.aborted) return;
    const config = this.project;
    const toRun = this.pickProjectsToRun(config, changedPaths);
    const diagnostics = new Map<string, Diagnostic[]>();
    const projectResults = new Map<string, ProjectAnalysis>();
    const touchedUris = new Set<string>();

    const uriOf = (p: string) => pathToUri(p);

    for (const {project, standalone} of toRun) {
      if (token.aborted) return;
      const analysis = await this.analyzeProject(project, standalone, token, diagnostics,
                                                 touchedUris, uriOf);
      projectResults.set(project.name, analysis);
    }

    // Check any opened files outside of the current project. If they are open and not
    // in the project, then compile them as standalone, in order to get *some* analysis
    // and also check to see if this includes something we have seen before
    if (config) {
      for (const p of changedPaths) {
        if (token.aborted) return;
        if (!this.openDocs.has(p)) continue; // closed files have no editor to publish to
        if (isCoveredBy(projectResults, p)) continue;
        const project = standaloneProject(p, this.opts.workspaceRoot);
        if (projectResults.has(project.name)) continue;
        const analysis = await this.analyzeProject(project, true, token, diagnostics,
                                                   touchedUris, uriOf);
        projectResults.set(project.name, analysis);
      }
    }

    // A newer pass superseded this one while it was awaiting the assembler.
    if (token.aborted) return;

    const result: AnalysisResult = {diagnostics, projects: projectResults, touchedUris};
    this.lastResult = result;
    if (this.inFlight === token) this.inFlight = undefined;
    this.onDiagnostics?.(result);
    this.notifySettled();
  }

  /** Assemble one project and bucket its messages. */
  private async analyzeProject(
      project: Js65Project,
      standalone: boolean,
      token: CancelToken,
      diagnostics: Map<string, Diagnostic[]>,
      touchedUris: Set<string>,
      uriOf: (p: string) => string): Promise<ProjectAnalysis> {
    const touched = new Set<string>();
    // Seed with the entry sources so the include graph has roots even if
    // the assembler bails before reading anything.
    for (const s of project.sources) touched.add(toPosix(s));

    const index = new SymbolIndex();
    const macros = new MacroIndex();
    const inactiveRegions = new InactiveRegionIndex();
    const asmOpts: AssemblerOptions = {
      includePaths: project.includePaths,
      binIncludePaths: project.binIncludePaths,
      lineContinuations: true,
      generateDebugInfo: true,
      collectReferences: true,
      symbolIndex: index,
      macroIndex: macros,
      inactiveRegionIndex: inactiveRegions,
      // Without these every `.ifdef` guarded block is invisible to the LSP, so
      // whole banks go undeclared and the symbols inside them never resolve.
      defines: project.defines,
      errorLimit: this.opts.errorLimit ?? DEFAULT_LSP_ERROR_LIMIT,
      // Workspace-wide, so a standalone file in a project folder lints the same
      // way the projects around it do.
      lint: this.project?.lint,
    };
    const callbacks = this.makeCallbacks(touched);

    // Any file in the project may be missing (a typo'd path in js65.json, or a
    // source deleted while the editor is open). Reading them inside the try
    // turns that into a diagnostic on a real document rather than a rejection
    // that escapes the pass.
    let messages: AssemblerMessage[];
    let modules: readonly Module[] = [];
    try {
      const inputs: AssemblyInput[] = [];
      for (const s of project.sources) {
        const posix = toPosix(s);
        inputs.push({
          type: 'source',
          // Hand the assembler a POSIX path so the index/diagnostics line up
          // with what `touched` and `openDocs` already keyed on.
          name: posix,
          code: callbacks.readText('', posix),
        });
      }
      const result = assemble(inputs, asmOpts, callbacks, undefined, token.signal);
      messages = [...result.messages];
      modules = result.modules;
    } catch (err) {
      messages = [internalErrorMessage(err, project)];
    }

    if (standalone) {
      // A file with no owning project gets noise from undefined symbols that
      // a real link would have resolved. Downgrade per the plan.
      messages = downgradeUndefinedForStandalone(messages);
    }

    // Anything the assembler couldn't pin to a line still has to reach the
    // editor: `bucketMessages` drops unlocated messages, so without this an
    // error like a failed `.include` search publishes nothing at all and the
    // file reads as clean.
    bucketMessages(messages.map(m => anchorToProject(m, project)),
                   diagnostics, touchedUris, uriOf);

    return {project, index, macros, inactiveRegions, touchedFiles: touched, standalone,
            modules, ramSegments: collectRamSegments(project, modules)};
  }

  /**
   * Re-link the projects owning a saved file and merge the linker's diagnostics
   * (segment overflow, free-space problems) into the published set. Assembling
   * already happened so this reuses the modules that pass produced.
   *
   * Skipped for projects with no memory layout to place chunks into
   */
  async linkSaved(uri: string): Promise<AnalysisResult | undefined> {
    const result = this.lastResult;
    if (!result) return undefined;
    const file = toPosix(uriToPath(uri));
    const diagnostics = new Map<string, Diagnostic[]>(
        [...result.diagnostics].map(([k, v]) => [k, [...v]]));
    const touchedUris = new Set(result.touchedUris);
    let linked = false;

    for (const analysis of result.projects.values()) {
      if (!analysis.touchedFiles.has(file)) continue;
      if (!analysis.modules.length) continue;
      if (!hasMemoryLayout(analysis)) continue;
      let messages: AssemblerMessage[];
      try {
        const out = link([...analysis.modules], {
          target: analysis.project.target,
          linkerConfig: analysis.project.linkerConfig,
          linkerConfigName: analysis.project.linkerConfigPath,
        });
        messages = out.messages;
      } catch (err) {
        messages = [internalErrorMessage(err, analysis.project)];
      }
      // anchorToProject is used here in case the error message doesn't have a source location
      // which can happen right now with things like ld65 linker cfg files.
      bucketMessages(messages.map(m => anchorToProject(m, analysis.project)),
                     diagnostics, touchedUris, p => pathToUri(p));
      linked = true;
    }
    if (!linked) return undefined;

    const merged: AnalysisResult = {diagnostics, projects: result.projects, touchedUris};
    this.lastResult = merged;
    this.onDiagnostics?.(merged);
    return merged;
  }

  /**
   * Decide which projects need to reassemble given a set of changed paths.
   *
   * - If we have a config, run every project that directly owns the path, plus
   *   every project whose previous run touched it (include-graph invalidation).
   * - If a path is unknown to any project (orphan `.inc`), conservatively rerun
   *   all projects until per-project include graphs land.
   * - Without a config, every changed file is its own standalone project.
   */
  private pickProjectsToRun(config: Js65Config | undefined, changed: ReadonlySet<string>):
      Array<{project: Js65Project, standalone: boolean}> {
    const out: Array<{project: Js65Project, standalone: boolean}> = [];
    if (!config) {
      for (const p of changed) {
        out.push({project: standaloneProject(p, this.opts.workspaceRoot), standalone: true});
      }
      return out;
    }
    const seen = new Set<string>();
    const anyOrphan = new Set<string>();
    for (const p of changed) {
      const posix = toPosix(p);
      const owners = projectsOwningFile(config, posix);
      if (owners.length) {
        for (const u of owners) {
          if (seen.has(u.name)) continue;
          seen.add(u.name);
          out.push({project: u, standalone: false});
        }
      } else {
        anyOrphan.add(posix);
      }
    }
    // If we've already run at least once, consult the include graph for which
    // projects actually include each orphan path.
    if (anyOrphan.size && this.lastResult) {
      for (const analysis of this.lastResult.projects.values()) {
        if (seen.has(analysis.project.name)) continue;
        if ([...anyOrphan].some(p => analysis.touchedFiles.has(p))) {
          seen.add(analysis.project.name);
          out.push({project: analysis.project, standalone: analysis.standalone});
        }
      }
    }
    // No prior result + orphans + config present: rebuild everything, since
    // we don't yet know which projects include what.
    if (anyOrphan.size && !this.lastResult) {
      for (const u of config.projects) {
        if (seen.has(u.name)) continue;
        seen.add(u.name);
        out.push({project: u, standalone: false});
      }
    }
    // If we got nothing (e.g. changed paths are all closed), still rebuild any
    // projects we previously knew about so cleared diagnostics propagate.
    if (!out.length && this.lastResult) {
      for (const analysis of this.lastResult.projects.values()) {
        out.push({project: analysis.project, standalone: analysis.standalone});
      }
    }
    return out;
  }
}

/**
 * Per-project message cap. Far above the CLI's 30 so a real file's diagnostics are
 * never truncated, but bounded so that a pathological buffer can't build an
 * unbounded message list on every keystroke.
 */
const DEFAULT_LSP_ERROR_LIMIT = 1000;

/** True if any completed project analysis actually read this file. */
function isCoveredBy(projects: ReadonlyMap<string, ProjectAnalysis>, file: string): boolean {
  for (const analysis of projects.values()) {
    if (analysis.touchedFiles.has(file)) return true;
  }
  return false;
}

/**
 * Build the fallback diagnostic for an error that escaped the assemble. It gets
 * a `source` pointing at the project's first entry file: a message with no source
 * is dropped by the bucketing loop, which would clear every existing squiggle
 * and report nothing at all.
 */
function internalErrorMessage(err: unknown, project: Js65Project): AssemblerMessage {
  const file = project.sources[0] ? toPosix(project.sources[0]) : undefined;
  const source: SourceInfo | undefined =
      file ? {file, line: 1, column: 0} : undefined;
  const msg: AssemblerMessage = {
    level: 'error',
    message: `js65-lsp internal error: ${err instanceof Error ? err.message : String(err)}`,
  };
  if (source) msg.source = source;
  return msg;
}

/**
 * Give a message with no location one pointing at the project's entry file, so it
 * reaches a document the user can actually see. Messages that already have a
 * source are returned untouched.
 */
function anchorToProject(msg: AssemblerMessage, project: Js65Project): AssemblerMessage {
  if (msg.source) return msg;
  const file = project.sources[0] ? toPosix(project.sources[0]) : undefined;
  if (!file) return msg;
  return {...msg, source: {file, line: 1, column: 0}};
}

/**
 * Bucket messages by URI, deduping on (file, line, column, message). A header
 * included by two sources in the same project otherwise reports every diagnostic
 * in it twice.
 */
function bucketMessages(
    messages: readonly AssemblerMessage[],
    diagnostics: Map<string, Diagnostic[]>,
    touchedUris: Set<string>,
    uriOf: (p: string) => string): void {
  const seen = new Set<string>();
  for (const msg of messages) {
    const file = msg.source?.file;
    if (!file) continue; // unlocated errors stay unattributed
    const key = `${file}\0${msg.source!.line}\0${msg.source!.column}\0${msg.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const uri = uriOf(file);
    touchedUris.add(uri);
    const diags = diagnostics.get(uri) ?? [];
    diagnostics.set(uri, diags);
    diags.push(messageToDiagnostic(msg, uriOf));
  }
}

/**
 * Whether a project has enough of a memory layout for `link()` to place its
 * chunks. Three ways to get one:
 *
 *  - an ld65 linker config, or
 *  - a built-in `target` layout, or
 *  - js65's extended `.segment` syntax, which declares the layout in the source
 *    itself (`.segment "CODE" :size $4000 :mem $8000 :out "%O"`, or an
 *    anonymous `.segment $8000 :size $4000`). Those land in the assembled
 *    module's `segments`.
 *
 * Without one of those, linking is not just pointless but actively harmful: a
 * ca65-style source that says `.segment "CODE"` and expects the layout to
 * arrive from a config we weren't told about links to `Could not find space for
 * chunk Code in CODE`, which is an artifact of our own missing configuration,
 * not a bug in the user's code.
 *
 * A bare `.segment "NAME"` contributes nothing to `segments`, so the only thing
 * to rule out is ca65's predeclared `ZEROPAGE`, which `.zeropage` registers as
 * `{name, addressing: 1}` with no placement of any kind.
 */
function hasMemoryLayout(analysis: ProjectAnalysis): boolean {
  if (analysis.project.linkerConfig || analysis.project.target) return true;
  return analysis.modules.some(m => m.segments?.some(
      s => s.size !== undefined || s.memory !== undefined ||
           s.offset !== undefined || s.out !== undefined ||
           s.free?.length));
}

function collectRamSegments(
    project: Js65Project, modules: readonly Module[]): ReadonlySet<string> {
  const byName = new Map<string, Segment>();
  for (const m of modules) {
    for (const seg of m.segments ?? []) mergeSegment(byName, seg);
  }
  if (project.linkerConfig) {
    try {
      const cfg = parseLinkerConfig(project.linkerConfig,
                                    project.linkerConfigPath ?? 'linker.cfg');
      for (const seg of lowerLinkerConfig(cfg)) mergeSegment(byName, seg);
    } catch (_e) {
      // A malformed config is already reported by the link pass. Highlighting
      // just falls back to treating every label as code.
    }
  }

  const out = new Set<string>();
  for (const [name, seg] of byName) {
    if (isRamSegment(seg, byName)) out.add(name);
  }
  return out;
}

function mergeSegment(byName: Map<string, Segment>, seg: Segment): void {
  const prior = byName.get(seg.name);
  if (!prior) {
    byName.set(seg.name, {...seg});
    return;
  }
  for (const [key, value] of Object.entries(seg)) {
    if (value !== undefined && prior[key as keyof Segment] === undefined) {
      (prior as Record<string, unknown>)[key] = value;
    }
  }
}

function isRamSegment(segment: Segment, byName: ReadonlyMap<string, Segment>,
                      seen = new Set<string>()): boolean {
  if (segment.bss != null) return segment.bss;
  if (segment.load != null && !seen.has(segment.name)) {
    seen.add(segment.name);
    const target = byName.get(segment.load);
    if (target) return isRamSegment(target, byName, seen);
  }
  return !segment.out && segment.offset == null;
}

/**
 * In standalone mode (no `js65.json`), the file isn't being linked and any
 * import/export references will be unresolved. Downgrade those
 * to warnings so they don't drown out the real diagnostics.
 */
function downgradeUndefinedForStandalone(messages: AssemblerMessage[]): AssemblerMessage[] {
  const UNDEFINED = /undefined/i;
  return messages.map(m => m.level === 'error' && UNDEFINED.test(m.message)
      ? {...m, level: 'warning', message: `[standalone] ${m.message}`} : m);
}

/** Convert a POSIX-normalized path back into an OS path (for disk reads). */
function pathFromPosix(posix: string): string {
  return path.normalize(posix.split('/').join(path.sep));
}
