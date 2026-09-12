// SPDX-License-Identifier: MPL-2.0

import {searchFiles, type FileCallbacks} from '../libassembler.ts';
import {joinDir} from '../util.ts';
import {toPosix} from '../driver/project.ts';

/**
 * Absolute POSIX path -> contents.
 * Text entries are source and byte entries are raw files.
 */
export type PreloadedFiles = Map<string, string | Uint8Array>;

/** One incremental update to a resident cache. Both halves clone natively. */
export interface FileDelta {
  upserts: PreloadedFiles;
  deletes: string[];
}

/** What `callbacks()` hands back: the assembler's hooks plus the raw text reader. */
export type CacheCallbacks = FileCallbacks & {
  readText: (base: string, rel: string) => string,
};

/**
 * A map of files standing in for a filesystem, with an optional layer of open editor buffers
 * on top of it. This is what both the compile worker and the LSP analyzer resolve
 * `.include`/`.incbin` against, so that a path resolves the same way in both.
 */
export class FileCache {
  private disk: PreloadedFiles = new Map();
  private readonly buffers = new Map<string, string>();
  private readonly decoded = new Map<string, string>();

  /** Replaces the whole disk layer, as on project load or reload. */
  reset(snapshot: PreloadedFiles): void {
    this.disk = new Map(snapshot);
    this.decoded.clear();
  }

  /** Applies one incremental update to the disk layer. */
  apply(delta: FileDelta): void {
    for (const [path, content] of delta.upserts) {
      const key = toPosix(path);
      this.disk.set(key, content);
      this.decoded.delete(key);
    }
    for (const path of delta.deletes) {
      const key = toPosix(path);
      this.disk.delete(key);
      this.decoded.delete(key);
    }
  }

  /** Merges files into the disk layer without disturbing anything already there. */
  upsert(files: PreloadedFiles): void {
    if (files.size) this.apply({upserts: files, deletes: []});
  }

  /** Mirrors an open editor buffer, which shadows whatever is on disk. */
  openBuffer(path: string, text: string): void {
    this.buffers.set(toPosix(path), text);
  }

  /** Drops an open buffer, so the disk copy shows through again. */
  closeBuffer(path: string): void {
    this.buffers.delete(toPosix(path));
  }

  /** Contents at an absolute POSIX path, buffer first, or `undefined` for a miss. */
  get(path: string): string | Uint8Array | undefined {
    const key = toPosix(path);
    return this.buffers.get(key) ?? this.disk.get(key);
  }

  /**
   * Contents as text, decoding a byte entry and remembering the result. A preloader reading
   * a directory cannot know which files are source, so it stores bytes for everything; a
   * byte entry that `.include` asks for is source by virtue of having been asked for.
   */
  getText(path: string): string | undefined {
    const key = toPosix(path);
    const buffer = this.buffers.get(key);
    if (buffer !== undefined) return buffer;
    const cached = this.decoded.get(key);
    if (cached !== undefined) return cached;
    const content = this.disk.get(key);
    if (content === undefined) return undefined;
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    this.decoded.set(key, text);
    return text;
  }

  has(path: string): boolean {
    return this.get(path) !== undefined;
  }

  /** Number of entries in the disk layer. Diagnostic; the buffer layer is separate. */
  get size(): number {
    return this.disk.size;
  }

  /**
   * The assembler's file hooks over this cache. `touched`, when given, collects every path
   * actually read, which is how the LSP knows which files a project's diagnostics depend on.
   */
  callbacks(touched?: Set<string>): CacheCallbacks {
    const readText = (base: string, rel: string): string => {
      const posix = joinDir(toPosix(base), toPosix(rel));
      const content = this.getText(posix);
      // Throwing on a miss is what `searchFiles` expects: it swallows the throw and moves
      // on to the next base, and a miss in every base becomes the "could not find" report.
      if (content === undefined) throw new Error(`ENOENT ${posix}`);
      touched?.add(posix);
      return content;
    };
    return {
      readText,
      resolveText: searchFiles(readText),
      resolveBinary: searchFiles((base, rel) => {
        const posix = joinDir(toPosix(base), toPosix(rel));
        const content = this.get(posix);
        if (content === undefined) throw new Error(`ENOENT ${posix}`);
        touched?.add(posix);
        // `compile` reads a string here as base64, which would silently corrupt a text file
        // pulled in with `.incbin`. Entries in this map are never base64, so encode instead.
        return typeof content === 'string' ? new TextEncoder().encode(content) : content;
      }),
    };
  }
}

/** One-shot callbacks over a map, for a caller with no resident cache to keep. */
export function fileCallbacksFor(files: PreloadedFiles): FileCallbacks {
  const cache = new FileCache();
  cache.reset(files);
  return cache.callbacks();
}
