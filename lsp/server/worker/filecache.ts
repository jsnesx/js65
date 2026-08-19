// SPDX-License-Identifier: MPL-2.0

import {searchFiles, type FileCallbacks} from '../../../src/libassembler.ts';
import {joinDir} from '../../../src/util.ts';
import {toPosix} from '../project.ts';

export type FileSnapshot = Map<string, string | Uint8Array>;

/** One incremental update to the resident map. Both halves clone natively. */
export interface FileDelta {
  upserts: FileSnapshot;
  deletes: string[];
}

export class FileCache {
  private disk: FileSnapshot = new Map();
  private readonly buffers = new Map<string, string>();
  private readonly decoded = new Map<string, string>();

  /** Replaces the whole disk layer, as on project load or reload. */
  reset(snapshot: FileSnapshot): void {
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

  callbacks(touched: Set<string>): FileCallbacks & {
    readText: (base: string, rel: string) => string,
  } {
    const readText = (base: string, rel: string): string => {
      const posix = joinDir(toPosix(base), toPosix(rel));
      const content = this.getText(posix);
      // Throwing on a miss is what `searchFiles` expects: it swallows the throw and moves
      // on to the next base, and a miss in every base becomes the "could not find" report.
      if (content === undefined) throw new Error(`ENOENT ${posix}`);
      touched.add(posix);
      return content;
    };
    return {
      readText,
      resolveText: searchFiles(readText),
      resolveBinary: searchFiles((base, rel) => {
        const posix = joinDir(toPosix(base), toPosix(rel));
        const content = this.get(posix);
        if (content === undefined) throw new Error(`ENOENT ${posix}`);
        touched.add(posix);
        // A source file read through `.incbin` is legitimate; hand back its bytes.
        return typeof content === 'string' ? new TextEncoder().encode(content) : content;
      }),
    };
  }
}
