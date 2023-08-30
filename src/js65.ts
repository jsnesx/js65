import * as fs from 'std/fs/mod.ts';
import { resolve } from "std/path/mod.ts";
import * as reader from "std/streams/read_all.ts";
import * as writer from "std/streams/write_all.ts";
import { crypto } from 'std/crypto/crypto.ts';
import { Cli } from './cli.ts';

const cli = new Cli({
  fsResolve: async (path: string, filename: string) => {
    return await Promise.resolve(resolve(path, (filename === Cli.STDIN) ? '.' : filename));
  },
  fsReadString: async (filename: string) => {
    return new TextDecoder().decode(filename === Cli.STDIN ? await reader.readAll(Deno.stdin) : await Deno.readFile(filename));
  },
  fsReadBytes: async (filename: string) => {
      return filename === Cli.STDIN ? await reader.readAll(Deno.stdin) : await Deno.readFile(filename);
  },
  fsWriteString: async (filename: string, data: string) => {
    const d = new TextEncoder().encode(data);
    filename === Cli.STDOUT ? await writer.writeAll(Deno.stdout, d) : await Deno.writeFile(filename, d);
  },
  fsWriteBytes: async (filename: string, data: Uint8Array) => {
    filename === Cli.STDOUT ? await writer.writeAll(Deno.stdout, data) : await Deno.writeFile(filename, data);
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

// await main(Deno.args);

Deno.bench("building z2disassembly", async() => {
  await cli.run([
    "-o", "build/test.nes",
    "-IC:\\dev\\z2disassembly\\inc\\",
    "-IC:\\dev\\z2disassembly\\src\\",
    "C:\\dev\\z2disassembly\\src\\cfg.s",
    "C:\\dev\\z2disassembly\\src\\prg0.s",
    "C:\\dev\\z2disassembly\\src\\prg1.s",
    "C:\\dev\\z2disassembly\\src\\prg2.s",
    "C:\\dev\\z2disassembly\\src\\prg3.s",
    "C:\\dev\\z2disassembly\\src\\prg4.s",
    "C:\\dev\\z2disassembly\\src\\prg5.s",
    "C:\\dev\\z2disassembly\\src\\prg6.s",
    "C:\\dev\\z2disassembly\\src\\prg7.s"
  ]);
});
