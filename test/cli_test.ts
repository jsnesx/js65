
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

  describe('linker config', function() {
    const cli = new Cli({
      fsReadString: async () => '',
      fsReadBytes: async () => new Uint8Array(0),
      fsWriteString: async () => {},
      fsWriteBytes: async () => {},
      fsWalk: async () => {},
      exit: () => {},
    });

    it('accepts every -C spelling', function() {
      expect(cli.parseArgs(['-C', 'nes.cfg']).cfgfile).toBe('nes.cfg');
      expect(cli.parseArgs(['--config', 'nes.cfg']).cfgfile).toBe('nes.cfg');
      expect(cli.parseArgs(['--config=nes.cfg']).cfgfile).toBe('nes.cfg');
    });

    it('does not confuse -C with -c', function() {
      const args = cli.parseArgs(['-c', 'main.s']);
      expect(args.compileonly).toBe(true);
      expect(args.cfgfile).toBe('');
    });

    it('rejects -C combined with --compileonly', async function() {
      const files = {'main.s': 'lda #3\n', 'nes.cfg': 'MEMORY {}\n'};
      await expect(build(files, ['-c', '-C', 'nes.cfg', 'main.s']))
          .rejects.toThrow();
    });

    it('links with the config and writes its extra output files',
       async function() {
      const files = {
        'main.s': '.segment "HEADER"\n.byte 1,2,3,4\n.segment "CODE"\nlda #3\n',
        'nes.cfg': `
          MEMORY {
            HDR: start = $0000, size = $4, file = "%O_header";
            PRG: start = $8000, size = $4, file = %O, fill = yes, fillval = $ff;
          }
          SEGMENTS {
            HEADER: load = HDR;
            CODE:   load = PRG;
          }`,
      };
      const written = await build(files, ['-C', 'nes.cfg', '-o', 'rom.nes',
                                          'main.s']);
      expect([...written.get('rom.nes')!]).toEqual([0xa9, 3, 0xff, 0xff]);
      // `%O` in the config's file name is the output file's name.
      expect([...written.get('rom.nes_header')!]).toEqual([1, 2, 3, 4]);
    });

    it('reports a config parse error against the config file',
       async function() {
      const files = {
        'main.s': '.segment "CODE"\nlda #3\n',
        'nes.cfg': 'MEMORY {\n  PRG: start = $8000, size = $2\n}\n',
      };
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
      try {
        await expect(build(files, ['-C', 'nes.cfg', 'main.s'])).rejects.toThrow();
      } finally {
        console.log = log;
      }
      // Loading the config through readSource is what buys the source snippet.
      expect(lines.join('\n')).toContain("nes.cfg:2:30: error: Expected ';'");
      expect(lines.join('\n')).toContain('PRG: start = $8000, size = $2');
    });

    /** Runs the CLI over a literal file tree, returning everything it wrote. */
    async function build(files: Record<string, string>, args: string[]) {
      const written = new Map<string, Uint8Array>();
      let exitCode = 0;
      const read = (path: string, filename: string) => {
        const key = joinDir(path, filename);
        if (!(key in files)) throw new Error(`ENOENT ${key}`);
        return files[key];
      };
      const cli = new Cli({
        fsReadString: async (path, filename) => read(path, filename),
        fsReadBytes: async (path, filename) =>
            new TextEncoder().encode(read(path, filename)),
        fsWriteString: async () => {},
        fsWriteBytes: async (_path, filename, data) => { written.set(filename, data); },
        fsWalk: async () => {},
        exit: (code: number) => { exitCode = code; },
      });
      await cli.run(args);
      if (exitCode !== 0) throw new Error(`cli exited with code ${exitCode}`);
      return written;
    }
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

  describe('--create-dep', function() {
    const cli = new Cli({
      fsReadString: async () => '',
      fsReadBytes: async () => new Uint8Array(0),
      fsWriteString: async () => {},
      fsWriteBytes: async () => {},
      fsWalk: async () => {},
      exit: () => {},
    });

    it('accepts every dependency file spelling', function() {
      expect(cli.parseArgs(['--create-dep', 'out.d']).depfile).toBe('out.d');
      expect(cli.parseArgs(['--create-dep=out.d']).depfile).toBe('out.d');
      expect(cli.parseArgs(['--create-full-dep', 'out.d']).depfile).toBe('out.d');
      expect(cli.parseArgs(['--create-full-dep=out.d']).depfile).toBe('out.d');
      expect(cli.parseArgs(['--create-deps', 'out.d']).depfile).toBe('out.d');
      expect(cli.parseArgs(['--create-deps=out.d']).depfile).toBe('out.d');
    });

    it('does not set a dependency file when no flag is given', function() {
      expect(cli.parseArgs(['main.s']).depfile).toBe('');
    });

    it('rejects a repeated dependency flag', function() {
      const exits: number[] = [];
      const strict = new Cli({
        fsReadString: async () => '',
        fsReadBytes: async () => new Uint8Array(0),
        fsWriteString: async () => {},
        fsWriteBytes: async () => {},
        fsWalk: async () => {},
        exit: (code: number) => { exits.push(code); },
      });
      const log = console.log;
      console.log = () => {};
      try {
        strict.parseArgs(['--create-dep', 'a.d', '--create-deps', 'b.d']);
      } finally {
        console.log = log;
      }
      expect(exits).toEqual([1]);
    });

    /** Assembles a literal file tree and returns the dependency file's text. */
    async function depFile(files: Record<string, string>, args: string[]) {
      const written = await build(files, [...args, '--create-dep', 'out.d']);
      expect(written.has('out.d')).toBe(true);
      return new TextDecoder().decode(written.get('out.d'));
    }

    it('lists the input, its includes and its incbins, in the ca65 layout',
       async function() {
      const dep = await depFile({
        'main.s': '.include "inc/header.inc"\nlda #1\n.incbin "art/tiles.chr"\n',
        'inc/header.inc': '; nothing to declare\n',
        'art/tiles.chr': 'CHR!',
      }, ['--target', 'sim', '-o', 'rom.nes', 'main.s']);
      expect(dep).toBe('rom.nes:\tmain.s inc/header.inc art/tiles.chr\n\n' +
                       'main.s inc/header.inc art/tiles.chr:\n\n');
    });

    it('lists a file included from two places exactly once', async function() {
      const dep = await depFile({
        'main.s': '.include "inc/header.inc"\n.include "inc/shared.inc"\nlda #1\n',
        'inc/header.inc': '.include "shared.inc"\n',
        'inc/shared.inc': '; shared\n',
      }, ['--target', 'sim', '-o', 'rom.nes', 'main.s']);
      expect(dep).toBe('rom.nes:\tmain.s inc/header.inc inc/shared.inc\n\n' +
                       'main.s inc/header.inc inc/shared.inc:\n\n');
    });

    it('does not list an include the search path never found', async function() {
      // TokenStream probes each -I directory in turn; only the hit is a dependency.
      const dep = await depFile({
        'main.s': '.include "external.inc"\nlda #1\n',
        'vendor/external.inc': '; found here\n',
      }, ['--target', 'sim', '-I', 'missing', '-I', 'vendor', '-o', 'rom.nes',
          'main.s']);
      expect(dep).toContain('vendor/external.inc');
      expect(dep).not.toContain('missing/external.inc');
    });

    it('does not list a .macpack, which is built in rather than read',
       async function() {
      const dep = await depFile({
        'main.s': '.macpack common\nlda #1\n',
      }, ['--target', 'sim', '-o', 'rom.nes', 'main.s']);
      expect(dep).toBe('rom.nes:\tmain.s\n\nmain.s:\n\n');
    });

    it('escapes a space in a path', async function() {
      const dep = await depFile({
        'main.s': 'lda #1\n.incbin "art/my tiles.chr"\n',
        'art/my tiles.chr': 'CHR!',
      }, ['--target', 'sim', '-o', 'rom.nes', 'main.s']);
      expect(dep).toContain('art/my\\ tiles.chr');
    });

    it('lists an ld65 config given with -C', async function() {
      const dep = await depFile({
        'main.s': '.segment "CODE"\nlda #1\n',
        'nes.cfg': `
          MEMORY { PRG: start = $8000, size = $4, file = %O; }
          SEGMENTS { CODE: load = PRG; }`,
      }, ['-C', 'nes.cfg', '-o', 'rom.nes', 'main.s']);
      expect(dep).toBe('rom.nes:\tmain.s nes.cfg\n\nmain.s nes.cfg:\n\n');
    });

    it('names the .o as the target under --compileonly', async function() {
      // The per-source `%.o: %.s` pattern cc65 documents for auto-dependencies.
      const dep = await depFile({
        'src/main.s': '.include "inc/shared.inc"\nlda #1\n',
        'src/inc/shared.inc': '; shared\n',
      }, ['--target', 'sim', '-c', '-o', 'obj/main.o', 'src/main.s']);
      expect(dep).toBe('obj/main.o:\tsrc/main.s src/inc/shared.inc\n\n' +
                       'src/main.s src/inc/shared.inc:\n\n');
    });

    it('normalizes a backslash path in the target', async function() {
      const dep = await depFile({
        'src/main.s': 'lda #1\n',
      }, ['--target', 'sim', '-c', '-o', 'obj\\main.o', 'src\\main.s']);
      expect(dep).toBe('obj/main.o:\tsrc/main.s\n\nsrc/main.s:\n\n');
    });

    it('rejects --create-dep combined with --stdout', async function() {
      await expect(build({'main.s': 'lda #1\n'},
                         ['--target', 'sim', '-o', '--stdout', 'main.s',
                          '--create-dep', 'out.d']))
          .rejects.toThrow();
    });

    it('writes no dependency file when the flag is absent', async function() {
      const written = await build({'main.s': 'lda #1\n'},
                                  ['--target', 'sim', '-o', 'rom.nes', 'main.s']);
      expect(written.has('out.d')).toBe(false);
    });

    /** Runs the CLI over a literal file tree, returning everything it wrote. */
    async function build(files: Record<string, string>, args: string[]) {
      const written = new Map<string, Uint8Array>();
      let exitCode = 0;
      const read = (path: string, filename: string) => {
        const key = joinDir(path, filename);
        if (!(key in files)) throw new Error(`ENOENT ${key}`);
        return files[key];
      };
      const dep = new Cli({
        fsReadString: async (path, filename) => read(path, filename),
        fsReadBytes: async (path, filename) =>
            new TextEncoder().encode(read(path, filename)),
        fsWriteString: async () => {},
        fsWriteBytes: async (_path, filename, data) => { written.set(filename, data); },
        fsWalk: async () => {},
        exit: (code: number) => { exitCode = code; },
      });
      await dep.run(args);
      if (exitCode !== 0) throw new Error(`cli exited with code ${exitCode}`);
      return written;
    }
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
