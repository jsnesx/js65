// SPDX-License-Identifier: MPL-2.0

import {nodePreloadIo} from '../../src/driver/preload-node.ts';
import {isCachablePath, preloadDirectories, preloadPaths, scanDirectory,
        type PreloadIo} from '../../src/worker/preload.ts';
import type {FileDelta, PreloadedFiles} from '../../src/worker/filecache.ts';
import {toPosix, type Js65Config} from './project.ts';
import {dirOf} from '../../src/util.ts';

export function watchedFilesGlob(): string {
  return '**/*';
}

export function buildSnapshot(config: Js65Config | undefined, extraPaths: readonly string[] = [],
                              io: PreloadIo = nodePreloadIo()): PreloadedFiles {
  // An `.include` may name any file under a search directory, and which one it picks is
  // decided at assemble time, so scan the directories rather than guessing.
  const dirs = config
      ? config.projects.flatMap(p => [...p.includePaths, ...p.binIncludePaths]) : [];
  const named = config
      ? [config.projectFile,
         ...config.projects.flatMap(p => [
           ...p.sources,
           ...(p.linkerConfigPath ? [p.linkerConfigPath] : []),
         ])]
      : [];
  return preloadPaths(io, [...named, ...extraPaths], preloadDirectories(io, dirs));
}

export function deltaForPath(absPath: string, io: PreloadIo = nodePreloadIo()): FileDelta {
  const key = toPosix(absPath);
  const content = io.readFile(key);
  return content === undefined
      ? {upserts: new Map(), deletes: [key]}
      : {upserts: new Map([[key, content]]), deletes: []};
}

/** Where a snapshot or delta goes. The worker client and an in-process analyzer both fit. */
export interface FileSink {
  setFiles(snapshot: PreloadedFiles): void;
  applyFileDelta(delta: FileDelta): void;
}

export class FileSync {
  /** Paths already pushed, so a delta is only sent for something that actually changed. */
  private readonly known = new Set<string>();
  /** Directories walked for the current project, re-scanned when one of them changes. */
  private scanned: string[] = [];

  /** `io` is swappable for tests, and for a host that mounts a virtual tree. */
  constructor(private readonly sink: FileSink,
              private readonly io: PreloadIo = nodePreloadIo()) {}

  /** Full snapshot for a newly loaded (or reloaded) project config. */
  loadProject(config: Js65Config | undefined, workspaceRoot: string): void {
    const snapshot = buildSnapshot(config, [], this.io);
    this.scanned = config
        ? [...new Set(config.projects.flatMap(p => [...p.includePaths, ...p.binIncludePaths]))]
        : [toPosix(workspaceRoot)];
    this.known.clear();
    for (const key of snapshot.keys()) this.known.add(key);
    this.sink.setFiles(snapshot);
  }

  ensureStandalone(absFile: string, workspaceRoot: string): void {
    const dirs = [dirOf(toPosix(absFile)), toPosix(workspaceRoot)];
    const upserts: PreloadedFiles = new Map();
    for (const dir of dirs) {
      if (this.scanned.includes(dir)) continue;
      this.scanned.push(dir);
      for (const found of scanDirectory(this.io, dir)) {
        if (this.known.has(found)) continue;
        const content = this.io.readFile(found);
        if (content === undefined) continue;
        this.known.add(found);
        upserts.set(found, content);
      }
    }
    if (upserts.size) this.sink.applyFileDelta({upserts, deletes: []});
  }

  /**
   * Push one file's current contents. Called for a watched-file change, a save, or any path
   * the editor reports outside the open-buffer flow.
   */
  push(absPath: string): void {
    // Already-tracked paths still get through: one that made it into the cache has to be able
    // to leave it again, or a delete would strand a stale entry.
    if (!isCachablePath(absPath) && !this.known.has(toPosix(absPath))) return;
    const delta = deltaForPath(absPath, this.io);
    for (const key of delta.upserts.keys()) this.known.add(key);
    for (const key of delta.deletes) this.known.delete(key);
    this.sink.applyFileDelta(delta);
  }

  /** Paths currently believed to be in the worker's disk layer. Diagnostic and test hook. */
  get trackedPaths(): ReadonlySet<string> {
    return this.known;
  }
}
