// SPDX-License-Identifier: MPL-2.0

/**
 * Tiny in-memory filesystem for tests. Implements just the slice of
 * `node:fs` / `node:fs/promises` the analyzer + project modules actually
 * call — enough to read project files and assemble sources without touching
 * disk.
 */

export interface MemFsFile {
  /** File contents. */
  content: string;
  /** Marks the file as binary (e.g. for `.incbin` tests). Stored as utf-8. */
  binary?: boolean;
}

/** A simple in-memory file tree keyed by absolute POSIX path. */
export class MemFs {
  constructor(private files: Record<string, MemFsFile> = {}) {}

  /** Node-style sync fs wrapper. */
  readonly sync = {
    statSync: (p: string): {isFile(): boolean} => {
      const key = norm(p);
      if (this.files[key]) return {isFile: () => true};
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
    readFileSync: (p: string, _enc?: string): string => {
      const key = norm(p);
      const f = this.files[key];
      if (!f) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return f.content;
    },
  };

  /**
   * Optional per-read delay, in ms, keyed by path suffix. Lets a test make one
   * file slow to read so two analysis passes overlap.
   */
  readDelays: Array<{match: string, ms: number}> = [];

  /**
   * fs/promises wrapper. Honors the encoding argument the way `node:fs` does —
   * a string when one is given, a Buffer otherwise. Returning a Buffer
   * unconditionally hands the tokenizer a non-string and it fails deep inside
   * the buffer helpers rather than at the call site.
   */
  readonly promises = {
    readFile: async (p: string, enc?: string): Promise<Buffer | string> => {
      const key = norm(p);
      const delay = this.readDelays.find(d => key.endsWith(d.match));
      if (delay) await new Promise(r => setTimeout(r, delay.ms));
      const f = this.files[key];
      if (!f) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return enc ? f.content : Buffer.from(f.content, 'utf8');
    },
  };

  /** Test helper: make reads of any path ending in `match` take `ms`. */
  delay(match: string, ms: number): this {
    this.readDelays.push({match, ms});
    return this;
  }

  /** Test helper: remove a file (simulating a delete while the editor is open). */
  remove(p: string): this {
    delete this.files[norm(p)];
    return this;
  }

  /** Test helper: add a file by POSIX path. */
  add(p: string, content: string, binary = false): this {
    this.files[norm(p)] = {content, binary};
    return this;
  }

  /** Test helper: does the file exist? */
  has(p: string): boolean {
    return Boolean(this.files[norm(p)]);
  }
}

/** Normalize an OS path to POSIX, dedup slashes. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}
