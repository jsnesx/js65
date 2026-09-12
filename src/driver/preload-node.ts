// SPDX-License-Identifier: MPL-2.0

import * as fs from 'node:fs';

import type {PreloadIo} from '../worker/preload.ts';

// General max size for an input file to keep from loading things that aren't likely included
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface NodePreloadOptions {
  maxFileBytes?: number;
  /** Swappable for tests and for hosts that mount a virtual tree. */
  fsImpl?: typeof fs;
}

/**
 * Wrapper for the node.js filesystem to allow the preloader to read all files
 * from the directories that are in the include path into memory ahead of time, so
 * that the shared worker can access the data synchronously
 */
export function nodePreloadIo(opts: NodePreloadOptions = {}): PreloadIo {
  const fsImpl = opts.fsImpl ?? fs;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return {
    listDir(dir) {
      const entries = fsImpl.readdirSync(dir, {withFileTypes: true}) as unknown as
          Array<{name: string, isDirectory(): boolean, isFile(): boolean}>;
      // `fsListDir` form: a trailing slash is what marks a directory. Anything that is
      // neither a file nor a directory (a socket, a device) is left out entirely.
      return entries.flatMap(e => e.isDirectory() ? [`${e.name}/`] : e.isFile() ? [e.name] : []);
    },
    readFile(path) {
      try {
        const buf = fsImpl.readFileSync(path) as unknown as Uint8Array;
        if (buf.byteLength > maxBytes) return undefined;
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch {
        // Unreadable is not fatal: a source listed in a project file that no longer exists
        // has to surface as an assembler diagnostic, not as a failure to preload at all.
        return undefined;
      }
    },
  };
}
