
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {
  expandGlob, expandPathPatterns, globRoot, isGlob, matchGlob,
} from '../src/driver/glob.ts';
import type {DirLister} from '../src/driver/fs.ts';

/** A `fsListDir` over a literal tree, recording which directories were read. */
function lister(tree: Record<string, string[]>): DirLister & {calls: string[]} {
  const calls: string[] = [];
  return {
    calls,
    fsListDir: async (dir: string) => {
      calls.push(dir);
      const entries = tree[dir];
      if (!entries) throw new Error(`Could not list directory: ${dir}`);
      return entries;
    },
  };
}

describe('isGlob', function() {
  it('detects the supported metacharacters', function() {
    expect(isGlob('src/**/*.s')).toBe(true);
    expect(isGlob('a?.s')).toBe(true);
    expect(isGlob('src/main.s')).toBe(false);
  });
});

describe('matchGlob', function() {
  it('keeps * inside a single segment', function() {
    expect(matchGlob('src/*.s', 'src/main.s')).toBe(true);
    expect(matchGlob('src/*.s', 'src/deep/main.s')).toBe(false);
  });

  it('matches zero or more whole segments for **', function() {
    expect(matchGlob('**/*.s', 'main.s')).toBe(true);
    expect(matchGlob('**/*.s', 'src/main.s')).toBe(true);
    expect(matchGlob('**/*.s', 'a/b/c/main.s')).toBe(true);
    // The zero-segment case is the one implementations disagree about.
    expect(matchGlob('a/**/b', 'a/b')).toBe(true);
    expect(matchGlob('a/**/b', 'a/x/b')).toBe(true);
    expect(matchGlob('a/**/b', 'a/x/y/b')).toBe(true);
  });

  it('lets a trailing ** swallow the rest of the path', function() {
    expect(matchGlob('src/**', 'src/a.s')).toBe(true);
    expect(matchGlob('src/**', 'src/deep/a.s')).toBe(true);
    expect(matchGlob('src/**', 'other/a.s')).toBe(false);
  });

  it('matches exactly one character for ?', function() {
    expect(matchGlob('a?.s', 'ab.s')).toBe(true);
    expect(matchGlob('a?.s', 'a.s')).toBe(false);
    expect(matchGlob('a?.s', 'abc.s')).toBe(false);
    expect(matchGlob('a?.s', 'a/.s')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', function() {
    expect(matchGlob('a+b.s', 'a+b.s')).toBe(true);
    expect(matchGlob('a+b.s', 'aab.s')).toBe(false);
    // A literal dot must not match an arbitrary character.
    expect(matchGlob('main.s', 'mainXs')).toBe(false);
  });

  it('normalizes backslashes so a Windows-style pattern still works', function() {
    expect(matchGlob('src\\*.s', 'src/main.s')).toBe(true);
  });

  // Deliberate: a build has to resolve the same sources on Windows and Linux.
  it('is case-sensitive on every platform', function() {
    expect(matchGlob('src/*.s', 'src/Main.S')).toBe(false);
    expect(matchGlob('src/*.S', 'src/Main.S')).toBe(true);
  });
});

describe('globRoot', function() {
  it('returns the leading literal directories', function() {
    expect(globRoot('src/**/*.s')).toBe('src');
    expect(globRoot('src/gen/*.s')).toBe('src/gen');
    expect(globRoot('*.s')).toBe('');
    expect(globRoot('**/*.s')).toBe('');
  });

  it('drops the filename of a fully literal pattern', function() {
    expect(globRoot('src/main.s')).toBe('src');
  });
});

describe('expandGlob', function() {
  const tree = {
    '.': ['js65.json', 'src/', 'inc/', '.git/'],
    'src': ['b.s', 'a.s', 'deep/', 'notes.txt'],
    'src/deep': ['z.s'],
    'inc': ['constants.inc'],
    '.git': ['config'],
  };

  it('expands ** recursively and sorts the result', async function() {
    expect(await expandGlob(lister(tree), '.', 'src/**/*.s'))
        .toEqual(['src/a.s', 'src/b.s', 'src/deep/z.s']);
  });

  it('does not descend for a pattern without **', async function() {
    const l = lister(tree);
    expect(await expandGlob(l, '.', 'src/*.s')).toEqual(['src/a.s', 'src/b.s']);
    // src/deep is below the fixed match depth, so it is never even listed.
    expect(l.calls).not.toContain('src/deep');
  });

  // The whole point of rooting: a pattern under src/ must not read sibling trees.
  it('roots traversal at the pattern\'s literal prefix', async function() {
    const l = lister(tree);
    await expandGlob(l, '.', 'src/**/*.s');
    expect(l.calls).toEqual(['src', 'src/deep']);
    expect(l.calls).not.toContain('inc');
  });

  it('skips dot-entries so ** stays out of .git', async function() {
    const l = lister(tree);
    const found = await expandGlob(l, '.', '**/*');
    expect(l.calls).not.toContain('.git');
    expect(found.some(f => f.startsWith('.git'))).toBe(false);
  });

  it('only matches files, never directories', async function() {
    expect(await expandGlob(lister(tree), '.', 'src/*')).toEqual(
        ['src/a.s', 'src/b.s', 'src/notes.txt']);
  });

  it('returns nothing when the root directory is absent', async function() {
    expect(await expandGlob(lister(tree), '.', 'missing/**/*.s')).toEqual([]);
  });

  it('resolves patterns against the given root directory', async function() {
    const l = lister({'/proj': ['src/'], '/proj/src': ['a.s']});
    expect(await expandGlob(l, '/proj', 'src/*.s')).toEqual(['src/a.s']);
  });
});

describe('expandPathPatterns', function() {
  const tree = {
    '.': ['src/', 'gen/'],
    'src': ['b.s', 'a.s'],
    'gen': ['tables.s'],
  };

  it('keeps a literal entry in its declared position', async function() {
    expect(await expandPathPatterns(lister(tree), '.', ['gen/tables.s', 'src/*.s']))
        .toEqual(['gen/tables.s', 'src/a.s', 'src/b.s']);
    expect(await expandPathPatterns(lister(tree), '.', ['src/*.s', 'gen/tables.s']))
        .toEqual(['src/a.s', 'src/b.s', 'gen/tables.s']);
  });

  // A typo'd pattern would otherwise silently link an empty ROM.
  it('throws when a pattern matches nothing', async function() {
    await expect(expandPathPatterns(lister(tree), '.', ['src/*.asm']))
        .rejects.toThrow(/no files matched source pattern "src\/\*\.asm"/);
  });

  it('does not throw for a literal entry that does not exist', async function() {
    // The read that follows reports the missing file with a better message.
    expect(await expandPathPatterns(lister(tree), '.', ['src/nope.s']))
        .toEqual(['src/nope.s']);
  });

  it('assembles an overlapping file only once', async function() {
    expect(await expandPathPatterns(lister(tree), '.', ['src/a.s', 'src/*.s']))
        .toEqual(['src/a.s', 'src/b.s']);
  });

  it('normalizes a backslash-separated literal', async function() {
    expect(await expandPathPatterns(lister(tree), '.', ['src\\a.s']))
        .toEqual(['src/a.s']);
  });
});
