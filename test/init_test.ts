
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {Builder, BuildSession, selectProjects} from '../src/driver/build.ts';
import {Cli} from '../src/driver/cli.ts';
import {DEFAULT_TARGET, init, scaffold} from '../src/driver/init.ts';
import {parseProject} from '../src/driver/project.ts';
import {fakeFs} from './fakefs.ts';

/** Scaffold over an in-memory tree and report what landed in it. */
async function runInit(files: Record<string, string|Uint8Array> = {},
                       options: Parameters<typeof init>[1] = {}) {
  const fs = fakeFs(files);
  const result = await init(fs.callbacks, options);
  return {...fs, result, files: [...fs.written.keys()].sort()};
}

const SCAFFOLD_FILES =
    ['assets/tiles.chr', 'inc/constants.inc', 'js65.json', 'src/main.s'];

describe('scaffold', function() {
  it('names the project and its target in js65.json', function() {
    const json = scaffold('demo', 'sim').find(f => f.path === 'js65.json')!;
    expect(JSON.parse(json.text)).toEqual({projects: [{
      name: 'demo',
      sources: ['src/**/*.s'],
      includePaths: ['inc'],
      binIncludePaths: ['assets'],
      target: 'sim',
    }]});
  });

  it('defaults to the nes-nrom target', function() {
    const json = scaffold('demo').find(f => f.path === 'js65.json')!;
    expect(JSON.parse(json.text).projects[0].target).toBe(DEFAULT_TARGET);
  });

  // The `src/**/*.s` glob would otherwise link a header as a module of its own, and
  // every equate in it would collide with the file that included it.
  it('gives headers an extension the source glob does not match', function() {
    for (const file of scaffold('demo')) {
      if (file.path.startsWith('inc/')) expect(file.path).toEndWith('.inc');
    }
  });

  it('writes a zeroed 8KB CHR bank as the tile asset', function() {
    const chr = scaffold('demo').find(f => f.path === 'assets/tiles.chr')!;
    expect(chr.bytes).toBeDefined();
    expect(chr.bytes!.length).toBe(8192);
    expect(chr.bytes!.every(b => b === 0)).toBe(true);
  });
});

describe('init', function() {
  it('writes the whole scaffold into a new directory', async function() {
    const {files, result} = await runInit({}, {dir: 'demo'});
    expect(files).toEqual(SCAFFOLD_FILES.map(f => `demo/${f}`));
    expect(result.name).toBe('demo');
    expect(result.files).toEqual(['js65.json', 'src/main.s', 'inc/constants.inc',
                                 'assets/tiles.chr']);
  });

  it('names the project after the last segment of a nested path', async function() {
    const {result, files} = await runInit({}, {dir: 'games/demo'});
    expect(result.name).toBe('demo');
    expect(files).toContain('games/demo/js65.json');
  });

  it('scaffolds the current directory when no name is given', async function() {
    const {files, result} = await runInit();
    expect(files).toEqual(SCAFFOLD_FILES);
    expect(result.name).toBe('main');
  });

  it('takes an explicit name over the directory name', async function() {
    const {written} = await runInit({}, {dir: 'demo', name: 'mygame'});
    const json = JSON.parse(new TextDecoder().decode(written.get('demo/js65.json')!));
    expect(json.projects[0].name).toBe('mygame');
  });

  // A fresh clone or a folder an editor has touched should still be scaffoldable.
  it('tolerates a directory holding only dot entries', async function() {
    const {files} = await runInit({'.git/HEAD': 'ref: refs/heads/main\n',
                                  '.gitignore': 'build/\n'});
    expect(files).toEqual(SCAFFOLD_FILES);
  });

  it('refuses a directory that holds real content', async function() {
    await expect(runInit({'notes.txt': 'hi'})).rejects.toThrow(
        /\. is not empty \(found notes\.txt\)\. Use --force to scaffold anyway\./);
  });

  it('counts a subdirectory as content too', async function() {
    await expect(runInit({'demo/src/main.s': 'lda #1\n'}, {dir: 'demo'}))
        .rejects.toThrow(/demo is not empty \(found src\)/);
  });

  it('writes nothing at all when it refuses', async function() {
    const fs = fakeFs({'notes.txt': 'hi'});
    await expect(init(fs.callbacks)).rejects.toThrow();
    expect([...fs.written.keys()]).toEqual([]);
  });

  it('scaffolds over existing content with force', async function() {
    const {files} = await runInit({'notes.txt': 'hi'}, {force: true});
    expect(files).toEqual(SCAFFOLD_FILES);
  });

  it('rejects a target that does not exist', async function() {
    await expect(runInit({}, {dir: 'demo', target: 'nes-mmc3'}))
        .rejects.toThrow(/unknown target "nes-mmc3" \(js65 has sim, nes-nrom\)/);
  });
});

