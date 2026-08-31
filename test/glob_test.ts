// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {
  expandGlob, expandPathPatterns, globRoot, isGlob, matchGlob, resolveGlob,
} from '../src/driver/glob.ts';
import type {ListDir} from '../src/driver/glob.ts';
import type {FileCallbacks} from '../src/libassembler.ts';

/** A lister over a literal tree, recording which directories were read. */
function lister(tree: Record<string, string[]>): ListDir & {calls: string[]} {
  const calls: string[] = [];
  const list = (dir: string) => {
    calls.push(dir);
    const entries = tree[dir];
    if (!entries) throw new Error(`Could not list directory: ${dir}`);
    return entries;
  };
  return Object.assign(list, {calls});
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

  it('expands ** recursively and sorts the result', function() {
    expect(expandGlob(lister(tree), '.', 'src/**/*.s'))
        .toEqual(['src/a.s', 'src/b.s', 'src/deep/z.s']);
  });

  it('does not descend for a pattern without **', function() {
    const l = lister(tree);
    expect(expandGlob(l, '.', 'src/*.s')).toEqual(['src/a.s', 'src/b.s']);
    // src/deep is below the fixed match depth, so it is never even listed.
    expect(l.calls).not.toContain('src/deep');
  });

  // The whole point of rooting: a pattern under src/ must not read sibling trees.
  it('roots traversal at the pattern\'s literal prefix', function() {
    const l = lister(tree);
    expandGlob(l, '.', 'src/**/*.s');
    expect(l.calls).toEqual(['src', 'src/deep']);
    expect(l.calls).not.toContain('inc');
  });

  it('skips dot-entries so ** stays out of .git', function() {
    const l = lister(tree);
    const found = expandGlob(l, '.', '**/*');
    expect(l.calls).not.toContain('.git');
    expect(found.some(f => f.startsWith('.git'))).toBe(false);
  });

  it('only matches files, never directories', function() {
    expect(expandGlob(lister(tree), '.', 'src/*')).toEqual(
        ['src/a.s', 'src/b.s', 'src/notes.txt']);
  });

  it('returns nothing when the root directory is absent', function() {
    expect(expandGlob(lister(tree), '.', 'missing/**/*.s')).toEqual([]);
  });

  it('resolves patterns against the given root directory', function() {
    const l = lister({'/proj': ['src/'], '/proj/src': ['a.s']});
    expect(expandGlob(l, '/proj', 'src/*.s')).toEqual(['src/a.s']);
  });
});

describe('expandPathPatterns', function() {
  const tree = {
    '.': ['src/', 'gen/'],
    'src': ['b.s', 'a.s'],
    'gen': ['tables.s'],
  };

  it('keeps a literal entry in its declared position', function() {
    expect(expandPathPatterns(lister(tree), '.', ['gen/tables.s', 'src/*.s']))
        .toEqual(['gen/tables.s', 'src/a.s', 'src/b.s']);
    expect(expandPathPatterns(lister(tree), '.', ['src/*.s', 'gen/tables.s']))
        .toEqual(['src/a.s', 'src/b.s', 'gen/tables.s']);
  });

  // A typo'd pattern would otherwise silently link an empty ROM.
  it('throws when a pattern matches nothing', function() {
    expect(() => expandPathPatterns(lister(tree), '.', ['src/*.asm']))
        .toThrow(/no files matched source pattern "src\/\*\.asm"/);
  });

  it('does not throw for a literal entry that does not exist', function() {
    // The read that follows reports the missing file with a better message.
    expect(expandPathPatterns(lister(tree), '.', ['src/nope.s']))
        .toEqual(['src/nope.s']);
  });

  it('assembles an overlapping file only once', function() {
    expect(expandPathPatterns(lister(tree), '.', ['src/a.s', 'src/*.s']))
        .toEqual(['src/a.s', 'src/b.s']);
  });

  it('normalizes a backslash-separated literal', function() {
    expect(expandPathPatterns(lister(tree), '.', ['src\\a.s']))
        .toEqual(['src/a.s']);
  });
});

describe('resolveGlob', function() {
  const tree = {
    '.': ['assets/'],
    'assets': ['b.png', 'a.png', 'notes.txt'],
    'vendor': ['c.png'],
    'vendor/assets': ['c.png'],
  };

  /** A `FileCallbacks` whose resolvers are never reached by these tests. */
  function callbacks(listDir?: (dir: string) => string[]): FileCallbacks {
    return {
      resolveText: () => undefined,
      resolveBinary: () => undefined,
      listDir,
    };
  }

  it('expands a pattern under each base, sorted within the base', function() {
    expect(resolveGlob(callbacks(lister(tree)), ['.'], 'assets/*.png'))
        .toEqual([{base: '.', path: 'assets/a.png'}, {base: '.', path: 'assets/b.png'}]);
  });

  it('searches the bases in order', function() {
    expect(resolveGlob(callbacks(lister(tree)), ['.', 'vendor'], 'assets/*.png'))
        .toEqual([
          {base: '.', path: 'assets/a.png'},
          {base: '.', path: 'assets/b.png'},
          {base: 'vendor', path: 'assets/c.png'},
        ]);
  });

  it('returns nothing for a pattern that matches nothing', function() {
    expect(resolveGlob(callbacks(lister(tree)), ['.'], 'assets/*.chr')).toEqual([]);
  });

  it('passes a literal path through against every base, unexpanded', function() {
    // The caller reads it through the resolve callbacks, which report a real miss.
    expect(resolveGlob(callbacks(), ['.', 'vendor'], 'assets\\nope.png'))
        .toEqual([{base: '.', path: 'assets/nope.png'},
                  {base: 'vendor', path: 'assets/nope.png'}]);
  });

  it('errors on a glob when the frontend cannot list directories', function() {
    expect(() => resolveGlob(callbacks(), ['.'], 'assets/*.png'))
        .toThrow(/no directory listing callback/);
  });
});
