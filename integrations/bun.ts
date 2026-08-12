// SPDX-License-Identifier: MPL-2.0


// Compiler frontend for using the bun single file exe

import { Cli } from '../src/driver/cli.ts';

const { dirname, resolve } = require('path');
const { mkdir, readdir } = require('fs').promises;

async function mkdirFor(fullpath: string): Promise<void> {
  await mkdir(dirname(fullpath), { recursive: true });
}

const cli = new Cli({
  fsReadString: async (path: string, filename: string) => {
    const fullpath = resolve(path, (filename === Cli.STDIN) ? '.' : filename);
    return new TextDecoder().decode((filename === Cli.STDIN) ? await Bun.stdin.bytes() : await Bun.file(fullpath).bytes());
  },
  fsReadBytes: async (path: string, filename: string) => {
    const fullpath = resolve(path, (filename === Cli.STDIN) ? '.' : filename);
    return (filename === Cli.STDIN) ? await Bun.stdin.bytes() : await Bun.file(fullpath).bytes();
  },
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
  fsListDir: async (dir: string) => {
    // withFileTypes so directories can be marked; readdir rejects on a missing dir,
    // which is exactly the contract callers rely on.
    const entries = await readdir(resolve(dir), {withFileTypes: true});
    return entries.map((e: {name: string, isDirectory(): boolean}) =>
        e.isDirectory() ? `${e.name}/` : e.name);
  },
  exit: (code: number) => process.exit(code),
});

export async function main(args: string[]) {
  await cli.run(args);
}

// Jank workaround for a bun problem. With the original async await, bun will terminate
// when a missing include happened because that promise failed, and it would exit 0
// So instead of that, we try to gracefully exit as best we can. But to do that we need
// to keep it alive by setting some timer so there's "something" running
const keepAlive = setInterval(() => {}, 1 << 30);
main(Bun.argv.slice(2))
  .then(() => process.exit(process.exitCode ?? 0),
        // run() already printed the diagnostic before rethrowing.
        () => process.exit(1))
  .finally(() => clearInterval(keepAlive));
