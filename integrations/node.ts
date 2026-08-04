// SPDX-License-Identifier: MPL-2.0


// Compiler frontend for the Node.js CLI (npm package)

import { Cli } from '../src/cli.ts';
import { resolve } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function writeStdout(data: Uint8Array): Promise<void> {
  return new Promise((res, reject) => {
    process.stdout.write(data, (err) => err ? reject(err) : res());
  });
}

const cli = new Cli({
  fsReadString: async (path: string, filename: string) => {
    const bytes = (filename === Cli.STDIN) ? await readStdin() : await readFile(resolve(path, filename));
    return new TextDecoder().decode(bytes);
  },
  fsReadBytes: async (path: string, filename: string) => {
    return (filename === Cli.STDIN) ? await readStdin() : new Uint8Array(await readFile(resolve(path, filename)));
  },
  fsWriteString: async (path: string, filename: string, data: string) => {
    const d = new TextEncoder().encode(data);
    if (filename === Cli.STDOUT) await writeStdout(d);
    else await writeFile(resolve(path, filename), d);
  },
  fsWriteBytes: async (path: string, filename: string, data: Uint8Array) => {
    if (filename === Cli.STDOUT) await writeStdout(data);
    else await writeFile(resolve(path, filename), data);
  },
  fsWalk: async (path: string, action: (filename: string) => Promise<boolean>) => {
    const entries = await readdir(path, { recursive: true });
    for (const entry of entries) {
      if (await action(entry)) break;
    }
  },
  exit: (code: number) => { process.exitCode = code; },
});

export async function main(args: string[]) {
  await cli.run(args);
}