/**
 * The onboarding guarantee: whatever `js65 init` writes has to assemble and link as it
 * stands, with no edits and no Makefile.
 */
describe('the generated project', function() {
  async function initThenBuild(args: string[]) {
    const {callbacks, written} = fakeFs();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => { lines.push(...parts.join(' ').split('\n')); };
    let exitCode = 0;
    try {
      const cli = new Cli({...callbacks, exit: code => { exitCode = code; }});
      await cli.run(['init', ...args]);
      await cli.run(['build', ...(args[0] ? ['-p', `${args[0]}/js65.json`] : [])]);
    } finally {
      console.log = log;
    }
    return {exitCode, written, lines, out: lines.join('\n'),
            files: [...written.keys()].sort()};
  }

  it('builds an iNES ROM straight out of init', async function() {
    const {exitCode, written, out} = await initThenBuild(['demo']);
    expect(exitCode).toBe(0);
    const rom = written.get('demo/build/demo.nes')!;
    expect(rom).toBeDefined();
    // `NES\x1a`, then two 16KB PRG banks and one 8KB CHR bank.
    expect([...rom.slice(0, 6)]).toEqual([0x4e, 0x45, 0x53, 0x1a, 2, 1]);
    // 16-byte header + 32KB PRG + 8KB CHR, the canonical NROM-256 size.
    expect(rom.length).toBe(0x10 + 0x8000 + 0x2000);
    expect(out).not.toContain('error');
  });

  // A lint firing on the code js65 itself wrote would teach the wrong lesson.
  it('builds without a single diagnostic', async function() {
    const {out, lines} = await initThenBuild(['demo']);
    expect(out).not.toMatch(/error|warning|note/);
    expect(lines.at(-1)).toMatch(/^\[1\/1\] demo {2}ok {6}build\/demo\.nes \(\d+ bytes\)$/);
  });

  it('points its reset and nmi vectors into the code it assembled', async function() {
    const {written} = await initThenBuild(['demo']);
    const rom = written.get('demo/build/demo.nes')!;
    // The vectors sit at $fffa-$ffff, i.e. the last six bytes of the PRG image.
    const vectors = rom.subarray(0x8010 - 6, 0x8010);
    const at = (i: number) => vectors[i] | (vectors[i + 1] << 8);
    for (const vector of [at(0), at(2), at(4)]) {
      expect(vector).toBeGreaterThanOrEqual(0x8000);
      expect(vector).toBeLessThan(0x10000);
    }
    // reset is the entry point, and the scaffold puts it first.
    expect(at(2)).toBe(0x8000);
  });

  it('builds in the current directory too', async function() {
    const {exitCode, files} = await initThenBuild([]);
    expect(exitCode).toBe(0);
    expect(files).toContain('build/main.nes');
  });

  // The scaffold declares inc/ and assets/ so that a header and a binary dropped into
  // them are found with no further configuration.
  it('finds a new header and a new binary through the declared search paths',
     async function() {
    const {callbacks, written} = fakeFs();
    await init(callbacks, {dir: 'demo'});
    await callbacks.fsWriteString('demo/inc', 'tiles.inc', 'TILE_COUNT = 3\n');
    await callbacks.fsWriteBytes('demo/assets', 'tiles.chr', new Uint8Array([1, 2, 3]));
    await callbacks.fsWriteString('demo/src', 'extra.s',
        '.include "tiles.inc"\n.byte TILE_COUNT\n.incbin "tiles.chr"\n');

    const config = parseProject(
        'demo/js65.json', await callbacks.fsReadString('', 'demo/js65.json'));
    const messages: string[] = [];
    const builder = new Builder(new BuildSession(callbacks),
                                {messages: msgs => { for (const m of msgs) messages.push(m.message); }});
    const result = await builder.build(config, selectProjects(config, []));
    expect(messages).toEqual([]);
    expect(result.success).toBe(true);
    // extra.s links after main.s, so its bytes follow the reset routine.
    expect([...written.get('demo/build/demo.nes')!]).toContain(3);
  });
});

