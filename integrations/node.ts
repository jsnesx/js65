// SPDX-License-Identifier: MPL-2.0


// Compiler frontend for the Node.js CLI (npm package)

import { Cli } from '../src/driver/cli.ts';
import { dirname, resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { setGzipCodec } from '../src/driver/codec/codec.ts';
import { nodeZlibCodec } from '../src/driver/codec/node.ts';
import { setJsEngine } from '../src/driver/js/engine.ts';
import { functionEngine } from '../src/driver/js/function.ts';

setGzipCodec(nodeZlibCodec);
setJsEngine(functionEngine);

async function writeAt(path: string, filename: string, data: Uint8Array): Promise<void> {
  const full = resolve(path, filename);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
}

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
  fsReadString: (path: string, filename: string) => {
    return new TextDecoder().decode(readFileSync(resolve(path, filename)));
  },
  fsReadBytes: (path: string, filename: string) => {
    return new Uint8Array(readFileSync(resolve(path, filename)));
  },
  fsReadStdin: readStdin,
  fsWriteString: async (path: string, filename: string, data: string) => {
    const d = new TextEncoder().encode(data);
    if (filename === Cli.STDOUT) await writeStdout(d);
    else await writeAt(path, filename, d);
  },
  fsWriteBytes: async (path: string, filename: string, data: Uint8Array) => {
    if (filename === Cli.STDOUT) await writeStdout(data);
    else await writeAt(path, filename, data);
  },
  fsListDir: (dir: string) => {
    // withFileTypes so directories can be marked; readdirSync throws on a missing dir,
    // which is exactly the contract callers rely on.
    const entries = readdirSync(resolve(dir), { withFileTypes: true });
    return entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
  },
  exit: (code: number) => { process.exitCode = code; },
});

export async function main(args: string[]) {
  await cli.run(args);
}
