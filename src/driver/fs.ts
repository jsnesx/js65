
// SPDX-License-Identifier: MPL-2.0

import { joinDir } from '../util.ts';


/** Integration specific filesystem access callbacks. */
export interface Callbacks {
  fsReadString: (path: string, filename: string) => Promise<string>,
  fsReadBytes: (path: string, filename: string) => Promise<Uint8Array|string>,
  /** Creates any missing parent directories before writing. */
  fsWriteString: (path: string, filename: string, data: string) => Promise<void>,
  /** Creates any missing parent directories before writing. */
  fsWriteBytes: (path: string, filename: string, data: Uint8Array) => Promise<void>,
  /** List all paths in a directory, not recursive. */
  fsListDir: (dir: string) => Promise<string[]>,
  exit: (code: number) => void,
}

/** Just the listing capability, for helpers that don't need the rest. */
export type DirLister = Pick<Callbacks, 'fsListDir'>;

/** Split one `fsListDir` entry into its name and whether it is a directory. */
export function parseEntry(entry: string): {name: string, dir: boolean} {
  return entry.endsWith('/')
      ? {name: entry.substring(0, entry.length - 1), dir: true}
      : {name: entry, dir: false};
}

/**
 * Depth-first walk of every file under `root`, yielding paths joined onto `root`.
 * `visit` returning true stops the walk early and makes this return true.
 */
export async function walkFiles(
    cb: DirLister, root: string,
    visit: (file: string) => Promise<boolean>): Promise<boolean> {
  let entries: string[];
  try {
    entries = await cb.fsListDir(root);
  } catch {
    return false;
  }
  for (const entry of [...entries].sort()) {
    const {name, dir} = parseEntry(entry);
    const full = joinDir(root, name);
    if (dir) {
      if (await walkFiles(cb, full, visit)) return true;
    } else if (await visit(full)) {
      return true;
    }
  }
  return false;
}
