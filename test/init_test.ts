
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {DEFAULT_TARGET, init, scaffold} from '../src/driver/init.ts';
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
