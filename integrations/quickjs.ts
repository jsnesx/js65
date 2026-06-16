/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Cli } from '../src/cli.ts';
import { Base64, compileActionsBrowser } from '../src/libassembler.ts';
// @ts-expect-error quickjs builtin module
import * as std from 'qjs:std';
// @ts-expect-error quickjs builtin module
import * as os from 'qjs:os';

declare const scriptArgs: string[];

// Strip a leading UTF-8 BOM from source files, js65 internals aren't setup to handle that atm.
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
    return stripBom(data);
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
    return stripBom(s);
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
