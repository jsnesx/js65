import {describe, it} from 'std/testing/bdd.ts';
import { crypto } from 'std/crypto/crypto.ts';

import {expect} from 'chai';
import {Cli} from '../cli.ts'
import { toHexString } from "../util.ts";

describe('CLI', function() {
  describe('STDIN', function() {
    it('should handle `lda #$03`', async function() {
      const out = "";
      await make(`lda #3`, out).run(["--target", "sim"]);
      expect(out.length > 0, "output should not be empty");
      console.log(`output ${out.length} data: ${out}`)
    });
  });
});

function make(input: string, output: string) : Cli {
  return new Cli({
    fsReadString: (_filename: string) => {
      return [input, undefined];
    },
    fsReadBytes: (_filename: string) => {
      return [new TextEncoder().encode(input), undefined];
    },
    fsWriteString: (_filename: string, data: string) => {
      output.concat(data);
      return undefined;
    },
    fsWriteBytes: (_filename: string, data: Uint8Array) => {
      console.log(`decoded: ${toHexString(data)}`);
      output.concat(new TextDecoder().decode(data));
      return undefined;
    },
    fsWalk: (_path: string, _action: (filename: string) => boolean) => {
      // unused for now
      return;
    },
    cryptoSha1: (data: Uint8Array) => crypto.subtle.digestSync('SHA-1', data),
    exit: (code: number) => Deno.exit(code),
  });
}
