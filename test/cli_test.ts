import {describe, it} from 'std/testing/bdd.ts';
import { crypto } from 'std/crypto/crypto.ts';

import chai from 'chai';
import {Cli} from '/src/cli.ts'
import { toHexString } from "/src/util.ts";

const expect = chai.expect;

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
      return await Promise.resolve([input, undefined]);
    },
    fsReadBytes: async (_filename: string) => {
      return await Promise.resolve([new TextEncoder().encode(input), undefined]);
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
    cryptoSha1: (data: Uint8Array) => crypto.subtle.digestSync('SHA-1', data),
    exit: (code: number) => Deno.exit(code),
  });
}
