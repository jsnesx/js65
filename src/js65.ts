import * as fs from 'std/fs/mod.ts';
import * as reader from "https://deno.land/std@0.184.0/streams/read_all.ts";
import * as writer from "https://deno.land/std@0.184.0/streams/write_all.ts";
import { crypto } from 'std/crypto/crypto.ts';
import { Cli } from './cli.ts';

const cli = new Cli({
  fsReadString: async (filename: string) => {
    try {
      return [new TextDecoder().decode(filename === Cli.STDIN ? await reader.readAll(Deno.stdin) : await Deno.readFile(filename)), undefined];
    } catch (err) {
      return [undefined, err]
    }
  },
  fsReadBytes: async (filename: string) => {
    try {
      return [filename === Cli.STDIN ? await reader.readAll(Deno.stdin) : await Deno.readFile(filename), undefined];
    } catch (err) {
      return [undefined, err];
    }
  },
  fsWriteString: async (filename: string, data: string) => {
    try {
      const d = new TextEncoder().encode(data);
      filename === Cli.STDOUT ? await writer.writeAll(Deno.stdout, d) : await Deno.writeFile(filename, d);
      return;
    } catch (err) {
      return err;
    }
  },
  fsWriteBytes: async (filename: string, data: Uint8Array) => {
    try {
      filename === Cli.STDOUT ? await writer.writeAll(Deno.stdout, data) : await Deno.writeFile(filename, data)
      return;
    } catch (err) {
      return err;
    }
  },
  fsWalk: async (path: string, action: (filename: string) => Promise<boolean>) => {
    for await (const dir of fs.walk(path)) {
      if (await action(dir.path)) {
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
