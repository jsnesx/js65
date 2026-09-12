// SPDX-License-Identifier: MPL-2.0

import {joinDir} from '../util.ts';
import {toPosix} from '../driver/project.ts';
import {parseEntry} from '../driver/fs.ts';
import type {PreloadedFiles} from './filecache.ts';

/**
 * When running in a shared memory worker, the compiler cannot asynchronously await for
 * any of the files to load, so we require that all files that the assembly need to include
 * must be preloaded or else the file will report that it was not found.
 * 
 * This interface must be provided to the scanner `preloadPaths` so it can load all of the
 * files in the directories ahead of time. None of this is needed if the code will never
 * load any files through include.
 */
export interface PreloadIo {
  listDir(dir: string): string[];
  /** File contents, or `undefined` when the path is unreadable or should not be cached. */
  readFile(path: string): string | Uint8Array | undefined;
}

export interface PreloadOptions {
  /** Cap on files scanned across one call */
  maxFiles?: number;
  /** How deep to recurse. */
  maxDepth?: number;
  /** Directory names that should be skipped. */
  skipDirectories?: ReadonlySet<string>;
  /** Whether to take dotfiles and dot-directories. Off by default. */
  includeHidden?: boolean;
}

/**
 * Dependency and output directories which no `.include` ever reaches into. 
 * Providing a value for `skipDirectories` overrides this list.
 */
export const DEFAULT_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', 'bin', 'build', 'dist', 'out', 'target', 'coverage',
]);

const DEFAULT_MAX_FILES = 8192;
const DEFAULT_MAX_DEPTH = 16;

interface Resolved {
  maxFiles: number;
  maxDepth: number;
  skipDirectories: ReadonlySet<string>;
  includeHidden: boolean;
}

function resolve(opts: PreloadOptions | undefined): Resolved {
  return {
    maxFiles: opts?.maxFiles ?? DEFAULT_MAX_FILES,
    maxDepth: opts?.maxDepth ?? DEFAULT_MAX_DEPTH,
    skipDirectories: opts?.skipDirectories ?? DEFAULT_SKIPPED_DIRECTORIES,
    includeHidden: opts?.includeHidden ?? false,
  };
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export function isCachablePath(absPath: string, opts?: PreloadOptions): boolean {
  const {skipDirectories, includeHidden} = resolve(opts);
  return toPosix(absPath).split('/').every(
      part => (includeHidden || !isHidden(part)) && !skipDirectories.has(part));
}

export function scanDirectory(io: PreloadIo, dir: string, opts?: PreloadOptions): string[] {
  const resolved = resolve(opts);
  return scanWith(io, dir, resolved, 0, {remaining: resolved.maxFiles});
}

function scanWith(io: PreloadIo, dir: string, opts: Resolved, depth: number,
                  budget: {remaining: number}): string[] {
  if (depth > opts.maxDepth || budget.remaining <= 0) return [];
  let entries: string[];
  try {
    entries = io.listDir(dir) ?? [];
  } catch {
    // A missing include directory is a project-config problem so just move on
    return [];
  }
  const out: string[] = [];
  for (const raw of entries) {
    if (budget.remaining <= 0) break;
    const {name, dir: isDir} = parseEntry(raw);
    if (!opts.includeHidden && isHidden(name)) continue;
    const full = joinDir(toPosix(dir), name);
    if (isDir) {
      if (opts.skipDirectories.has(name)) continue;
      out.push(...scanWith(io, full, opts, depth + 1, budget));
    } else {
      budget.remaining--;
      out.push(full);
    }
  }
  return out;
}

/** Reads every file under each directory into a map for the assembler to look it up if needed. */
export function preloadDirectories(io: PreloadIo, dirs: Iterable<string>,
                                   opts?: PreloadOptions): PreloadedFiles {
  const resolved = resolve(opts);
  const budget = {remaining: resolved.maxFiles};
  const files: PreloadedFiles = new Map();
  for (const dir of dirs) {
    for (const found of scanWith(io, dir, resolved, 0, budget)) addFile(io, files, found);
  }
  return files;
}

/** Adds named files (project sources, a linker config) to an existing map. */
export function preloadPaths(io: PreloadIo, paths: Iterable<string>,
                             into: PreloadedFiles = new Map()): PreloadedFiles {
  for (const path of paths) addFile(io, into, path);
  return into;
}

function addFile(io: PreloadIo, files: PreloadedFiles, path: string): void {
  const key = toPosix(path);
  if (files.has(key)) return;
  const content = io.readFile(key);
  if (content !== undefined) files.set(key, content);
}
