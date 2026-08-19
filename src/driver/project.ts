
// SPDX-License-Identifier: MPL-2.0

/**
 * `js65.json`, the project file both `js65 build` and the language server read.
 *
 * This module is deliberately filesystem-free: everything under `src/` has to run on
 * bun, node, Hermes and .NET WASM, and the driver only reaches the filesystem through
 * `Callbacks`. So `parseProject` takes the file's *text* and hands back unexpanded
 * source patterns plus a linker-config *path* - expanding a glob and reading a config
 * are both I/O, and the caller owns that: `lsp/server/project.ts` with node's `fs`,
 * `build.ts` with `Callbacks`.
 */

import {LINT_RULES} from '../lint.ts';
import type {LintLevel, LintOptions, SymbolDefine} from '../options.ts';
import type {OutputFormat} from '../libassembler.ts';
import {dirOf, joinDir} from '../util.ts';

const OUTPUT_FORMATS: readonly OutputFormat[] = ['binary', 'ips', 'object'];
const LINT_LEVELS: readonly LintLevel[] = ['off', 'info', 'warning'];

/** One independently-assembled program, as declared in `js65.json`'s `projects`. */
export interface Js65Project {
  /** Human-readable name, and the default stem of every output file. */
  name: string;
  /**
   * Source patterns exactly as written, relative to the project file and possibly
   * containing globs. `sources` holds the result of expanding these.
   */
  readonly sourcePatterns: readonly string[];
  /**
   * Absolute POSIX paths of every source in link order. Empty out of `parseProject` -
   * expansion needs a filesystem, so a loader fills this in.
   */
  sources: string[];
  /** Absolute POSIX search path for `.include`. */
  includePaths: string[];
  /** Absolute POSIX search path for `.incbin`. */
  binIncludePaths: string[];
  /** Absolute POSIX path of an ld65 config, when `linkerConfig` named one. */
  linkerConfigPath?: string;
  /** Full text of `linkerConfigPath`. Filled in by a loader, for the same reason. */
  linkerConfig?: string;
  /** Built-in target layout, used when no linker config is given. */
  target?: string;
  /** Absolute POSIX path of the linked output. */
  output: string;
  /** Absolute POSIX path for debug info (MLB labels), when asked for. */
  dbgfile?: string;
  /** Absolute POSIX path for the linker map, when asked for. */
  mapfile?: string;
  format: OutputFormat;
  /** Absolute POSIX path of the ROM an `ips`/patch build applies to. */
  baseRom?: string;
  defines: SymbolDefine[];
  features: string[];
  /** `debugLevel`: 0 and up add debug info, -1 turns it off. */
  debug?: number;
}

/** A parsed `js65.json`. */
export interface Js65Config {
  /** Absolute POSIX path of the `js65.json` file (or workspace root fallback). */
  readonly projectFile: string;
  /** Directory that paths in `js65.json` resolve against. */
  readonly rootDir: string;
  /** Absolute POSIX directory build outputs land in. */
  readonly outDir: string;
  readonly projects: readonly Js65Project[];
  /** Lint configuration. Applies to every project in the file. */
  readonly lint?: LintOptions;
}

/** The raw shape of `js65.json` on disk, before validation. */
interface RawConfig {
  outDir?: unknown;
  projects?: unknown;
  lint?: unknown;
}

const CONFIG_KEYS = ['$schema', 'outDir', 'projects', 'lint'];
const PROJECT_KEYS = [
  'name', 'sources', 'includePaths', 'binIncludePaths', 'linkerConfig', 'target',
  'output', 'dbgfile', 'mapfile', 'format', 'baseRom', 'defines', 'features', 'debug',
];

/**
 * Parse and validate `js65.json`. `projectFile` is only used to resolve relative paths
 * and to name errors; nothing reads it.
 */
