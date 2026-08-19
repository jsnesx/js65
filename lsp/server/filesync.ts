// SPDX-License-Identifier: MPL-2.0

import * as fs from 'node:fs';

import {buildSnapshot, deltaForPath, scanDirectory, readCacheEntry,
        isCachablePath} from './filecachebuilder.ts';
import type {FileDelta, FileSnapshot} from './worker/filecache.ts';
import {toPosix, type Js65Config} from './project.ts';
import {dirOf} from '../../src/util.ts';

/** Where a snapshot or delta goes. The worker client and an in-process analyzer both fit. */
export interface FileSink {
  setFiles(snapshot: FileSnapshot): void;
  applyFileDelta(delta: FileDelta): void;
}

export class FileSync {
  /** Paths already pushed, so a delta is only sent for something that actually changed. */
  private readonly known = new Set<string>();
  /** Directories walked for the current project, re-scanned when one of them changes. */
  private scanned: string[] = [];

  constructor(private readonly sink: FileSink, private readonly fsImpl: typeof fs = fs) {}

  /** Full snapshot for a newly loaded (or reloaded) project config. */
  loadProject(config: Js65Config | undefined, workspaceRoot: string): void {
    const snapshot = buildSnapshot(config, [], this.fsImpl);
    this.scanned = config
        ? [...new Set(config.projects.flatMap(p => [...p.includePaths, ...p.binIncludePaths]))]
        : [toPosix(workspaceRoot)];
    this.known.clear();
    for (const key of snapshot.keys()) this.known.add(key);
    this.sink.setFiles(snapshot);
  }

  /**
   * Pull in a standalone file's neighborhood: its own directory and the workspace root, which
   * is what `standaloneProject` uses as include paths. Without this a file opened outside any
   * `js65.json` could not resolve its own sibling headers.
   */
  ensureStandalone(absFile: string, workspaceRoot: string): void {
    const dirs = [dirOf(toPosix(absFile)), toPosix(workspaceRoot)];
    const upserts: FileSnapshot = new Map();
    for (const dir of dirs) {
      if (this.scanned.includes(dir)) continue;
      this.scanned.push(dir);
      for (const found of scanDirectory(dir, this.fsImpl)) {
        const key = toPosix(found);
        if (this.known.has(key)) continue;
        const content = readCacheEntry(found, this.fsImpl);
        if (content === undefined) continue;
        this.known.add(key);
        upserts.set(key, content);
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
    const delta = deltaForPath(absPath, this.fsImpl);
    for (const key of delta.upserts.keys()) this.known.add(key);
    for (const key of delta.deletes) this.known.delete(key);
    this.sink.applyFileDelta(delta);
  }

  /** Paths currently believed to be in the worker's disk layer. Diagnostic and test hook. */
  get trackedPaths(): ReadonlySet<string> {
    return this.known;
  }
}
