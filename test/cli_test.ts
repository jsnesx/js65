
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect, spyOn} from 'bun:test';
import {Cli} from '../src/driver/cli.ts'
import { fromHexString, fromByteString, joinDir } from "../src/util.ts";
import { VERSION } from '../src/version.ts';
import { createHash } from "sha1-uint8array";

describe('CLI', function() {
  // disable the usage message to keep the test output clean
  spyOn(console, "log").mockImplementation(() => {});
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
      fsListDir: async () => [],
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
      console.log = (...args: unknown[]) => { lines.push(...args.join(' ').split('\n')); };
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
        fsListDir: async () => [],
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
      fsListDir: async () => [],
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
        fsListDir: async () => [],
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

  describe('printing several lints at once', function() {
    // A build with a run of lints from more than one rule, and from more than
    // one file, which is where the per-message code tag and the source snippet
    // have to keep track of which message they belong to.
    const tree: Record<string, string> = {
      'main.s': [
        '.segment "CODE"',
        '.include "lib/tails.asm"',
        'main:',
        '  jsr helper',
        '  rts',
        '  jmp next',
        'next:',
        '  rts',
      ].join('\n') + '\n',
      'lib/tails.asm': [
        '.include "helper.inc"',
        'first:',
        '  jsr helper',
        '  rts',
        'second:',
        '  jsr helper',
        '  rts',
        'third:',
        '  jmp fourth',
        'fourth:',
        '  rts',
      ].join('\n') + '\n',
      // Included from lib/tails.asm, so it is resolved against that file's own
      // directory rather than the one the include names.
      'lib/helper.inc': [
        'helper:',
        '  rts',
        'nested:',
        '  jsr helper',
        '  rts',
      ].join('\n') + '\n',
    };

    /** Runs the cli over `tree` and returns everything it printed, by line. */
    async function lintOutput(): Promise<string[]> {
      const read = (path: string, filename: string) => {
        const key = joinDir(path, filename);
        if (!(key in tree)) throw new Error(`ENOENT ${key}`);
        return tree[key];
      };
      const cli = new Cli({
        fsReadString: async (path, filename) => read(path, filename),
        fsReadBytes: async (path, filename) =>
            new TextEncoder().encode(read(path, filename)),
        fsWriteString: async () => {},
        fsWriteBytes: async () => {},
        fsListDir: async () => [],
        exit: (code: number) => { if (code !== 0) throw new Error(`exit ${code}`); },
      });
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => { lines.push(...args.join(' ').split('\n')); };
      try {
        await cli.run(['--target', 'sim', '-o', 'out.nes', 'main.s']);
      } finally {
        console.log = log;
      }
      return lines;
    }

    /** Just the `file:line:col: level: message [code]` lines. */
    function diagnostics(lines: string[]): string[] {
      return lines.filter(l => /^\S+:\d+:\d+: (note|warning|error): /.test(l));
    }

    it('should tag each message with the rule that reported it',
       async function() {
      const notes = diagnostics(await lintOutput());
      // Four tail calls and two fall-throughs, all in one run.
      expect(notes.filter(l => l.includes('followed by `rts`')).length).toBe(4);
      expect(notes.filter(l => l.includes('jumps to the next instruction')).length)
          .toBe(2);
      for (const note of notes) {
        const code = /\[([a-z-]+)\]$/.exec(note)?.[1];
        if (note.includes('followed by `rts`')) {
          expect(code, note).toBe('jsr-rts-tail-call');
        } else {
          expect(code, note).toBe('jmp-fallthrough');
        }
      }
    });

    it('should print the messages in source order', async function() {
      // Not the order the rules fired in: the tail calls are only decided at
      // the end of the module, well after the fall-throughs are reported.
      const notes = diagnostics(await lintOutput());
      expect(notes.map(l => /^(\S+?:\d+):\d+:/.exec(l)![1])).toEqual([
        'lib/helper.inc:4',
        'lib/tails.asm:3',
        'lib/tails.asm:6',
        'lib/tails.asm:9',
        'main.s:4',
        'main.s:6',
      ]);
    });

    it('should print the source line under every message', async function() {
      const lines = await lintOutput();
      // Each diagnostic is followed by its ` NN |  <source>` snippet and the
      // caret line under it, whichever file the lint came from.
      for (let i = 0; i < lines.length; i++) {
        if (!diagnostics([lines[i]]).length) continue;
        const line = /^.+?:(\d+):\d+: /.exec(lines[i])![1];
        expect(lines[i + 1], lines[i]).toMatch(new RegExp(`^ *${line} \\| `));
        expect(lines[i + 2], lines[i]).toContain('^');
      }
    });
  });

  describe('--create-dep', function() {
    const cli = new Cli({
      fsReadString: async () => '',
      fsReadBytes: async () => new Uint8Array(0),
      fsWriteString: async () => {},
      fsWriteBytes: async () => {},
      fsListDir: async () => [],
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
        fsListDir: async () => [],
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
        fsListDir: async () => [],
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
      fsListDir: async () => [],
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
        fsListDir: async () => [],
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
      expect(cli.parseArgs(['-t', 'sim']).options.target).toBe('sim');
      expect(cli.parseArgs(['-tsim']).options.target).toBe('sim');
      expect(cli.parseArgs(['-t=sim']).options.target).toBe('sim');
    });

    it('accepts every -V spelling', function() {
      expect(cli.parseArgs(['-V']).version).toBe(true);
      expect(cli.parseArgs(['--version']).version).toBe(true);
      expect(cli.parseArgs(['main.s']).version).toBe(false);
    });

    it('accepts every --asm-include-dir spelling', function() {
      const paths = (...args: string[]) =>
          cli.parseArgs(args).options.includePaths;
      expect(paths('--asm-include-dir', 'inc')).toEqual(['inc']);
      expect(paths('--asm-include-dir=inc')).toEqual(['inc']);
      // It's the same list as -I, in the order given.
      expect(paths('-I', 'a', '--asm-include-dir', 'b')).toEqual(['a', 'b']);
    });

    it('accepts and ignores every -u spelling', function() {
      const s = strict();
      for (const args of [['-u', 'SYM'], ['-uSYM'], ['--force-import', 'SYM'],
                          ['--force-import=SYM']]) {
        const parsed = s.parse([...args, 'main.s']);
        // The symbol name is neither an error nor an input file.
        expect(parsed.files).toEqual(['main.s']);
      }
      expect(s.exits).toEqual([]);
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
        console.log = (...args: unknown[]) => { lines.push(...args.join(' ').split('\n')); };
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

    describe('--feature', function() {
      const features = (...args: string[]) => cli.parseArgs(args).options.features;

      it('accepts every --feature spelling', function() {
        expect(features('--feature', 'c_comments')).toEqual(['c_comments']);
        expect(features('--feature=c_comments')).toEqual(['c_comments']);
      });

      it('splits a comma separated list, like ca65', function() {
        expect(features('--feature', 'c_comments,pc_assignment'))
            .toEqual(['c_comments', 'pc_assignment']);
        expect(features('--feature=c_comments, pc_assignment'))
            .toEqual(['c_comments', 'pc_assignment']);
      });

      it('keeps repeated features in order', function() {
        expect(features('--feature', 'c_comments', '--feature=force_range,pc_assignment'))
            .toEqual(['c_comments', 'force_range', 'pc_assignment']);
      });

      it('enables nothing when no --feature is given', function() {
        expect(features('main.s')).toEqual([]);
      });

      it('does not validate the name, leaving that to the assembler', function() {
        // One list, one validator: `.feature` and `--feature` have to agree, so
        // the name goes through untouched and is checked where `.feature` is.
        const s = strict();
        expect(s.parse(['--feature', 'nonsense']).options.features)
            .toEqual(['nonsense']);
        expect(s.exits).toEqual([]);
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

  describe('--version', function() {
    /** Runs the cli with console.log captured, and reports the exit codes. */
    async function run(args: string[]) {
      const exits: number[] = [];
      const lines: string[] = [];
      const cli = new Cli({
        fsReadString: async () => '',
        fsReadBytes: async () => new Uint8Array(0),
        fsWriteString: async () => {},
        fsWriteBytes: async () => {},
        fsListDir: async () => [],
        exit: (code: number) => { exits.push(code); },
      });
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(...a.join(' ').split('\n')); };
      try {
        await cli.run(args);
      } finally {
        console.log = log;
      }
      return {exits, output: lines.join('\n')};
    }

    it('prints the version and exits 0 without any input file', async function() {
      for (const flag of ['-V', '--version']) {
        const {exits, output} = await run([flag]);
        expect(output).toContain(VERSION);
        expect(exits).toEqual([0]);
        // Specifically not the "No input files provided" usage error.
        expect(output).not.toContain('Usage:');
      }
    });
  });

  // -t is ld65's spelling of --target, so it has to reach the linker and not
  // merely parse. An unsupported name has to say so rather than linking into a
  // layout with no segments in it.
  describe('-t end to end', function() {
    it('links the same as --target', async function() {
      const short = await makeFiles(
          ['-t', 'sim', '--stdin', '-o', 'out.bin'], 'lda #3');
      const long = await makeFiles(
          ['--target', 'sim', '--stdin', '-o', 'out.bin'], 'lda #3');
      expect([...short.get('out.bin')!]).toEqual([...long.get('out.bin')!]);
    });

    it('rejects a ca65 target name', async function() {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(...a.join(' ').split('\n')); };
      try {
        await expect(makeFiles(['-t', 'nes', '--stdin', '-o', 'out.bin'], 'lda #3'))
            .rejects.toThrow();
      } finally {
        console.log = log;
      }
      expect(lines.join('\n')).toContain('Unknown target: nes');
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
        fsListDir: async () => [],
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
        fsListDir: async () => [],
        exit: (code: number) => { exitCode = code; },
      });
      await cli.run(['--target', 'sim', '-DFOO=5', '-o', 'out.bin', 'a.s', 'b.s']);
      expect(exitCode).toBe(0);
      expect([...written.get('out.bin')!]).toEqual([5, 6]);
    });
  });

  // js65 is one binary playing both the ca65 and the ld65 role, so the single
  // -D list also feeds the linker, where a numeric define overrides a config
  // SYMBOLS entry the way ld65's -D does.
  describe('-D linker overrides', function() {
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
        fsListDir: async () => [],
        exit: (code: number) => { exitCode = code; },
      });
      await cli.run(args);
      if (exitCode !== 0) throw new Error(`cli exited with code ${exitCode}`);
      return written;
    }

    /** Links main.s against nes.cfg, returning the output bytes. */
    async function bytes(cfg: string, src: string, args: string[] = []) {
      const written = await build({'main.s': src, 'nes.cfg': cfg},
                                  ['-C', 'nes.cfg', '-o', 'rom.nes', ...args,
                                   'main.s']);
      return [...written.get('rom.nes')!];
    }

    const IMPORT_CFG = `
      SYMBOLS { FOO: type = export, value = $12; }
      MEMORY { PRG: start = $8000, size = $4, file = %O, fill = yes,
               fillval = $ff; }
      SEGMENTS { CODE: load = PRG; }`;
    const IMPORT_SRC = '.segment "CODE"\n.import FOO\nlda #FOO\n';

    it('uses the config value when no -D is given', async function() {
      expect(await bytes(IMPORT_CFG, IMPORT_SRC))
          .toEqual([0xa9, 0x12, 0xff, 0xff]);
    });

    it('overrides a config SYMBOLS value in the linked output', async function() {
      expect(await bytes(IMPORT_CFG, IMPORT_SRC, ['-D', 'FOO=$34']))
          .toEqual([0xa9, 0x34, 0xff, 0xff]);
    });

    it('lets an .import take the name back from the assembler side',
       async function() {
      // The same -D also defines FOO as a `.set` symbol for the assembler, so
      // without the handoff this collides with `Symbol 'FOO' already defined`.
      // .importzp takes the same path as .import.
      expect(await bytes(IMPORT_CFG, '.segment "CODE"\n.importzp FOO\nlda FOO\n',
                         ['-DFOO=$34'])).toEqual([0xa5, 0x34, 0xff, 0xff]);
    });

    it('does not let a -D satisfy an .import on its own', async function() {
      // Proof that the import really came from the link: with nothing exporting
      // FOO, the define must not quietly stand in for it.
      const cfg = `
        MEMORY { PRG: start = $8000, size = $4, file = %O, fill = yes,
                 fillval = $ff; }
        SEGMENTS { CODE: load = PRG; }`;
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => { lines.push(...args.join(' ').split('\n')); };
      try {
        await expect(bytes(cfg, IMPORT_SRC, ['-DFOO=$34'])).rejects.toThrow();
      } finally {
        console.log = log;
      }
      expect(lines.join('\n')).toContain('FOO');
    });

    it('overrides a symbol the config geometry is built from', async function() {
      const cfg = `
        SYMBOLS { __PAD__: type = weak, value = $2; }
        MEMORY { PRG: start = $8000, size = $2 + __PAD__, file = %O,
                 fill = yes, fillval = $ff; }
        SEGMENTS { CODE: load = PRG; }`;
      const src = '.segment "CODE"\nlda #3\n';
      expect(await bytes(cfg, src)).toEqual([0xa9, 3, 0xff, 0xff]);
      expect(await bytes(cfg, src, ['-D__PAD__=6']))
          .toEqual([0xa9, 3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    });

    it('ignores a define the linker has no use for', async function() {
      // A -D meant for the assembler - a name the config never mentions, or a
      // value that is not a number - must not disturb the link.
      expect(await bytes(IMPORT_CFG, IMPORT_SRC,
                         ['-DDEBUG=1', '-DGREETING=hello', '-DEXPR=1+2']))
          .toEqual([0xa9, 0x12, 0xff, 0xff]);
    });

    it('lets the last -D of a name win on the linker side', async function() {
      expect(await bytes(IMPORT_CFG, IMPORT_SRC, ['-DFOO=$34', '-DFOO=$56']))
          .toEqual([0xa9, 0x56, 0xff, 0xff]);
    });

    it('collides with a source definition of the same name', async function() {
      // Only `.import` hands the name to the linker. A source file that
      // defines the name itself conflicts with the assembler half of the -D,
      // exactly as `ca65 -D FOO=1` on a file containing `FOO = $78` does.
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => { lines.push(...args.join(' ').split('\n')); };
      try {
        await expect(bytes(IMPORT_CFG, '.segment "CODE"\nFOO = $78\nlda #FOO\n',
                           ['-DFOO=$34'])).rejects.toThrow();
      } finally {
        console.log = log;
      }
      expect(lines.join('\n')).toContain('FOO');
    });
  });

  // Each case here is a source that only assembles - or only assembles to these
  // bytes - if the flag actually reached the assembler's options, so a
  // parsed-but-ignored --feature fails them.
  describe('--feature end to end', function() {
    async function bytes(args: string[], src: string) {
      const files = await makeFiles(
          ['--target', 'sim', '--stdin', '-o', 'out.bin', ...args], src);
      return [...files.get('out.bin')!];
    }

    /** Runs a build expected to fail, returning everything it printed. */
    async function failure(args: string[], src: string) {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(...a.join(' ').split('\n')); };
      try {
        await expect(bytes(args, src)).rejects.toThrow();
      } finally {
        console.log = log;
      }
      return lines.join('\n');
    }

    it('turns on underline_in_numbers', async function() {
      expect(await bytes(['--feature', 'underline_in_numbers'], 'lda #1_0\n'))
          .toEqual([0xa9, 10]);
    });

    it('leaves underline_in_numbers off without the flag', async function() {
      expect(await failure([], 'lda #1_0\n')).toContain('Bad decimal number');
    });

    it('turns on bracket_as_indirect', async function() {
      const viaFeature = await bytes(['--feature=bracket_as_indirect'],
                                     'lda [$10],y\n');
      expect(viaFeature).toEqual(await bytes([], 'lda ($10),y\n'));
    });

    it('leaves bracket_as_indirect off without the flag', async function() {
      expect(await failure([], 'lda [$10],y\n')).toContain('Bad expression token');
    });

    it('applies every name in a comma separated list', async function() {
      expect(await bytes(['--feature', 'underline_in_numbers,bracket_as_indirect'],
                         'lda #1_0\nlda [$10],y\n'))
          .toEqual([0xa9, 10, 0xb1, 0x10]);
    });

    it('produces the same result as the equivalent .feature line',
       async function() {
      const viaFlag = await bytes(['--feature', 'bracket_as_indirect'],
                                  'lda [$10],y\n');
      const viaSource = await bytes([], '.feature bracket_as_indirect\nlda [$10],y\n');
      expect(viaFlag).toEqual(viaSource);
    });

    it('reports an unknown name the way .feature does', async function() {
      // One name list, one error - a name js65 has never heard of has to fail
      // identically whichever side it came from.
      const viaFlag = await failure(['--feature', 'nonsense'], 'lda #1\n');
      const viaSource = await failure([], '.feature nonsense\n');
      expect(viaFlag).toContain('Unknown feature: nonsense');
      expect(viaSource).toContain('Unknown feature: nonsense');
    });

    it('reports a name js65 cannot support as unsupported', async function() {
      expect(await failure(['--feature', 'dollar_is_pc'], 'lda #1\n'))
          .toContain('Unsupported feature: dollar_is_pc');
    });

    it('warns without failing for a feature js65 always applies',
       async function() {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(...a.join(' ').split('\n')); };
      try {
        expect(await bytes(['--feature', 'string_escapes'], 'lda #1\n'))
            .toEqual([0xa9, 1]);
      } finally {
        console.log = log;
      }
      expect(lines.join('\n')).toContain('Cannot change feature string_escapes');
    });

    it('applies the feature to every input module', async function() {
      // Each module builds its own options from the same base, so the flag has
      // to survive that copy rather than only reaching the first file.
      const written = new Map<string, Uint8Array>();
      const src: Record<string, string> = {
        'a.s': '.byte 1_0\n',
        'b.s': '.byte 2_0\n',
      };
      let exitCode = 0;
      const cli = new Cli({
        fsReadString: async (_p, f) => src[f],
        fsReadBytes: async (_p, f) => new TextEncoder().encode(src[f]),
        fsWriteString: async () => {},
        fsWriteBytes: async (_p, f, d) => { written.set(f, d); },
        fsListDir: async () => [],
        exit: (code: number) => { exitCode = code; },
      });
      await cli.run(['--target', 'sim', '--feature', 'underline_in_numbers',
                     '-o', 'out.bin', 'a.s', 'b.s']);
      expect(exitCode).toBe(0);
      expect([...written.get('out.bin')!]).toEqual([10, 20]);
    });
  });

  // The ROM search walks the tree through the shared walkFiles helper rather than a
  // per-frontend recursive listing, so cover that it still finds a nested match.
  describe('rehydrate ROM search', function() {
    const prg = new Uint8Array(0x40000);
    prg.set([0xa9, 0x05, 0x60]);
    const rom = new Uint8Array(0x40010);
    rom.set(prg, 0x10);
    const sha = Array.from(new Uint8Array(createHash().update(rom).digest()),
                           x => x.toString(16).padStart(2, '0')).join('');

    /** Runs `rehydrate` over a tree, returning what got written and which dirs were listed. */
    async function search(tree: Record<string, string[]>, roms: Record<string, Uint8Array>,
                          src = `; smudge sha1 ${sha}\nlda #$05\n`) {
      const listed: string[] = [];
      let written = '';
      let exitCode = 0;
      const cli = new Cli({
        fsReadString: async (_p, f) => {
          if (f === 'in.s') return src;
          throw new Error(`no such file: ${f}`);
        },
        fsReadBytes: async (_p, f) => {
          const r = roms[f];
          if (!r) throw new Error(`no such file: ${f}`);
          return r;
        },
        fsWriteString: async (_p, _f, data) => { written = data; },
        fsWriteBytes: async () => {},
        fsListDir: async (dir: string) => {
          listed.push(dir);
          const entries = tree[dir];
          if (!entries) throw new Error(`Could not list directory: ${dir}`);
          return entries;
        },
        exit: (code: number) => { exitCode = code; },
      });
      await cli.run(['rehydrate', '-o', 'out.s', 'in.s']);
      return {written, exitCode, listed};
    }

    it('finds a matching rom nested under the working directory', async function() {
      const {written, exitCode} = await search(
          {'.': ['in.s', 'roms/'], 'roms': ['game.nes']},
          {'roms/game.nes': rom});
      expect(exitCode).toBe(0);
      expect(written.length).toBeGreaterThan(0);
    });

    it('ignores roms whose hash does not match', async function() {
      const other = new Uint8Array(0x40010);
      other.set([1, 2, 3]);
      const {exitCode} = await search(
          {'.': ['in.s', 'roms/'], 'roms': ['wrong.nes']},
          {'roms/wrong.nes': other});
      // usage(1) fires when no rom matches the sha1 tag.
      expect(exitCode).toBe(1);
    });

    it('does not fail when a subdirectory cannot be listed', async function() {
      const {exitCode} = await search(
          {'.': ['in.s', 'denied/', 'roms/'], 'roms': ['game.nes']},
          {'roms/game.nes': rom});
      expect(exitCode).toBe(0);
    });

    // exec() returns null rather than undefined, so the original `=== undefined` guard
    // never fired and this fell through to a TypeError instead of the usage message.
    it('reports a missing sha1 tag instead of crashing', async function() {
      const {exitCode, written} = await search(
          {'.': ['in.s']}, {}, 'lda #$05\n');
      expect(exitCode).toBe(1);
      expect(written).toBe('');
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
        fsListDir: async () => [],
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
    fsListDir: async (_dir: string) => {
      // unused for now
      return await Promise.resolve([]);
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
    fsListDir: async (_dir: string) => {
      return await Promise.resolve([]);
    },
    exit: (code: number) => { exitCode = code; },
  });

  await cli.run(args);
  if (exitCode !== 0) throw new Error(`cli exited with code ${exitCode}`);
  return files;
}
