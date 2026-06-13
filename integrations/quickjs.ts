/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Compiler frontend for the quickjs-ng standalone executable (qjs -c).
// Mirrors integrations/bun.ts but uses the quickjs `qjs:std` / `qjs:os`
// modules instead of the Bun.* APIs, and provides a UTF-8 TextEncoder/
// TextDecoder polyfill since quickjs-ng does not ship them.

import { Cli } from '../src/cli.ts';
import { Base64, compileActionsBrowser } from '../src/libassembler.ts';
// @ts-expect-error quickjs builtin module
import * as std from 'qjs:std';
// @ts-expect-error quickjs builtin module
import * as os from 'qjs:os';

declare const scriptArgs: string[];

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

// --- filesystem helpers --------------------------------------------------
function resolvePath(base: string, file: string): string {
  if (!file || file === '.') return base || '.';
  // Absolute path (POSIX or Windows drive/UNC)?
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(file)) return file;
  if (!base || base === '.') return file;
  const tail = base.endsWith('/') || base.endsWith('\\') ? '' : '/';
  return base + tail + file;
}

function readFileBytes(fullpath: string): Uint8Array {
  const f = std.open(fullpath, 'rb');
  if (!f) throw new Error(`Could not open file: ${fullpath}`);
  f.seek(0, std.SEEK_END);
  const size = f.tell();
  f.seek(0, std.SEEK_SET);
  const buf = new Uint8Array(size);
  if (size > 0) f.read(buf.buffer, 0, size);
  f.close();
  return buf;
}

function writeFileBytes(fullpath: string, data: Uint8Array): void {
  const f = std.open(fullpath, 'wb');
  if (!f) throw new Error(`Could not open file for writing: ${fullpath}`);
  if (data.byteLength > 0) f.write(data.buffer, data.byteOffset, data.byteLength);
  f.close();
}

function readAllStdinBytes(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const chunk = new Uint8Array(65536);
  let total = 0;
  while (true) {
    const n = std.in.read(chunk.buffer, 0, chunk.length);
    if (n <= 0) break;
    chunks.push(chunk.slice(0, n));
    total += n;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function walk(dir: string, action: (filename: string) => Promise<boolean>): Promise<boolean> {
  const [names, err] = os.readdir(dir);
  if (err) return false;
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const full = resolvePath(dir, name);
    const [st, serr] = os.stat(full);
    if (serr) continue;
    if ((st.mode & os.S_IFMT) === os.S_IFDIR) {
      if (await walk(full, action)) return true;
    } else if (await action(full)) {
      return true;
    }
  }
  return false;
}

const cli = new Cli({
  fsReadString: async (path: string, filename: string): Promise<string> => {
    if (filename === Cli.STDIN) return std.in.readAsString();
    const data = std.loadFile(resolvePath(path, filename));
    if (data === null) throw new Error(`Could not read file: ${resolvePath(path, filename)}`);
    return data;
  },
  fsReadBytes: async (path: string, filename: string): Promise<Uint8Array> => {
    return (filename === Cli.STDIN) ? readAllStdinBytes() : readFileBytes(resolvePath(path, filename));
  },
  fsWriteString: async (path: string, filename: string, data: string): Promise<void> => {
    if (filename === Cli.STDOUT) { std.out.puts(data); std.out.flush(); return; }
    writeFileBytes(resolvePath(path, filename), new TextEncoder().encode(data));
  },
  fsWriteBytes: async (path: string, filename: string, data: Uint8Array): Promise<void> => {
    if (filename === Cli.STDOUT) { std.out.write(data.buffer, data.byteOffset, data.byteLength); std.out.flush(); return; }
    writeFileBytes(resolvePath(path, filename), data);
  },
  fsWalk: async (path: string, action: (filename: string) => Promise<boolean>): Promise<void> => {
    await walk(path, action);
  },
  exit: (code: number) => std.exit(code),
});

// `--json` mode: read one request envelope from stdin, forward it to the
// existing compileActionsBrowser, and write the base64 result to stdout. This
// backs the js65.desktop subprocess engine.
async function runJsonMode(): Promise<void> {
  const env = JSON.parse(std.in.readAsString());

  const readText = (basePath: string, filePath: string): string => {
    const s = std.loadFile(resolvePath(basePath, filePath));
    if (s === null) throw new Error(`Could not read file: ${resolvePath(basePath, filePath)}`);
    return s;
  };
  const readBinary = (basePath: string, filePath: string): string => {
    return new Base64().encode(readFileBytes(resolvePath(basePath, filePath)));
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

  std.out.puts(result);
  std.out.flush();
}

export async function main(args: string[]) {
  if (args.includes('--json')) {
    await runJsonMode();
    return;
  }
  await cli.run(args);
}

// In a qjs -c standalone executable, `scriptArgs` is exactly the user args
main(scriptArgs);
