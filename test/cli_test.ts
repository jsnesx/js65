
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {Cli} from '../src/cli.ts'
import { fromHexString, fromByteString, joinDir } from "../src/util.ts";

describe('CLI', function() {
  describe('STDIN', function() {
    it('should handle `lda #$03`', async function() {
      const [_out, data] = await make(["--target", "sim", "--stdin"], `lda #3`);
      expect(data.length, "output should not be empty").toBeGreaterThan(0);
    });

    const bgHexStr = '00 01 02 03';
    const bg = fromHexString(bgHexStr);
    it('should handle `lda #$03` on top of binary `${bgHexStr}`', async function() {
      const [_out, data] = await make(["--target", "sim", "--stdin", "--rom", "dummy"], `lda #3`, bg);
      expect(data).toEqual(fromHexString('A9 03 02 03'));
    });

    it('test IPS patch generation', async function() {
      const [_out, data] = await make(["--target", "sim", "--stdin", "--rom", "dummy", "--ips"], `lda #3`, bg);
      expect(data).toEqual(fromByteString('PATCH\0\0\0\0\x02\xa9\x03EOF'));
    });
  });

  describe('map file', function() {
    it('should write a map file when -m is given', async function() {
      const files = await makeFiles(
          ["--target", "sim", "--stdin", "-m", "out.map"], `lda #3`);
      expect(files.has('out.map')).toBe(true);
      const map = new TextDecoder().decode(files.get('out.map'));
      expect(map.length).toBeGreaterThan(0);
    });

    it('should not write a map file when -m is not given', async function() {
      const files = await makeFiles(["--target", "sim", "--stdin"], `lda #3`);
      expect(files.has('out.map')).toBe(false);
    });

    it('should reject -m combined with --compileonly', async function() {
      await expect(makeFiles(
          ["--target", "sim", "--stdin", "-c", "-m", "out.map"], `lda #3`))
          .rejects.toThrow();
    });
  });

  describe('include directories', function() {
    const cli = new Cli({
      fsReadString: async () => '',
      fsReadBytes: async () => new Uint8Array(0),
      fsWriteString: async () => {},
      fsWriteBytes: async () => {},
      fsWalk: async () => {},
      exit: () => {},
    });
    const paths = (...args: string[]) => cli.parseArgs(args).options.includePaths;

    it('accepts every -I spelling', function() {
      expect(paths('-I', 'inc')).toEqual(['inc']);
      expect(paths('-Iinc')).toEqual(['inc']);
      expect(paths('--include-dir', 'inc')).toEqual(['inc']);
      expect(paths('--include-dir=inc')).toEqual(['inc']);
    });

    it('keeps repeated -I directories in order', function() {
      expect(paths('-Ione', '--include-dir=two', '-I', 'three'))
          .toEqual(['one', 'two', 'three']);
    });

    it('does not mistake --ips for a -I directory', function() {
      const args = cli.parseArgs(['--ips', 'main.s']);
      expect(args.options.includePaths).toEqual([]);
      expect(args.patch).toBe('ips');
    });

    it('accepts every --bin-include-dir spelling', function() {
      expect(cli.parseArgs(['--bin-include-dir', 'art']).options.binIncludePaths)
          .toEqual(['art']);
      expect(cli.parseArgs(['--bin-include-dir=art']).options.binIncludePaths)
          .toEqual(['art']);
    });
  });

  describe('resolving includes relative to the input file', function() {
    // `js65 bhop/bhop.s` from the parent of bhop/: `.include "bhop/commands.asm"` has to
    // resolve against bhop.s's own directory, giving bhop/bhop/commands.asm.
    const tree: Record<string, string> = {
      'bhop/bhop.s': '.include "bhop/commands.asm"\n',
      'bhop/bhop/commands.asm': '.include "helpers.inc"\n',
      'bhop/bhop/helpers.inc': '.segment "CODE"\nlda #1\n',
    };

    async function build(args: string[], extra: Record<string, string> = {}) {
      const files = {...tree, ...extra};
      const opened: string[] = [];
      const cli = new Cli({
        fsReadString: async (path: string, filename: string) => {
          const key = joinDir(path, filename);
          opened.push(key);
          if (!(key in files)) throw new Error(`ENOENT ${key}`);
          return files[key];
        },
        fsReadBytes: async (path: string, filename: string) => {
          const key = joinDir(path, filename);
          if (!(key in files)) throw new Error(`ENOENT ${key}`);
          return new TextEncoder().encode(files[key]);
        },
        fsWriteString: async () => {},
        fsWriteBytes: async () => {},
        fsWalk: async () => {},
        exit: (code: number) => { if (code !== 0) throw new Error(`exit ${code}`); },
      });
      await cli.run(args);
      return opened;
    }

    it('finds includes next to the file being assembled, not next to the cwd', async function() {
      const opened = await build(['--target', 'sim', '-c', 'bhop/bhop.s', '-o', 'out.o']);
      expect(opened).toContain('bhop/bhop/commands.asm');
      expect(opened).toContain('bhop/bhop/helpers.inc');
    });

    it('does the same for a backslash-separated input path', async function() {
      const opened = await build(['--target', 'sim', '-c', 'bhop\\bhop.s', '-o', 'out.o']);
      expect(opened).toContain('bhop/bhop/commands.asm');
      expect(opened).toContain('bhop/bhop/helpers.inc');
    });

    it('falls back to a -I directory for a file the source tree does not hold', async function() {
      const opened = await build(
        ['--target', 'sim', '-c', 'bhop/bhop.s', '-I', 'vendor', '-o', 'out.o'],
        {'bhop/bhop/commands.asm': '.include "external.inc"\n',
         'vendor/external.inc': '.segment "CODE"\nlda #2\n'});
      expect(opened).toContain('vendor/external.inc');
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
    fsReadBytes: async (_path: string, filename: string) => {
      if (filename === Cli.STDIN) return await Promise.resolve(new TextEncoder().encode(input));
      return await Promise.resolve(bytes ?? new Uint8Array(0));
    },
    fsWriteString: async (_path: string, _filename: string, data: string) => {
      outParts.push(data);
      return await Promise.resolve(undefined);
    },
    fsWriteBytes: async (_path: string, _filename: string, data: Uint8Array) => {
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

/** Like make(), but keyed by filename so callers can tell which files were written. */
async function makeFiles(args: string[], input: string, bytes: Uint8Array|null = null)
    : Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let exitCode = 0;
  const cli = new Cli({
    fsReadString: async (_path: string, _filename: string) => {
      return await Promise.resolve(input);
    },
    fsReadBytes: async (_path: string, filename: string) => {
      if (filename === Cli.STDIN) return await Promise.resolve(new TextEncoder().encode(input));
      return await Promise.resolve(bytes ?? new Uint8Array(0));
    },
    fsWriteString: async (_path: string, _filename: string, _data: string) => {
      return await Promise.resolve(undefined);
    },
    fsWriteBytes: async (_path: string, filename: string, data: Uint8Array) => {
      files.set(filename, data);
      return await Promise.resolve(undefined);
    },
    fsWalk: async (_path: string, _action: (filename: string) => Promise<boolean>) => {
      return await Promise.resolve(undefined);
    },
    exit: (code: number) => { exitCode = code; },
  });

  await cli.run(args);
  if (exitCode !== 0) throw new Error(`cli exited with code ${exitCode}`);
  return files;
}