export function parseProject(projectFile: string, text: string): Js65Config {
  const file = toPosix(projectFile);
  // A bare `js65.json`, which is what `js65 build` defaults to, has no directory part.
  // Its paths are relative to the cwd, so root at `.` rather than at `/`.
  const rootDir = dirOf(file) || '.';
  // Annotated so TypeScript treats a `fail(...)` call as terminating the flow.
  const fail: (msg: string) => never = msg => {
    throw new Error(`${file}: ${msg}`);
  };

  let raw: RawConfig;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail(`invalid JSON: ${errText(err)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expected a JSON object');
  }
  rejectUnknownKeys(fail, raw, CONFIG_KEYS, '');
  if (!Array.isArray(raw.projects)) {
    fail('expected a top-level "projects" array');
  }
  const outDir = resolveProjectPath(rootDir, optString(fail, raw.outDir, 'outDir') ?? 'build');

  const projects: Js65Project[] = [];
  for (let i = 0; i < (raw.projects as unknown[]).length; i++) {
    projects.push(parseOne(fail, rootDir, outDir, (raw.projects as unknown[])[i], i));
  }
  return {projectFile: file, rootDir, outDir, projects, lint: parseLint(fail, raw.lint)};
}

function parseOne(
    fail: (msg: string) => never, rootDir: string, outDir: string,
    raw: unknown, i: number): Js65Project {
  const where = `projects[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where} is not an object`);
  }
  const p = raw as Record<string, unknown>;
  rejectUnknownKeys(fail, p, PROJECT_KEYS, `${where}.`);

  const sourcePatterns = stringArray(fail, p.sources, `${where}.sources`);
  if (!sourcePatterns) fail(`${where}.sources must be an array of strings`);
  if (!sourcePatterns.length) fail(`${where}.sources is empty`);

  const name = optString(fail, p.name, `${where}.name`) ??
      defaultName(rootDir, sourcePatterns, i);
  const linkerConfig = optString(fail, p.linkerConfig, `${where}.linkerConfig`);
  const format = optString(fail, p.format, `${where}.format`) ?? 'binary';
  if (!OUTPUT_FORMATS.includes(format as OutputFormat)) {
    fail(`${where}.format must be one of ${OUTPUT_FORMATS.join(', ')}`);
  }
  const output = optString(fail, p.output, `${where}.output`) ?? `${name}.nes`;
  const dbgfile = optString(fail, p.dbgfile, `${where}.dbgfile`);
  const mapfile = optString(fail, p.mapfile, `${where}.mapfile`);
  const baseRom = optString(fail, p.baseRom, `${where}.baseRom`);
  const target = optString(fail, p.target, `${where}.target`);
  const debug = p.debug === undefined ? undefined :
      typeof p.debug === 'number' && Number.isInteger(p.debug) ? p.debug :
      fail(`${where}.debug must be an integer`);

  return {
    name,
    sourcePatterns,
    sources: [],
    includePaths: dirList(fail, rootDir, p.includePaths, `${where}.includePaths`),
    binIncludePaths: dirList(fail, rootDir, p.binIncludePaths, `${where}.binIncludePaths`),
    linkerConfigPath: linkerConfig && resolveProjectPath(rootDir, linkerConfig),
    target,
    // Outputs are relative to outDir, everything else to the project file: a build
    // writes into one directory that is easy to clean and easy to gitignore.
    output: resolveProjectPath(outDir, output),
    dbgfile: dbgfile && resolveProjectPath(outDir, dbgfile),
    mapfile: mapfile && resolveProjectPath(outDir, mapfile),
    format: format as OutputFormat,
    baseRom: baseRom && resolveProjectPath(rootDir, baseRom),
    defines: parseDefines(fail, p.defines, `${where}.defines`),
    features: stringArray(fail, p.features, `${where}.features`) ?? [],
    debug,
  };
}

/**
 * Name a project the user did not name: the first literal source's basename without its
 * extension, or else the directory holding `js65.json`. A glob makes a poor name
 * (`*.s` would give `*`), so it is skipped.
 */
function defaultName(rootDir: string, patterns: readonly string[], i: number): string {
  const literal = patterns.find(s => !/[*?]/.test(s));
  if (literal) {
    const base = baseOf(literal);
    const dot = base.lastIndexOf('.');
    if (dot > 0) return base.substring(0, dot);
    if (base) return base;
  }
  return baseOf(rootDir) || `project_${i}`;
}

function parseDefines(
    fail: (msg: string) => never, raw: unknown, where: string): SymbolDefine[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where} must be an object mapping names to values`);
  }
  const out: SymbolDefine[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number' &&
        typeof value !== 'boolean') {
      fail(`${where}.${name} must be a string, number or boolean`);
    }
    // Values cross into the assembler as text either way, so a JSON number is just a
    // friendlier spelling of the `-D NAME=value` string. Booleans become 1/0 rather
    // than "true"/"false", which would define a macro expanding to an unknown symbol.
    out.push({name, value: typeof value === 'boolean' ? (value ? '1' : '0') : String(value)});
  }
  return out;
}

