/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Compiler frontend for the Static Hermes (shermes) native build. Mirrors
// integrations/bun.ts / integrations/quickjs.ts, but Hermes exposes no fs,
// argv, stdin or stdout to JS, so all host I/O goes through the __js65_*
// functions installed on globalThis by the C++ host (integrations/hermes/hermes_host.cpp).
// A UTF-8 TextEncoder/TextDecoder polyfill is provided since Hermes ships none.

import { Cli } from '../../src/cli.ts';
import { compileRequest } from '../../src/libassembler.ts';

// Host functions installed by the C++ host (hermes_core.cpp + the active entry).
declare const __js65_args: () => string[];
// Reads take the include base and requested file separately so the host resolves them:
// the CLI joins them and reads disk; the shared library forwards to the caller's pointers.
declare const __js65_cbReadText: (basePath: string, relPath: string) => string;
declare const __js65_cbReadBinary: (basePath: string, relPath: string) => Uint8Array;
declare const __js65_writeText: (fullpath: string, data: string) => void;
declare const __js65_writeBytes: (fullpath: string, data: Uint8Array) => void;
declare const __js65_listFiles: (dir: string) => string[];
declare const __js65_exit: (code: number) => void;
// CLI-only I/O.
declare const __js65_stdinText: () => string;
declare const __js65_stdinBytes: () => Uint8Array;
declare const __js65_stdoutText: (data: string) => void;
declare const __js65_stdoutBytes: (data: Uint8Array) => void;
// Shared-library result building: the host assembles a typed Js65Result struct from these
// calls rather than parsing a serialized string. __js65_resultAddMessage returns the new
// message's index; source frames are pushed innermost-first up the include/macro stack.
declare const __js65_request: () => string;
declare const __js65_baseRom: () => Uint8Array;
// Polled by the assembler core; reads the host-owned cancel flag set from another thread.
declare const __js65_cancelled: () => boolean;
declare const __js65_resultBegin: (success: boolean) => void;
declare const __js65_resultAddOutput: (name: string, data: Uint8Array, type: string) => void;
declare const __js65_resultAddMessage: (level: string, message: string, stack: string | null) => number;
declare const __js65_resultAddSourceFrame: (
  messageIndex: number, ident: string | null, file: string, line: number, column: number) => void;

// --- UTF-8 TextEncoder / TextDecoder polyfill ----------------------------
class Utf8Encoder {
  encode(str: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return new Uint8Array(out);
  }
}

class Utf8Decoder {
  decode(input: Uint8Array | ArrayBuffer): string {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let out = '';
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i++];
      let cp: number;
      if (b < 0x80) {
        cp = b;
      } else if (b < 0xe0) {
        cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
      } else if (b < 0xf0) {
        cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      } else {
        cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      }
      if (cp > 0xffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
    }
    return out;
  }
}

const g = globalThis as Record<string, unknown>;
if (typeof g.TextEncoder === 'undefined') g.TextEncoder = Utf8Encoder;
if (typeof g.TextDecoder === 'undefined') g.TextDecoder = Utf8Decoder;

// Strip a leading UTF-8 BOM from input source files. js65 internals aren't setup to handle that atm.
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function resolvePath(base: string, file: string): string {
  if (!file || file === '.') return base || '.';
  // Absolute path (POSIX or Windows drive/UNC)?
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(file)) return file;
  if (!base || base === '.') return file;
  const tail = base.endsWith('/') || base.endsWith('\\') ? '' : '/';
  return base + tail + file;
}

const cli = new Cli({
  fsReadString: async (path: string, filename: string): Promise<string> => {
    if (filename === Cli.STDIN) return __js65_stdinText();
    return stripBom(__js65_cbReadText(path, filename));
  },
  fsReadBytes: async (path: string, filename: string): Promise<Uint8Array> => {
    return (filename === Cli.STDIN) ? __js65_stdinBytes() : __js65_cbReadBinary(path, filename);
  },
  fsWriteString: async (path: string, filename: string, data: string): Promise<void> => {
    if (filename === Cli.STDOUT) { __js65_stdoutText(data); return; }
    __js65_writeText(resolvePath(path, filename), data);
  },
  fsWriteBytes: async (path: string, filename: string, data: Uint8Array): Promise<void> => {
    if (filename === Cli.STDOUT) { __js65_stdoutBytes(data); return; }
    __js65_writeBytes(resolvePath(path, filename), data);
  },
  fsWalk: async (path: string, action: (filename: string) => Promise<boolean>): Promise<void> => {
    // The host walks the directory tree natively and returns every file path.
    for (const file of __js65_listFiles(path)) {
      if (await action(file)) return;
    }
  },
  exit: (code: number) => __js65_exit(code),
});

// `--lib` mode: backs the in-process .NET js65.hermes engine. The result is handed to the
// host as a typed struct (built via the __js65_result* calls) rather than a serialized
// string, so the ABI in js65.h stays explicit.
async function runLibraryMode(): Promise<void> {
  const callbacks = {
    readText: async (basePath: string, filePath: string): Promise<string> =>
      stripBom(__js65_cbReadText(basePath, filePath)),
    readBinary: async (basePath: string, filePath: string): Promise<Uint8Array> =>
      __js65_cbReadBinary(basePath, filePath),
  };

  // Bare CancelSignal that polls the host cancel flag (Hermes ships no AbortController). The
  // core reads .aborted at per-line / per-chunk boundaries; another thread flips the flag.
  const signal = { get aborted() { return __js65_cancelled(); } };

  const baseRom = __js65_baseRom();
  const result = await compileRequest(__js65_request(), callbacks, baseRom.length ? baseRom : undefined, signal);

  __js65_resultBegin(result.success);
  for (const output of result.outputs) {
    __js65_resultAddOutput(output.name, output.data, output.type);
  }
  for (const m of result.messages) {
    const index = __js65_resultAddMessage(m.level, m.message, m.stack ?? null);
    for (let s = m.source; s; s = s.parent) {
      __js65_resultAddSourceFrame(index, s.ident ?? null, s.file, s.line, s.column);
    }
  }
}

async function main(args: string[]) {
  if (args.includes('--lib')) {
    await runLibraryMode();
    return;
  }
  await cli.run(args);
}

main(__js65_args());
