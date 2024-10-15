/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Standard 

import { Cli } from './cli.ts';

const { resolve } = require('path');
const { readdir } = require('fs').promises;

const cli = new Cli({
  fsResolve: async (path: string, filename: string) => {
    return await Promise.resolve(resolve(path, (filename === Cli.STDIN) ? '.' : filename));
  },
  fsReadString: async (filename: string) => {
    return new TextDecoder().decode((filename === Cli.STDIN) ? await Bun.stdin.bytes() : await Bun.file(filename).bytes());
  },
  fsReadBytes: async (filename: string) => {
    return (filename === Cli.STDIN) ? await Bun.stdin.bytes() : await Bun.file(filename).bytes();
  },
  fsWriteString: async (filename: string, data: string) => {
    const d = new TextEncoder().encode(data);
    filename === Cli.STDOUT ? await Bun.write(Bun.stdout, d) : await Bun.write(filename, d);
  },
  fsWriteBytes: async (filename: string, data: Uint8Array) => {
    filename === Cli.STDOUT ? await Bun.write(Bun.stdout, data) : await Bun.write(filename, data);
  },
  fsWalk: async (path: string, action: (filename: string) => Promise<boolean>) => {
    for await (const dir of readdir(path, {recursive: true})) {
      if (await action(dir.path)) {
        break;
      }
    }
  },
  cryptoSha1: (data: Uint8Array) => {
    const hasher = new Bun.CryptoHasher("sha1");
    hasher.update(data);
    return hasher.digest().buffer as ArrayBuffer;
  },
  exit: (code: number) => process.exit(code),
});

export async function main(args: string[]) {
  await cli.run(args);
}

(async () => {
  await main(Bun.argv.slice(2));
})();

// await main(Deno.args);

// Deno.bench("building z2disassembly", async() => {
//   await cli.run([
//     "-o", "build/test.nes",
//     "-IC:\\dev\\z2disassembly\\inc\\",
//     "-IC:\\dev\\z2disassembly\\src\\",
//     "C:\\dev\\z2disassembly\\src\\cfg.s",
//     "C:\\dev\\z2disassembly\\src\\prg0.s",
//     "C:\\dev\\z2disassembly\\src\\prg1.s",
//     "C:\\dev\\z2disassembly\\src\\prg2.s",
//     "C:\\dev\\z2disassembly\\src\\prg3.s",
//     "C:\\dev\\z2disassembly\\src\\prg4.s",
//     "C:\\dev\\z2disassembly\\src\\prg5.s",
//     "C:\\dev\\z2disassembly\\src\\prg6.s",
//     "C:\\dev\\z2disassembly\\src\\prg7.s"
//   ]);
// });
