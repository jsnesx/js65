// SPDX-License-Identifier: MPL-2.0

import * as fs from 'node:fs';

import type {Js65Config} from './project.ts';
import {toPosix} from './project.ts';
import type {FileDelta, FileSnapshot} from './worker/filecache.ts';

export type {FileDelta, FileSnapshot};

export function watchedFilesGlob(): string {
  return '**/*';
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** This is only for a default scan */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', 'bin', 'build', 'dist', 'out', 'target', 'coverage',
]);

/**
 * Whether a path is one the cache should hold at all. The watcher glob matches every file, so
 * an npm install or a build would otherwise push thousands of entries the assembler will never
 * read; this keeps the watcher's view of the tree the same as the eager scan's.
 */
export function isCachablePath(absPath: string): boolean {
  return toPosix(absPath).split('/').every(
      part => !isHidden(part) && !SKIPPED_DIRECTORIES.has(part));
}

/**
 * Caps on the eager scan, so an include path pointing somewhere enormous degrades into a
 * partial cache rather than a stalled server. A miss is not fatal: the analyzer still falls
 * back to a disk read for anything the host has not pushed.
 */
const MAX_SCANNED_FILES = 8192;
const MAX_CACHED_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Read one file into the snapshot form. Always bytes: whether a file is text is decided by
 * how the assembler reads it, not by its name, so the decode happens at `readText` time.
 * Returns `undefined` rather than throwing when the file is unreadable: a source listed in
 * `js65.json` that no longer exists must surface as an assembler diagnostic on a real
 * document, not as a failure to build the cache at all.
 */
export function readCacheEntry(absPath: string, fsImpl: typeof fs = fs): Uint8Array | undefined {
  try {
    const buf = fsImpl.readFileSync(absPath) as unknown as Uint8Array;
    // Something this large is a build artifact or a ROM, not an `.include` target worth
    // holding resident; leaving it out costs a disk read if the assembler really wants it.
    if (buf.byteLength > MAX_CACHED_FILE_BYTES) return undefined;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return undefined;
  }
}

/**
 * Build the full snapshot for a project config: every source, every file in each include
 * directory, the `js65.json` itself and any linker config.
 */
export function buildSnapshot(config: Js65Config | undefined, extraPaths: readonly string[] = [],
                              fsImpl: typeof fs = fs): FileSnapshot {
  const snapshot: FileSnapshot = new Map();
  const add = (p: string) => {
    const key = toPosix(p);
    if (snapshot.has(key)) return;
    const content = readCacheEntry(p, fsImpl);
    if (content !== undefined) snapshot.set(key, content);
  };

  if (config) {
    add(config.projectFile);
    for (const project of config.projects) {
      for (const source of project.sources) add(source);
      if (project.linkerConfigPath) add(project.linkerConfigPath);
      // An `.include` may name any file under a search directory, and which one it picks is
      // decided at assemble time, so scan the directories rather than guessing.
      for (const dir of [...project.includePaths, ...project.binIncludePaths]) {
        for (const found of scanDirectory(dir, fsImpl)) add(found);
      }
    }
  }
  for (const p of extraPaths) add(p);
  return snapshot;
}

/**
 * Every file under `dir`, whatever it is called: an extension says nothing reliable about
 * whether the assembler will read a file, and plenty of projects use none. Hidden entries,
 * dependency and output directories, and anything past `budget` are left out. Recurses.
 */
export function scanDirectory(dir: string, fsImpl: typeof fs = fs, depth = 0,
                              budget = {remaining: MAX_SCANNED_FILES}): string[] {
  // A pathological symlink loop or a home directory named as an include path would otherwise
  // walk forever; the assembler's own include trees are never this deep.
  if (depth > 16 || budget.remaining <= 0) return [];
  let entries: Array<{name: string, isDirectory(): boolean, isFile(): boolean}>;
  try {
    entries = fsImpl.readdirSync(dir, {withFileTypes: true}) as unknown as typeof entries;
  } catch {
    return []; // A missing include directory is a project-config problem, not a cache problem.
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    if (isHidden(entry.name)) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      out.push(...scanDirectory(full, fsImpl, depth + 1, budget));
    } else if (entry.isFile()) {
      budget.remaining--;
      out.push(full);
    }
  }
  return out;
}

/** One file's worth of delta, as an upsert if it reads or a delete if it no longer does. */
export function deltaForPath(absPath: string, fsImpl: typeof fs = fs): FileDelta {
  const content = readCacheEntry(absPath, fsImpl);
  const key = toPosix(absPath);
  return content === undefined
      ? {upserts: new Map(), deletes: [key]}
      : {upserts: new Map([[key, content]]), deletes: []};
}
