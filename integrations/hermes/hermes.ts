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
import { Base64, compileActionsBrowser } from '../../src/libassembler.ts';

// Host functions installed by hermes_host.cpp.
declare const __js65_args: () => string[];
declare const __js65_readText: (fullpath: string) => string;
declare const __js65_readBytes: (fullpath: string) => Uint8Array;
declare const __js65_writeText: (fullpath: string, data: string) => void;
declare const __js65_writeBytes: (fullpath: string, data: Uint8Array) => void;
declare const __js65_stdinText: () => string;
declare const __js65_stdinBytes: () => Uint8Array;
declare const __js65_stdoutText: (data: string) => void;
declare const __js65_stdoutBytes: (data: Uint8Array) => void;
declare const __js65_listFiles: (dir: string) => string[];
declare const __js65_exit: (code: number) => void;

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
    return stripBom(__js65_readText(resolvePath(path, filename)));
  },
  fsReadBytes: async (path: string, filename: string): Promise<Uint8Array> => {
    return (filename === Cli.STDIN) ? __js65_stdinBytes() : __js65_readBytes(resolvePath(path, filename));
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

// `--json` mode: read one request envelope from stdin, forward it to the
// existing compileActionsBrowser, and write the base64 result to stdout. This
// backs the js65.desktop subprocess engine.
async function runJsonMode(): Promise<void> {
  const env = JSON.parse(__js65_stdinText());

  const readText = (basePath: string, filePath: string): string => {
    return stripBom(__js65_readText(resolvePath(basePath, filePath)));
  };
  const readBinary = (basePath: string, filePath: string): string => {
    return new Base64().encode(__js65_readBytes(resolvePath(basePath, filePath)));
  };

  const result = await compileActionsBrowser(
    JSON.stringify(env.modules ?? []),
    JSON.stringify(env.assemblerOpts ?? {}),
    JSON.stringify(env.linkerOpts ?? {}),
    env.outputFormat ?? 'binary',
    readText,
    readBinary,
    env.useSourceContents ?? false,
  );

  __js65_stdoutText(result);
}

async function main(args: string[]) {
  if (args.includes('--json')) {
    await runJsonMode();
    return;
  }
  await cli.run(args);
}

main(__js65_args());
