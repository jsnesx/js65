// SPDX-License-Identifier: MPL-2.0

// This is a quickjs based frontend which pretty much only exists for
// benchmarks and showing why we aren't using it for anything serious.

import { Cli } from '../src/driver/cli.ts';
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

/** Create every missing directory along `dir`, so writes can target a fresh tree. */
function mkdirp(dir: string): void {
  if (!dir || dir === '.' || dir === '/') return;
  const parts = dir.split(/[\\/]/);
  let sofar = dir.startsWith('/') ? '/' : '';
  for (const part of parts) {
    if (!part) continue;
    sofar = sofar && sofar !== '/' ? `${sofar}/${part}` : `${sofar}${part}`;
    os.mkdir(sofar, 0o777); // already-exists is reported as an errno we ignore
  }
}

function parentDir(fullpath: string): string {
  const i = Math.max(fullpath.lastIndexOf('/'), fullpath.lastIndexOf('\\'));
  return i < 0 ? '' : fullpath.substring(0, i);
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
    const full = resolvePath(path, filename);
    mkdirp(parentDir(full));
    writeFileBytes(full, new TextEncoder().encode(data));
  },
  fsWriteBytes: async (path: string, filename: string, data: Uint8Array): Promise<void> => {
    if (filename === Cli.STDOUT) { std.out.write(data.buffer, data.byteOffset, data.byteLength); std.out.flush(); return; }
    const full = resolvePath(path, filename);
    mkdirp(parentDir(full));
    writeFileBytes(full, data);
  },
  fsListDir: async (dir: string): Promise<string[]> => {
    const [names, err] = os.readdir(dir);
    if (err) throw new Error(`Could not list directory: ${dir}`);
    const out: string[] = [];
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const [st, serr] = os.stat(resolvePath(dir, name));
      out.push(!serr && (st.mode & os.S_IFMT) === os.S_IFDIR ? `${name}/` : name);
    }
    return out;
  },
  exit: (code: number) => std.exit(code),
});

export async function main(args: string[]) {
  await cli.run(args);
}

// In a qjs -c standalone executable, `scriptArgs` is exactly the user args
main(scriptArgs);
