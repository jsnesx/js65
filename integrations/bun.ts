// SPDX-License-Identifier: MPL-2.0


// Compiler frontend for using the bun single file exe

import { Cli } from '../src/driver/cli.ts';
import { setGzipCodec } from '../src/driver/codec/codec.ts';
import { bunCodec } from '../src/driver/codec/bun.ts';
import { setJsEngine } from '../src/driver/js/engine.ts';
import { functionEngine } from '../src/driver/js/function.ts';

setGzipCodec(bunCodec);
setJsEngine(functionEngine);

const { dirname, resolve } = require('path');
const { mkdir } = require('fs').promises;
const { readFileSync, readdirSync } = require('fs');

async function mkdirFor(fullpath: string): Promise<void> {
  await mkdir(dirname(fullpath), { recursive: true });
}

async function readStdin(): Promise<Uint8Array> {
  return await Bun.stdin.bytes();
}

const cli = new Cli({
  fsReadString: (path: string, filename: string) => {
    return new TextDecoder().decode(readFileSync(resolve(path, filename)));
  },
  fsReadBytes: (path: string, filename: string) => {
    return new Uint8Array(readFileSync(resolve(path, filename)));
  },
  fsReadStdin: readStdin,
  fsWriteString: async (path: string, filename: string, data: string) => {
    const fullpath = resolve(path, (filename === Cli.STDIN) ? '.' : filename);
    const d = new TextEncoder().encode(data);
    if (filename === Cli.STDOUT) { await Bun.write(Bun.stdout, d); return; }
    await mkdirFor(fullpath);
    await Bun.write(fullpath, d);
  },
  fsWriteBytes: async (path: string, filename: string, data: Uint8Array) => {
    const fullpath = resolve(path, (filename === Cli.STDIN) ? '.' : filename);
    if (filename === Cli.STDOUT) { await Bun.write(Bun.stdout, data); return; }
    await mkdirFor(fullpath);
    await Bun.write(fullpath, data);
  },
  fsListDir: (dir: string) => {
    // withFileTypes so directories can be marked; readdirSync throws on a missing dir,
    // which is exactly the contract callers rely on.
    const entries = readdirSync(resolve(dir), {withFileTypes: true});
    return entries.map((e: {name: string, isDirectory(): boolean}) =>
        e.isDirectory() ? `${e.name}/` : e.name);
  },
  exit: (code: number) => process.exit(code),
});

export async function main(args: string[]) {
  await cli.run(args);
}

main(Bun.argv.slice(2))
  .then(() => process.exit(process.exitCode ?? 0),
        // run() already printed the diagnostic before rethrowing.
        () => process.exit(1));
