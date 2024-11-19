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
    filename === Cli.STDOUT ? await Bun.write(Bun.stdout, d) : await Bun.write(fullpath, d);
  },
  fsWriteBytes: async (path: string, filename: string, data: Uint8Array) => {
    const fullpath = resolve(path, (filename === Cli.STDIN) ? '.' : filename);
    filename === Cli.STDOUT ? await Bun.write(Bun.stdout, data) : await Bun.write(fullpath, data);
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
