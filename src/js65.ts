import * as fs from 'std/fs/mod.ts';
import * as reader from "https://deno.land/std@0.184.0/streams/read_all.ts";
import * as writer from "https://deno.land/std@0.184.0/streams/write_all.ts";
import { crypto } from 'std/crypto/crypto.ts';
import { Cli } from './cli.ts';

const cli = new Cli({
  fsReadString: (filename: string) => {
    try {
      return [new TextDecoder().decode(filename === Cli.STDIN ? reader.readAllSync(Deno.stdin) : Deno.readFileSync(filename)), undefined];
    } catch (err) {
      return [undefined, err]
    }
  },
  fsReadBytes: (filename: string) => {
    try {
      return [filename === Cli.STDIN ? reader.readAllSync(Deno.stdin) : Deno.readFileSync(filename), undefined];
    } catch (err) {
      return [undefined, err];
    }
  },
  fsWriteString: (filename: string, data: string) => {
    try {
      const d = new TextEncoder().encode(data);
      filename === Cli.STDOUT ? writer.writeAllSync(Deno.stdout, d) : Deno.writeFileSync(filename, d);
      return;
    } catch (err) {
      return err;
    }
  },
  fsWriteBytes: (filename: string, data: Uint8Array) => {
    try {
      filename === Cli.STDOUT ? writer.writeAllSync(Deno.stdout, data) : Deno.writeFileSync(filename, data)
      return;
    } catch (err) {
      return err;
    }
  },
  fsWalk: (path: string, action: (filename: string) => boolean) => {
    for (const dir in fs.walkSync(path)) {
      if (action(dir)) {
        break;
      }
    }
  },
  cryptoSha1: (data: Uint8Array) => crypto.subtle.digestSync('SHA-1', data),
  exit: (code: number) => Deno.exit(code),
});

export async function main(args: string[]) {
  await cli.run(args);
}

await main(Deno.args);
