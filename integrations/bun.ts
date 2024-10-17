/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */


// Compiler frontend for using the bun single file exe

import { Cli } from '../src/cli.ts';

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
  exit: (code: number) => process.exit(code),
});

export async function main(args: string[]) {
  await cli.run(args);
}

(async () => {
  await main(Bun.argv.slice(2));
})();
