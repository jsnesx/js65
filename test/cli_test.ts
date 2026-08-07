
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

  // Pins every spelling of every flag the option table has to keep working.
  // These are pure parseArgs assertions with no filesystem behind them, so they
  // are the regression net for the table refactor.
  describe('argument parsing', function() {
    const cli = new Cli({
      fsReadString: async () => '',
      fsReadBytes: async () => new Uint8Array(0),
      fsWriteString: async () => {},
      fsWriteBytes: async () => {},
      fsWalk: async () => {},
      exit: () => {},
    });

    /** parseArgs with a stub that records exit codes instead of exiting. */
    function strict() {
      const exits: number[] = [];
      const c = new Cli({
        fsReadString: async () => '',
        fsReadBytes: async () => new Uint8Array(0),
        fsWriteString: async () => {},
        fsWriteBytes: async () => {},
        fsWalk: async () => {},
        exit: (code: number) => { exits.push(code); },
      });
      return {
        exits,
        parse(args: string[]) {
          const log = console.log;
          console.log = () => {};
          try {
            return c.parseArgs(args);
          } finally {
            console.log = log;
          }
        },
      };
    }

    it('accepts every -h spelling', function() {
      expect(cli.parseArgs(['-h']).help).toBe(true);
      expect(cli.parseArgs(['--help']).help).toBe(true);
      expect(cli.parseArgs(['main.s']).help).toBe(false);
    });

    it('accepts every output file spelling', function() {
      expect(cli.parseArgs(['-o', 'a.nes']).outfile).toBe('a.nes');
      expect(cli.parseArgs(['--outfile', 'a.nes']).outfile).toBe('a.nes');
      expect(cli.parseArgs(['--output', 'a.nes']).outfile).toBe('a.nes');
      expect(cli.parseArgs(['--output=a.nes']).outfile).toBe('a.nes');
      expect(cli.parseArgs(['--outfile=a.nes']).outfile).toBe('a.nes');
    });

    it('rejects a repeated output file', function() {
      const s = strict();
      s.parse(['-o', 'a.nes', '-o', 'b.nes']);
      expect(s.exits).toEqual([1]);
    });

    it('accepts every --dbgfile spelling', function() {
      expect(cli.parseArgs(['--dbgfile', 'a.dbg']).dbgfile).toBe('a.dbg');
      expect(cli.parseArgs(['--dbgfile=a.dbg']).dbgfile).toBe('a.dbg');
    });

    it('rejects a repeated --dbgfile', function() {
      const s = strict();
      s.parse(['--dbgfile', 'a.dbg', '--dbgfile', 'b.dbg']);
      expect(s.exits).toEqual([1]);
    });

    it('accepts every map file spelling', function() {
      expect(cli.parseArgs(['-m', 'a.map']).mapfile).toBe('a.map');
      expect(cli.parseArgs(['--mapfile', 'a.map']).mapfile).toBe('a.map');
      expect(cli.parseArgs(['--mapfile=a.map']).mapfile).toBe('a.map');
      expect(cli.parseArgs(['-m=a.map']).mapfile).toBe('a.map');
    });

    it('rejects a repeated map file', function() {
      const s = strict();
      s.parse(['-m', 'a.map', '--mapfile', 'b.map']);
      expect(s.exits).toEqual([1]);
    });

    it('rejects a repeated config file', function() {
      const s = strict();
      s.parse(['-C', 'a.cfg', '--config=b.cfg']);
      expect(s.exits).toEqual([1]);
    });

    it('parses the debug level flags', function() {
      const off = cli.parseArgs(['--no-debuginfo']).options;
      expect(off.debugLevel).toBe(-1);
      expect(off.generateDebugInfo).toBe(false);
      for (const flag of ['-g', '-g0']) {
        const on = cli.parseArgs([flag]).options;
        expect(on.debugLevel).toBe(0);
        expect(on.generateDebugInfo).toBe(true);
      }
      const full = cli.parseArgs(['-g1']).options;
      expect(full.debugLevel).toBe(1);
      expect(full.generateDebugInfo).toBe(true);
    });

    it('defaults to comments-and-labels debug info', function() {
      const opts = cli.parseArgs(['main.s']).options;
      expect(opts.debugLevel).toBe(0);
      expect(opts.generateDebugInfo).toBe(true);
      expect(opts.lineContinuations).toBe(true);
    });

    it('accepts every --compileonly spelling', function() {
      for (const flag of ['-c', '--compileonly']) {
        const args = cli.parseArgs([flag]);
        expect(args.compileonly).toBe(true);
        expect(args.options.outputFormat).toBe('object');
      }
    });

    it('accepts every rom spelling', function() {
      expect(cli.parseArgs(['-r', 'base.nes']).rom).toBe('base.nes');
      expect(cli.parseArgs(['--rom', 'base.nes']).rom).toBe('base.nes');
      expect(cli.parseArgs(['--rom=base.nes']).rom).toBe('base.nes');
    });

    it('accepts every --target spelling', function() {
      expect(cli.parseArgs(['--target', 'sim']).options.target).toBe('sim');
      expect(cli.parseArgs(['--target=sim']).options.target).toBe('sim');
    });

    it('parses --ips', function() {
      const args = cli.parseArgs(['--ips']);
      expect(args.patch).toBe('ips');
      expect(args.options.outputFormat).toBe('ips');
    });

    it('parses --stdin as an input file', function() {
      expect(cli.parseArgs(['--stdin']).files).toEqual([Cli.STDIN]);
    });

    it('parses the rehydrate and dehydrate subcommands', function() {
      expect(cli.parseArgs(['rehydrate', 'main.s']).op).toBeDefined();
      expect(cli.parseArgs(['dehydrate', 'main.s']).op).toBeDefined();
      expect(cli.parseArgs(['main.s']).op).toBeUndefined();
      // The subcommand itself is not an input file.
      expect(cli.parseArgs(['rehydrate', 'main.s']).files).toEqual(['main.s']);
    });

    it('collects input files in order', function() {
      expect(cli.parseArgs(['a.s', '-o', 'out.nes', 'b.s']).files)
          .toEqual(['a.s', 'b.s']);
    });

    describe('unknown options', function() {
      it('rejects an unknown long flag', function() {
        const s = strict();
        s.parse(['--nonsense', 'main.s']);
        expect(s.exits).toEqual([1]);
      });

      it('rejects an unknown short flag', function() {
        const s = strict();
        s.parse(['-Z', 'main.s']);
        expect(s.exits).toEqual([1]);
      });

      it('names the offending flag in the error', function() {
        const lines: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
        try {
          cli.parseArgs(['--nonsense', 'main.s']);
        } finally {
          console.log = log;
        }
        expect(lines.join('\n')).toContain('--nonsense');
      });

      it('does not treat an unknown flag as an input file', function() {
        const s = strict();
        const args = s.parse(['--nonsense', 'main.s']);
        expect(args.files).not.toContain('--nonsense');
      });

      it('accepts a bare - as a filename', function() {
        const s = strict();
        const args = s.parse(['-']);
        expect(args.files).toEqual(['-']);
        expect(s.exits).toEqual([]);
      });

      it('does not reject a plain filename that contains a dash', function() {
        const s = strict();
        const args = s.parse(['my-file.s']);
        expect(args.files).toEqual(['my-file.s']);
        expect(s.exits).toEqual([]);
      });
    });

    describe('-D defines', function() {
      const defines = (...args: string[]) => cli.parseArgs(args).options.defines;

      it('accepts every -D spelling', function() {
        const one = [{name: 'FOO', value: '1'}];
        expect(defines('-D', 'FOO=1')).toEqual(one);
        expect(defines('-DFOO=1')).toEqual(one);
        expect(defines('--define', 'FOO=1')).toEqual(one);
        expect(defines('--define=FOO=1')).toEqual(one);
      });

      it('defaults a bare name to 1', function() {
        expect(defines('-D', 'FOO')).toEqual([{name: 'FOO', value: '1'}]);
        expect(defines('-DFOO')).toEqual([{name: 'FOO', value: '1'}]);
      });

      it('splits on the first = only', function() {
        // The value is parsed as a number later; the split must not eat it.
        expect(defines('-D', 'FOO=1=2')).toEqual([{name: 'FOO', value: '1=2'}]);
      });

      it('keeps repeated defines in order so the last one wins', function() {
        expect(defines('-DFOO=1', '-DBAR=2', '-DFOO=3')).toEqual([
          {name: 'FOO', value: '1'},
          {name: 'BAR', value: '2'},
          {name: 'FOO', value: '3'},
        ]);
      });

      it('preserves the value text for the assembler to parse', function() {
        expect(defines('-DFOO=$1f')).toEqual([{name: 'FOO', value: '$1f'}]);
        expect(defines('-DFOO=%1010')).toEqual([{name: 'FOO', value: '%1010'}]);
      });

      it('defines nothing when no -D is given', function() {
        expect(defines('main.s')).toEqual([]);
      });

      it('rejects -D with an empty symbol name', function() {
        const s = strict();
        s.parse(['-D', '=1']);
        expect(s.exits).toEqual([1]);
      });

      it('rejects a -D whose value was forgotten', function() {
        // `-D -c main.s` must not quietly define a symbol named `-c` and drop
        // the -c option along with it.
        const s = strict();
        const args = s.parse(['-D', '-c', 'main.s']);
        expect(s.exits).toEqual([1]);
        expect(args.options.defines).toEqual([]);
      });

      it('rejects a symbol name that is not an identifier', function() {
        for (const bad of ['1FOO', 'FOO-BAR', 'foo bar']) {
          const s = strict();
          s.parse([`-D${bad}=1`]);
          expect(s.exits).toEqual([1]);
        }
      });

      it('accepts identifier names with digits and underscores', function() {
        expect(defines('-D_FOO2=1')).toEqual([{name: '_FOO2', value: '1'}]);
      });
    });

    describe('-- end of options', function() {
      it('treats a dash-led argument after -- as a filename', function() {
        const s = strict();
        const args = s.parse(['--', '-weird-name.s']);
        expect(args.files).toEqual(['-weird-name.s']);
        expect(s.exits).toEqual([]);
      });

      it('stops interpreting known flags after --', function() {
        const s = strict();
        const args = s.parse(['--', '-c', '--stdin']);
        expect(args.files).toEqual(['-c', '--stdin']);
        expect(args.compileonly).toBe(false);
        expect(s.exits).toEqual([]);
      });

      it('still parses flags given before --', function() {
        const args = cli.parseArgs(['-c', '-o', 'out.o', '--', '-in.s']);
        expect(args.compileonly).toBe(true);
        expect(args.outfile).toBe('out.o');
        expect(args.files).toEqual(['-in.s']);
      });

      it('treats a second -- as a filename', function() {
        const args = cli.parseArgs(['--', '--', 'main.s']);
        expect(args.files).toEqual(['--', 'main.s']);
      });

      it('does not treat a subcommand after -- as a subcommand', function() {
        const args = cli.parseArgs(['--', 'rehydrate']);
        expect(args.op).toBeUndefined();
        expect(args.files).toEqual(['rehydrate']);
      });
    });
  });

  // Proves -D reaches the assembler as a real symbol rather than merely being
  // parsed. Each case is a source that only assembles to these bytes if the
  // define landed.
  describe('-D end to end', function() {
    async function bytes(args: string[], src: string) {
      const files = await makeFiles(
          ['--target', 'sim', '--stdin', '-o', 'out.bin', ...args], src);
      return [...files.get('out.bin')!];
    }

    it('makes the symbol visible to .ifdef', async function() {
      expect(await bytes(['-D', 'FOO=3'], '.ifdef FOO\nlda #FOO\n.endif\n'))
          .toEqual([0xa9, 3]);
    });

    it('leaves .ifdef false without the define', async function() {
      expect(await bytes([], '.ifdef FOO\nlda #FOO\n.endif\n')).toEqual([]);
    });

    it('makes the symbol visible to .ifsym', async function() {
      expect(await bytes(['-DFOO=7'], '.ifsym FOO\nlda #FOO\n.endif\n'))
          .toEqual([0xa9, 7]);
    });

    it('is as visible to .ifconst as an in-source .set is', async function() {
      const viaDefine = await bytes(['-DFOO=7'], '.ifconst FOO\nlda #FOO\n.endif\n');
      const viaSet = await bytes([], 'FOO .set 7\n.ifconst FOO\nlda #FOO\n.endif\n');
      expect(viaDefine).toEqual(viaSet);
    });

    it('defaults a bare -D to 1', async function() {
      expect(await bytes(['-D', 'FOO'], 'lda #FOO\n')).toEqual([0xa9, 1]);
    });

    it('parses a $hex value', async function() {
      expect(await bytes(['-DFOO=$1f'], 'lda #FOO\n')).toEqual([0xa9, 0x1f]);
    });

    it('parses a %binary value', async function() {
      expect(await bytes(['-DFOO=%1010'], 'lda #FOO\n')).toEqual([0xa9, 0b1010]);
    });

    it('lets a later -D override an earlier one, like .set', async function() {
      expect(await bytes(['-DFOO=1', '-DFOO=9'], 'lda #FOO\n')).toEqual([0xa9, 9]);
    });

    it('lets the source reassign the symbol, since it is a .set', async function() {
      expect(await bytes(['-DFOO=1'], 'FOO .set 4\nlda #FOO\n')).toEqual([0xa9, 4]);
    });

    it('does not define a macro, so .definedmacro stays false', async function() {
      // ca65's -D defines a symbol, not a .define macro. This is the assertion
      // that pins that distinction.
      expect(await bytes(['-DFOO=3'], '.ifdef FOO\n.byte 1\n.endif\n' +
                                      '.if .definedmacro(FOO)\n.byte 2\n.endif\n'))
          .toEqual([1]);
    });

    // A non-numeric value is a `.define` macro instead of a `.set` symbol, so
    // `-DNAME=text` works the way a C compiler's -D does.
    it('makes a non-numeric value a .define macro', async function() {
      expect(await bytes(['-DFOO=BAR'], 'BAR = 7\nlda #FOO\n')).toEqual([0xa9, 7]);
    });

    it('expands a macro define into an expression', async function() {
      expect(await bytes(['-DFOO=1+2'], 'lda #FOO\n')).toEqual([0xa9, 3]);
    });

    it('makes a macro define visible to .ifdef', async function() {
      expect(await bytes(['-DFOO=bar'], '.ifdef FOO\n.byte 5\n.endif\n'))
          .toEqual([5]);
    });

    it('treats an empty value as a macro expanding to nothing', async function() {
      expect(await bytes(['-DFOO='], '.ifdef FOO\n.byte 1\n.endif\n'))
          .toEqual([1]);
    });

    // Mirrors js65's own `.define`, which is invisible to `.definedmacro` -
    // that predicate covers only `.macro`. See preprocessor.ts's note on it.
    it('is as visible to .definedmacro as an in-source .define is',
       async function() {
      const viaDefine = await bytes(
          ['-DFOO=bar'], '.if .definedmacro(FOO)\n.byte 42\n.endif\n');
      const viaSource = await bytes(
          [], '.define FOO bar\n.if .definedmacro(FOO)\n.byte 42\n.endif\n');
      expect(viaDefine).toEqual(viaSource);
    });

    it('keeps a numeric define a symbol, not a macro', async function() {
      // The numeric path must stay ca65-exact: a symbol, reassignable by .set.
      expect(await bytes(['-DFOO=3'], 'FOO .set 4\nlda #FOO\n')).toEqual([0xa9, 4]);
    });

    it('applies a macro define to every input module', async function() {
      // Each module gets its own Preprocessor and so its own macro table;
      // seeding all of them must not collide with "Already defined".
      const written = new Map<string, Uint8Array>();
      const src: Record<string, string> = {
        'a.s': 'BAR = 7\n.byte FOO\n',
        'b.s': 'BAR = 9\n.byte FOO\n',
      };
      let exitCode = 0;
      const cli = new Cli({
        fsReadString: async (_p, f) => src[f],
        fsReadBytes: async (_p, f) => new TextEncoder().encode(src[f]),
        fsWriteString: async () => {},
        fsWriteBytes: async (_p, f, d) => { written.set(f, d); },
        fsWalk: async () => {},
        exit: (code: number) => { exitCode = code; },
      });
      await cli.run(['--target', 'sim', '-DFOO=BAR', '-o', 'out.bin', 'a.s', 'b.s']);
      expect(exitCode).toBe(0);
      // Each module resolves BAR in its own scope.
      expect([...written.get('out.bin')!]).toEqual([7, 9]);
    });

    it('applies defines to every input module', async function() {
      // Both inputs are assembled by separate Assemblers; the define has to
      // reach each one.
      const written = new Map<string, Uint8Array>();
      const src: Record<string, string> = {
        'a.s': '.ifdef FOO\n.byte FOO\n.endif\n',
        'b.s': '.ifdef FOO\n.byte FOO+1\n.endif\n',
      };
      let exitCode = 0;
      const cli = new Cli({
        fsReadString: async (_p, f) => src[f],
        fsReadBytes: async (_p, f) => new TextEncoder().encode(src[f]),
        fsWriteString: async () => {},
        fsWriteBytes: async (_p, f, d) => { written.set(f, d); },
        fsWalk: async () => {},
        exit: (code: number) => { exitCode = code; },
      });
      await cli.run(['--target', 'sim', '-DFOO=5', '-o', 'out.bin', 'a.s', 'b.s']);
      expect(exitCode).toBe(0);
      expect([...written.get('out.bin')!]).toEqual([5, 6]);
    });
  });

  describe('anonymous segments', function() {
    const source = `
.segment $8000 :size $10
Start:
  lda #$42
  rts

.segment $9000 :size $10
  jsr Start
  rts
`;

    it('should survive the .o round trip', async function() {
      // Anon-ness lives in the segment name, so this also confirms nothing in
      // the gzip + JSON + validate round trip strips the reserved prefix.
      const objs = await run({'main.s': source},
                             ['-c', '-o', 'main.o', 'main.s']);
      const obj = objs.get('main.o');
      expect(obj).toBeTruthy();

      const linked = await run({'main.o': obj!}, ['-o', 'out.bin', 'main.o']);
      const oneStep = await run({'main.s': source},
                                ['-o', 'out.bin', 'main.s']);
      expect([...linked.get('out.bin')!]).toEqual([...oneStep.get('out.bin')!]);
      // Sanity check the layout actually made it through.
      expect([...oneStep.get('out.bin')!.slice(0, 3)]).toEqual([0xa9, 0x42, 0x60]);
      expect([...oneStep.get('out.bin')!.slice(0x10, 0x14)])
          .toEqual([0x20, 0x00, 0x80, 0x60]);
    });

    /** Runs the CLI over an in-memory filesystem keyed by filename. */
    async function run(fs: Record<string, string|Uint8Array>, args: string[]) {
      const written = new Map<string, Uint8Array>();
      let exitCode = 0;
      const get = (filename: string) => {
        const f = fs[filename] ?? fs[joinDir('', filename)];
        if (f == null) throw new Error(`no such file: ${filename}`);
        return f;
      };
      const cli = new Cli({
        fsReadString: async (_path, filename) => {
          const f = get(filename);
          return typeof f === 'string' ? f : new TextDecoder().decode(f);
        },
        fsReadBytes: async (_path, filename) => {
          const f = get(filename);
          return typeof f === 'string' ? new TextEncoder().encode(f) : f;
        },
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
