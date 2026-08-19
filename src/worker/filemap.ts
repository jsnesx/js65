
// SPDX-License-Identifier: MPL-2.0

import { searchFiles, type FileCallbacks } from '../libassembler.ts';
import { joinDir } from '../util.ts';
import { toPosix } from '../driver/project.ts';

export type PreloadedFiles = Map<string, string | Uint8Array>;

export function fileCallbacksFor(files: PreloadedFiles): FileCallbacks {
  const lookup = (base: string, filename: string): string | Uint8Array | undefined =>
      files.get(joinDir(toPosix(base), toPosix(filename)));
  return {
    resolveText: searchFiles((base, filename) => {
      const content = lookup(base, filename);
      // A binary entry is not a source file; treat it as a miss rather than decoding
      // bytes nobody asked to be text.
      return typeof content === 'string' ? content : undefined;
    }),
    resolveBinary: searchFiles((base, filename) => {
      const content = lookup(base, filename);
      // `compile` reads a string here as base64, which would silently corrupt a text file
      // pulled in with `.incbin`. Entries in this map are never base64, so encode instead.
      return typeof content === 'string' ? new TextEncoder().encode(content) : content;
    }),
  };
}