/** Validate the optional top-level `"lint"` block, which mirrors `LintOptions`. */
function parseLint(fail: (msg: string) => never, raw: unknown): LintOptions | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('"lint" must be an object');
  }
  const lint = raw as {enabled?: unknown, rules?: unknown};
  const out: LintOptions = {};
  if (lint.enabled != null) {
    if (typeof lint.enabled !== 'boolean') {
      fail('"lint.enabled" must be a boolean');
    }
    out.enabled = lint.enabled as boolean;
  }
  if (lint.rules != null) {
    if (typeof lint.rules !== 'object' || Array.isArray(lint.rules)) {
      fail('"lint.rules" must be an object');
    }
    const rules: Record<string, LintLevel> = {};
    for (const [id, level] of Object.entries(lint.rules as Record<string, unknown>)) {
      if (!LINT_RULES.has(id)) {
        const known = [...LINT_RULES.keys()].join(', ');
        fail(`unknown lint rule "${id}" (known rules: ${known})`);
      }
      if (typeof level !== 'string' || !LINT_LEVELS.includes(level as LintLevel)) {
        fail(`"lint.rules.${id}" must be one of ${LINT_LEVELS.join(', ')}`);
      }
      rules[id] = level as LintLevel;
    }
    out.rules = rules;
  }
  return out;
}

function rejectUnknownKeys(
    fail: (msg: string) => never, obj: object, known: readonly string[],
    prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      fail(`unknown key "${prefix}${key}" (known keys: ${known.join(', ')})`);
    }
  }
}

function optString(
    fail: (msg: string) => never, raw: unknown, where: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') fail(`${where} must be a string`);
  return raw as string;
}

function stringArray(
    fail: (msg: string) => never, raw: unknown, where: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some(s => typeof s !== 'string')) {
    fail(`${where} must be an array of strings`);
  }
  return (raw as string[]).map(s => s.replace(/\\/g, '/'));
}

function dirList(
    fail: (msg: string) => never, rootDir: string, raw: unknown,
    where: string): string[] {
  const list = stringArray(fail, raw, where);
  if (!list) {
    if (raw !== undefined) fail(`${where} must be an array of strings`);
    return [];
  }
  return list.map(p => resolveProjectPath(rootDir, p));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Last path segment, separator-agnostic. */
function baseOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** True for `/x`, `//server/share/x` and `C:\x` alike. */
function isAbsolutePath(p: string): boolean {
  return /^([\\/]|[A-Za-z]:[\\/])/.test(p);
}

/** Resolve one `js65.json` path against `baseDir`, normalized to absolute POSIX. */
export function resolveProjectPath(baseDir: string, p: string): string {
  return toPosix(isAbsolutePath(p) ? p : `${baseDir}/${p}`);
}

export function toPosix(p: string): string {
  // if its a UNC path `//server/etc` then we need to split the path and recombine it manually
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(.*)$/.exec(p);
  if (unc) {
    const [, server, share, rest] = unc;
    return `//${server}/${share}${rest ? joinDir('', rest) : ''}`;
  }
  const joined = joinDir('', p);
  return /^[A-Za-z]:(\/|$)/.test(joined)
      ? joined.charAt(0).toLowerCase() + joined.slice(1)
      : joined;
}

/**
 * Return every project whose `sources` list contains the given absolute file path.
 * Used to decide which projects to rebuild on a leaf-file change.
 */
export function projectsOwningFile(config: Js65Config, absFile: string): Js65Project[] {
  const posix = toPosix(absFile);
  const out: Js65Project[] = [];
  for (const project of config.projects) {
    if (project.sources.some(s => toPosix(s) === posix)) {
      out.push(project);
    }
  }
  return out;
}

/**
 * When no `js65.json` is found, fallback to handling just a single file.
 */
export function standaloneProject(absFile: string, rootDir: string): Js65Project {
  const posix = toPosix(absFile);
  const dir = dirOf(posix);
  return {
    // Keyed by full path, not basename.
    name: posix,
    sourcePatterns: [posix],
    sources: [posix],
    includePaths: [dir, toPosix(rootDir)],
    binIncludePaths: [dir, toPosix(rootDir)],
    output: `${posix}.nes`,
    format: 'binary',
    defines: [],
    features: [],
  };
}
