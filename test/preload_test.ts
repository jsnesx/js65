// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {DEFAULT_SKIPPED_DIRECTORIES, isCachablePath, preloadDirectories, preloadPaths,
        scanDirectory, type PreloadIo} from '../src/worker/preload.ts';

/** A tree of POSIX paths -> contents, served in `fsListDir` form. */
function fakeIo(tree: Record<string, string>): PreloadIo & {reads: string[]} {
  const reads: string[] = [];
  return {
    reads,
    listDir(dir) {
      const prefix = dir === '' ? '' : `${dir}/`;
      const names = new Set<string>();
      let hit = false;
      for (const path of Object.keys(tree)) {
        if (!path.startsWith(prefix)) continue;
        hit = true;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash < 0 ? rest : `${rest.slice(0, slash)}/`);
      }
      // Matches the node binding, which throws rather than returning an empty listing.
      if (!hit) throw new Error(`ENOENT ${dir}`);
      return [...names];
    },
    readFile(path) {
      reads.push(path);
      return tree[path];
    },
  };
}

const TREE = {
  '/proj/inc/hdr.inc': 'HDR = $01\n',
  '/proj/inc/nested/deep.inc': 'DEEP = $42\n',
  '/proj/inc/.hidden.inc': 'HIDDEN = $99\n',
  '/proj/inc/node_modules/pkg/index.js': 'nope',
  '/proj/assets/tiles.chr': 'bytes',
  '/proj/js65.json': '{}',
};

describe('preload', function() {
  it('takes every file under a directory, whatever it is called', function() {
    const files = preloadDirectories(fakeIo(TREE), ['/proj/inc']);
    expect([...files.keys()].sort())
        .toEqual(['/proj/inc/hdr.inc', '/proj/inc/nested/deep.inc']);
  });

  it('leaves out hidden entries and dependency directories', function() {
    const found = scanDirectory(fakeIo(TREE), '/proj/inc');
    expect(found).not.toContain('/proj/inc/.hidden.inc');
    expect(found.some(f => f.includes('node_modules'))).toBe(false);
    expect(DEFAULT_SKIPPED_DIRECTORIES.has('node_modules')).toBe(true);
  });

  it('takes hidden entries when asked to', function() {
    const found = scanDirectory(fakeIo(TREE), '/proj/inc', {includeHidden: true});
    expect(found).toContain('/proj/inc/.hidden.inc');
  });

  it('degrades to a partial cache instead of scanning an enormous tree', function() {
    const found = scanDirectory(fakeIo(TREE), '/proj/inc', {maxFiles: 1});
    expect(found.length).toBe(1);
  });

  it('spends one shared budget across every directory in a call', function() {
    const files = preloadDirectories(fakeIo(TREE), ['/proj/inc', '/proj/assets'], {maxFiles: 1});
    expect(files.size).toBe(1);
  });

  it('stops recursing past the depth cap', function() {
    expect(scanDirectory(fakeIo(TREE), '/proj/inc', {maxDepth: 0}))
        .toEqual(['/proj/inc/hdr.inc']);
  });

  it('treats a missing directory as empty rather than throwing', function() {
    expect(scanDirectory(fakeIo(TREE), '/proj/nope')).toEqual([]);
  });

  it('adds named paths onto an existing map without rereading what it has', function() {
    const io = fakeIo(TREE);
    const files = preloadDirectories(io, ['/proj/inc']);
    const before = io.reads.length;
    preloadPaths(io, ['/proj/js65.json', '/proj/inc/hdr.inc'], files);
    expect(files.get('/proj/js65.json')).toBe('{}');
    // `hdr.inc` was already in the map, so only the project file was read.
    expect(io.reads.length).toBe(before + 1);
  });

  it('skips a path the io declines to read', function() {
    const io = fakeIo(TREE);
    expect(preloadPaths(io, ['/proj/missing.s']).size).toBe(0);
  });

  it('rejects a path under a skipped or hidden directory', function() {
    expect(isCachablePath('/proj/inc/hdr.inc')).toBe(true);
    expect(isCachablePath('/proj/node_modules/pkg/x.inc')).toBe(false);
    expect(isCachablePath('/proj/.git/config')).toBe(false);
    expect(isCachablePath('/proj/.git/config', {includeHidden: true})).toBe(true);
  });
});
