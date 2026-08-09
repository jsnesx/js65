// SPDX-License-Identifier: MPL-2.0

/**
 * Handles loading the project file `js65.json`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {dirOf, joinDir} from '../../src/util.ts';

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
}

export interface Project {
  /** Absolute path of the `js65.json` file (or workspace root fallback). */
  readonly projectFile: string;
  /** Directory paths in `js65.json` resolve against. */
  readonly rootDir: string;
  readonly units: readonly CompilationUnit[];
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
  return {projectFile, rootDir, units};
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
