
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {parseEntry, walkFiles, type DirLister} from '../src/driver/fs.ts';

/**
 * A `fsListDir` over a literal tree. Keys are directory paths, values are the entries
 * that directory holds (directories carrying the trailing `/` the contract requires).
 * Any path not present rejects, mirroring a real missing directory.
 */
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

describe('parseEntry', function() {
  it('reads the trailing-slash directory marker', function() {
    expect(parseEntry('src/')).toEqual({name: 'src', dir: true});
    expect(parseEntry('main.s')).toEqual({name: 'main.s', dir: false});
  });

  // A filename can't contain a slash on Windows or POSIX, so the marker is unambiguous
  // and a name that merely *contains* one is still just a file.
  it('only treats a trailing slash as the marker', function() {
    expect(parseEntry('a.b/c')).toEqual({name: 'a.b/c', dir: false});
  });
});

describe('walkFiles', function() {
  const tree = {
    '.': ['main.s', 'src/', 'assets/'],
    'src': ['b.s', 'a.s', 'deep/'],
    'src/deep': ['z.s'],
    'assets': ['tiles.chr'],
  };

  it('yields every file with the path joined onto the root', async function() {
    const seen: string[] = [];
    await walkFiles(lister(tree), '.', async f => { seen.push(f); return false; });
    expect(seen).toEqual([
      'assets/tiles.chr',
      'main.s',
      'src/a.s',
      'src/b.s',
      'src/deep/z.s',
    ]);
  });

  // Module order decides segment layout, so two machines whose readdir returns entries
  // in different orders still have to produce the same ROM.
  it('sorts entries so the order does not depend on the filesystem', async function() {
    const shuffled = {...tree, 'src': ['deep/', 'b.s', 'a.s']};
    const seen: string[] = [];
    await walkFiles(lister(shuffled), 'src', async f => { seen.push(f); return false; });
    expect(seen).toEqual(['src/a.s', 'src/b.s', 'src/deep/z.s']);
  });

  it('stops early when the visitor returns true', async function() {
    const seen: string[] = [];
    const stopped = await walkFiles(lister(tree), '.', async f => {
      seen.push(f);
      return f === 'main.s';
    });
    expect(stopped).toBe(true);
    // Nothing after main.s in sorted order should have been visited.
    expect(seen).toEqual(['assets/tiles.chr', 'main.s']);
  });

  it('reports false when the visitor never matches', async function() {
    expect(await walkFiles(lister(tree), '.', async () => false)).toBe(false);
  });

  // A best-effort search must not die because one subdirectory is unreadable.
  it('skips a directory it cannot list instead of throwing', async function() {
    const broken = {'.': ['ok/', 'denied/'], 'ok': ['x.s']};
    const seen: string[] = [];
    await walkFiles(lister(broken), '.', async f => { seen.push(f); return false; });
    expect(seen).toEqual(['ok/x.s']);
  });

  it('returns false for a root that does not exist', async function() {
    expect(await walkFiles(lister({}), 'nope', async () => true)).toBe(false);
  });

  it('does not descend into a directory once the visitor has stopped', async function() {
    const l = lister(tree);
    await walkFiles(l, '.', async f => f === 'assets/tiles.chr');
    expect(l.calls).toEqual(['.', 'assets']);
  });
});
