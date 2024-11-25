
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {Cli} from '../src/cli.ts'
import { toHexViewString, toHexString, fromHexString, fromByteString } from "../src/util.ts";

describe('CLI', function() {
  describe('STDIN', function() {
    it('should handle `lda #$03`', async function() {
      const [out, data] = await make(["--target", "sim", "--stdin"], `lda #3`);
      expect(data.length, "output should not be empty").toBeGreaterThan(0);
      console.log(`output ${out} data: ${toHexViewString(data)}`)
    });

    const bgHexStr = '00 01 02 03';
    const bg = fromHexString(bgHexStr);
    it('should handle `lda #$03` on top of binary `${bgHexStr}`', async function() {
      const [out, data] = await make(["--target", "sim", "--stdin", "--rom", "dummy"], `lda #3`, bg);
      expect(data).toEqual(fromHexString('A9 03 02 03'));
      console.log(`output ${out.length} data: ${out}`)
    });

    it('test IPS patch generation', async function() {
      const [out, data] = await make(["--target", "sim", "--stdin", "--rom", "dummy", "--ips"], `lda #3`, bg);
      expect(data).toEqual(fromByteString('PATCH\0\0\0\0\x02\xa9\x03EOF'));
      console.log(`output ${out.length} data: ${out}`)
    });
  });
});

async function make(args: string[], input: string, bytes: Uint8Array|null = null) : Promise<[string, Uint8Array]> {
  const outParts: string[] = [];
  const dataParts: Uint8Array[] = [];
  const cli = new Cli({
    fsReadString: async (_path: string, _filename: string) => {
      return await Promise.resolve(input);
    },
    fsReadBytes: async (_path: string, _filename: string) => {
      return await Promise.resolve(bytes ?? new Uint8Array(0));
    },
    fsWriteString: async (_path: string, _filename: string, data: string) => {
      outParts.push(data);
      return await Promise.resolve(undefined);
    },
    fsWriteBytes: async (_path: string, _filename: string, data: Uint8Array) => {
      console.log(`decoded: ${toHexViewString(data)}`);
      dataParts.push(data)
      return await Promise.resolve(undefined);
    },
    fsWalk: async (_path: string, _action: (filename: string) => Promise<boolean>) => {
      // unused for now
      return await Promise.resolve(undefined);
    },
    exit: (code: number) => process.exit(code),
  });

  await cli.run(args);
  
  const data = new Uint8Array(dataParts.map((p) => Array.from(p)).reduce((a, p) => a.concat(p), []));
  return [outParts.join(), data];
}
