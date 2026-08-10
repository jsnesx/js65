// SPDX-License-Identifier: MPL-2.0

/**
 * Handles loading the project file `js65.json`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {dirOf, joinDir} from '../../src/util.ts';
import {LINT_RULES} from '../../src/lint.ts';
import type {LintLevel, LintOptions} from '../../src/options.ts';

/** One compilation unit, as declared in `js65.json`. */
export interface CompilationUnit {
  /** Human-readable name. Defaulted to the first source's basename if absent. */
  name: string;
  /** Entry source files relative to the project root. */
  sources: string[];
  includePaths: string[];
  binIncludePaths: string[];
  /** Full text of an ld65 linker config, if `linkerConfig` pointed at a file. */
  linkerConfig?: string;
  /** Name reported against linker-config parse errors. */
  linkerConfigName?: string;
  /** Built-in target layout if no linker config given. */
  target?: string;
}

/** The shape of `js65.json` on disk. */
interface ProjectFile {
  units?: Array<{
    name?: string,
    sources?: string[],
    includePaths?: string[],
    binIncludePaths?: string[],
    linkerConfig?: string,
    target?: string,
  }>;
  lint?: unknown;
}

export interface Project {
  /** Absolute path of the `js65.json` file (or workspace root fallback). */
  readonly projectFile: string;
  /** Directory paths in `js65.json` resolve against. */
  readonly rootDir: string;
  readonly units: readonly CompilationUnit[];
  /** Workspace-wide lint configuration. Applies to every unit. */
  readonly lint?: LintOptions;
}

export function findProjectFile(startFile: string, fsImpl = fs): string | undefined {
  let dir = path.isAbsolute(startFile) ? path.dirname(startFile) : path.resolve(path.dirname(startFile));
  while (true) {
    const candidate = path.join(dir, 'js65.json');
    try {
      if (fsImpl.statSync(candidate).isFile()) return candidate;
    } catch (_e) {
      // not present; keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadProject(projectFile: string, fsImpl = fs): Project {
  const rootDir = path.dirname(projectFile);
  const raw = fsImpl.readFileSync(projectFile, 'utf8');
  let parsed: ProjectFile;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${projectFile}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.units)) {
    throw new Error(`${projectFile}: expected a top-level "units" array`);
  }
  const units: CompilationUnit[] = [];
  for (let i = 0; i < parsed.units.length; i++) {
    const u = parsed.units[i];
    if (!u || typeof u !== 'object') {
      throw new Error(`${projectFile}: units[${i}] is not an object`);
    }
    if (!Array.isArray(u.sources) || u.sources.some(s => typeof s !== 'string')) {
      throw new Error(`${projectFile}: units[${i}].sources must be an array of strings`);
    }
    const absSources = u.sources.map(s => resolveProjectPath(rootDir, s));
    const name = u.name ?? (absSources[0] ? path.basename(absSources[0]) : `unit_${i}`);
    let linkerConfig: string | undefined;
    let linkerConfigName: string | undefined;
    if (u.linkerConfig != null) {
      const cfgPath = resolveProjectPath(rootDir, u.linkerConfig);
      try {
        linkerConfig = fsImpl.readFileSync(cfgPath, 'utf8');
        linkerConfigName = cfgPath;
      } catch (err) {
        throw new Error(`${projectFile}: could not read linkerConfig ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    units.push({
      name,
      sources: absSources,
      includePaths: (u.includePaths ?? []).map(p => resolveProjectPath(rootDir, p)),
      binIncludePaths: (u.binIncludePaths ?? []).map(p => resolveProjectPath(rootDir, p)),
      linkerConfig,
      linkerConfigName,
      target: u.target,
    });
  }
  return {projectFile, rootDir, units, lint: parseLint(projectFile, parsed.lint)};
}

const LINT_LEVELS: readonly LintLevel[] = ['off', 'info', 'warning'];

/** Validate the optional top-level `"lint"` block, which mirrors `LintOptions`. */
function parseLint(projectFile: string, raw: unknown): LintOptions | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${projectFile}: "lint" must be an object`);
  }
  const lint = raw as {enabled?: unknown, rules?: unknown};
  const out: LintOptions = {};
  if (lint.enabled != null) {
    if (typeof lint.enabled !== 'boolean') {
      throw new Error(`${projectFile}: "lint.enabled" must be a boolean`);
    }
    out.enabled = lint.enabled;
  }
  if (lint.rules != null) {
    if (typeof lint.rules !== 'object' || Array.isArray(lint.rules)) {
      throw new Error(`${projectFile}: "lint.rules" must be an object`);
    }
    const rules: Record<string, LintLevel> = {};
    for (const [id, level] of Object.entries(lint.rules as Record<string, unknown>)) {
      if (!LINT_RULES.has(id)) {
        const known = [...LINT_RULES.keys()].join(', ');
        throw new Error(`${projectFile}: unknown lint rule "${id}" (known rules: ${known})`);
      }
      if (typeof level !== 'string' || !LINT_LEVELS.includes(level as LintLevel)) {
        throw new Error(`${projectFile}: "lint.rules.${id}" must be one of ${LINT_LEVELS.join(', ')}`);
      }
      rules[id] = level as LintLevel;
    }
    out.rules = rules;
  }
  return out;
}

function resolveProjectPath(rootDir: string, p: string): string {
  // joinDir normalizes `.`/`..` and backslashes; pass it an absolute POSIX path.
  const abs = path.isAbsolute(p) ? p : path.join(rootDir, p);
  return toPosix(abs);
}

export function toPosix(p: string): string {
  // if its a UNC path `//server/etc` then we need to split the path and recombine it manually
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(.*)$/.exec(p);
  if (unc) {
    const [, server, share, rest] = unc;
    return `//${server}/${share}${rest ? joinDir('', rest) : ''}`;
  }
  return joinDir('', p);
}

/**
 * Return every unit whose `sources` list (or transitive includes, when known)
 * contains the given absolute file path. Used to decide which units to rebuild
 * on a leaf-file change.
*/
export function unitsOwningFile(project: Project, absFile: string): CompilationUnit[] {
  const posix = toPosix(absFile);
  const out: CompilationUnit[] = [];
  for (const unit of project.units) {
    if (unit.sources.some(s => toPosix(s) === posix)) {
      out.push(unit);
    }
  }
  return out;
}

/**
 * When no `js65.json` is found, fallback to handling just a single file.
 */
export function standaloneUnit(absFile: string, rootDir: string): CompilationUnit {
  const posix = toPosix(absFile);
  return {
    // Keyed by full path, not basename.
    name: posix,
    sources: [posix],
    includePaths: [dirOf(posix), toPosix(rootDir)],
    binIncludePaths: [dirOf(posix), toPosix(rootDir)],
  };
}