describe('js65 init', function() {
  async function run(files: Record<string, string|Uint8Array>, args: string[]) {
    const {callbacks, written, text} = fakeFs(files);
    const lines: string[] = [];
    let exitCode = 0;
    const log = console.log;
    console.log = (...parts: unknown[]) => { lines.push(...parts.join(' ').split('\n')); };
    try {
      await new Cli({...callbacks, exit: code => { exitCode = code; }}).run(args);
    } finally {
      console.log = log;
    }
    return {exitCode, written, text, lines, out: lines.join('\n'),
            files: [...written.keys()].sort()};
  }

  it('scaffolds the named directory and says how to build it', async function() {
    const {exitCode, files, out} = await run({}, ['init', 'demo']);
    expect(exitCode).toBe(0);
    expect(files).toEqual(SCAFFOLD_FILES.map(f => `demo/${f}`));
    expect(out).toContain('js65: created project "demo" in demo');
    expect(out).toContain('  demo/src/main.s');
    expect(out).toContain('cd demo && js65 build');
  });

  it('scaffolds the current directory when no name is given', async function() {
    const {exitCode, files, out} = await run({}, ['init']);
    expect(exitCode).toBe(0);
    expect(files).toEqual(SCAFFOLD_FILES);
    expect(out).toContain('Build it with: js65 build');
  });

  it('takes the target from -t', async function() {
    const {text} = await run({}, ['init', '-t', 'sim', 'demo']);
    expect(JSON.parse(text('demo/js65.json')).projects[0].target).toBe('sim');
  });

  it('exits 1 for an unknown target, having written nothing', async function() {
    const {exitCode, out, files} = await run({}, ['init', '-t', 'nes-mmc1', 'demo']);
    expect(exitCode).toBe(1);
    expect(out).toContain('unknown target "nes-mmc1"');
    expect(files).toEqual([]);
  });

  it('exits 1 over a directory that holds real content', async function() {
    const {exitCode, out, files} = await run({'notes.txt': 'hi'}, ['init']);
    expect(exitCode).toBe(1);
    expect(out).toContain('is not empty');
    expect(files).toEqual([]);
  });

  it('scaffolds anyway with --force', async function() {
    const {exitCode, files} = await run({'notes.txt': 'hi'}, ['init', '--force']);
    expect(exitCode).toBe(0);
    expect(files).toEqual(SCAFFOLD_FILES);
  });

  it('exits 8 for more than one name', async function() {
    const {exitCode, out, files} = await run({}, ['init', 'one', 'two']);
    expect(exitCode).toBe(8);
    expect(out).toContain('js65 init takes at most one directory name, got 2');
    expect(files).toEqual([]);
  });

  it('exits 8 for an option that has nothing to do with scaffolding', async function() {
    for (const flag of [['-o', 'rom.nes'], ['-c'], ['--ips'], ['-p', 'js65.json'],
                        ['-I', 'inc'], ['-D', 'LEVEL=1']]) {
      const {exitCode, out} = await run({}, ['init', ...flag]);
      expect(exitCode).toBe(8);
      expect(out).toContain('cannot be used with `js65 init`');
    }
  });

  it('prints init usage for `init --help` without writing anything', async function() {
    const {exitCode, out, files} = await run({}, ['init', '--help']);
    expect(exitCode).toBe(0);
    expect(out).toContain('Usage: js65 init [options] [NAME]');
    expect(files).toEqual([]);
  });

  it('rejects --force outside of init', async function() {
    const {exitCode, out} = await run({'main.s': 'lda #1\n'}, ['--force', 'main.s']);
    expect(exitCode).toBe(8);
    expect(out).toContain('--force only applies to `js65 init`');
  });

  it('mentions init in the top-level usage', async function() {
    const {out} = await run({}, ['--help']);
    expect(out).toContain('Usage: js65 init [NAME]');
  });
});
