
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {Cli} from '../src/cli.ts'
import { toHexString } from "../src/util.ts";

describe('CLI', function() {
  describe('STDIN', function() {
    it('should handle `lda #$03`', async function() {
      const out = "";
      await make(`lda #3`, out).run(["--target", "sim", "--stdin"]);
      expect(out.length > 0, "output should not be empty");
      console.log(`output ${out.length} data: ${out}`)
    });
  });
});

function make(input: string, output: string) : Cli {
  return new Cli({
    fsResolve: async (path: string, filename: string) => {
      return await Promise.resolve(path + filename);
    },
    fsReadString: async (_filename: string) => {
      return await Promise.resolve(input);
    },
    fsReadBytes: async (_filename: string) => {
      return await Promise.resolve(new TextEncoder().encode(input));
    },
    fsWriteString: async (_filename: string, data: string) => {
      output.concat(data);
      return await Promise.resolve(undefined);
    },
    fsWriteBytes: async (_filename: string, data: Uint8Array) => {
      console.log(`decoded: ${toHexString(data)}`);
      output.concat(new TextDecoder().decode(data));
      return await Promise.resolve(undefined);
    },
    fsWalk: async (_path: string, _action: (filename: string) => Promise<boolean>) => {
      // unused for now
      return await Promise.resolve(undefined);
    },
    cryptoSha1: (data: Uint8Array) => {
      const hasher = new Bun.CryptoHasher("sha1");
      hasher.update(data);
      return hasher.digest().buffer as ArrayBuffer;
    },
    exit: (code: number) => process.exit(code),
  });
}
