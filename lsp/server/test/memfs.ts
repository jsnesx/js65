// SPDX-License-Identifier: MPL-2.0

/**
 * Tiny in-memory filesystem for tests. Implements just the slice of `node:fs`
 * the analyzer + project modules actually call — enough to read project
 * files and assemble sources without touching disk.
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
    /**
     * Only the `{withFileTypes: true}` form, which is all `loadProject` uses to
     * expand `sources` globs. Directories are inferred from the file keys.
     */
    readdirSync: (p: string, _opts?: unknown): Array<{name: string, isDirectory(): boolean}> => {
      const dir = norm(p).replace(/\/+$/, '');
      const prefix = dir === '' || dir === '.' ? '' : `${dir}/`;
      const names = new Map<string, boolean>();
      for (const key of Object.keys(this.files)) {
        if (prefix && !key.startsWith(prefix)) continue;
        const rest = key.substring(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.substring(0, slash);
        names.set(name, slash >= 0 || names.get(name) === true);
      }
      if (!names.size) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return [...names].map(([name, isDir]) => ({name, isDirectory: () => isDir}));
    },
  };

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
