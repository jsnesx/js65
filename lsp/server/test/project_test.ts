// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import * as path from 'node:path';

import {findProjectFile, loadProject, unitsOwningFile, standaloneUnit, toPosix} from '../project.ts';
import {MemFs} from './memfs.ts';

describe('project', () => {
  describe('findProjectFile', () => {
    it('walks up until it finds a js65.json', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: '{"units":[]}'},
      });
      const found = findProjectFile('/proj/src/main.s', fs.sync as any);
      expect(found).toBe(path.join('/proj', 'js65.json'));
    });

    it('returns undefined when no project file exists up to root', () => {
      const fs = new MemFs({});
      const found = findProjectFile('/proj/src/main.s', fs.sync as any);
      expect(found).toBeUndefined();
    });
  });

  describe('loadProject', () => {
    it('parses a multi-unit project and resolves paths against root', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: JSON.stringify({
          units: [{
            name: 'main',
            sources: ['src/main.s'],
            includePaths: ['inc'],
            binIncludePaths: ['chr'],
            target: 'nes',
          }],
        })},
        '/proj/cfg/nes.cfg': {content: 'MEMORY { RAM: start = $0400, size = $0800 }'},
      });
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(proj.units).toHaveLength(1);
      const u = proj.units[0];
      expect(u.name).toBe('main');
      // Paths get resolved absolute + normalized POSIX.
      expect(toPosix(u.sources[0]).endsWith('src/main.s')).toBe(true);
      expect(toPosix(u.includePaths[0]).endsWith('inc')).toBe(true);
    });

    it('reads linkerConfig from the referenced file', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: JSON.stringify({
          units: [{name: 'x', sources: ['x.s'], linkerConfig: 'cfg/x.cfg'}],
        })},
        '/proj/cfg/x.cfg': {content: 'MEMORY { ... }'},
      });
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(proj.units[0].linkerConfig).toBe('MEMORY { ... }');
    });

    it('rejects a project file without a units array', () => {
      const fs = new MemFs({'/proj/js65.json': {content: '{}'}});
      expect(() => loadProject('/proj/js65.json', fs.sync as any)).toThrow(/units/);
    });

    it('rejects a unit whose sources is missing or wrong type', () => {
      const fs = new MemFs({'/proj/js65.json': {content: JSON.stringify({units: [{name: 'x'}]})}});
      expect(() => loadProject('/proj/js65.json', fs.sync as any)).toThrow(/sources/);
    });
  });

  describe('unitsOwningFile', () => {
    it('finds direct sources entries', () => {
      const fs = new MemFs({'/proj/js65.json': {content: JSON.stringify({
        units: [{name: 'a', sources: ['src/a.s']}, {name: 'b', sources: ['src/b.s']}],
      })}});
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(unitsOwningFile(proj, toPosix('/proj/src/a.s')).map(u => u.name)).toEqual(['a']);
    });

    it('returns nothing for an orphan leaf (handled by include graph later)', () => {
      const fs = new MemFs({'/proj/js65.json': {content: JSON.stringify({
        units: [{name: 'a', sources: ['src/a.s']}],
      })}});
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(unitsOwningFile(proj, toPosix('/proj/include/leaf.inc'))).toHaveLength(0);
    });
  });

  describe('standaloneUnit', () => {
    it('sets include paths to the file dir + workspace root', () => {
      const unit = standaloneUnit(toPosix('/proj/src/x.s'), '/proj');
      expect(toPosix(unit.sources[0]).endsWith('src/x.s')).toBe(true);
      expect(unit.includePaths.some(p => toPosix(p).endsWith('src'))).toBe(true);
    });

    // Finding #21: keying by basename collided for two same-named files.
    it('names the unit by full path, so same-named files stay distinct', () => {
      const one = standaloneUnit(toPosix('/proj/one/main.s'), '/proj');
      const two = standaloneUnit(toPosix('/proj/two/main.s'), '/proj');
      expect(one.name).not.toBe(two.name);
    });
  });

  // Finding #13: toPosix routed OS paths through joinDir, which collapses the
  // two-slash UNC prefix — `\\server\share\x.s` became `/server/share/x.s`,
  // a different and wrong path.
  describe('toPosix on UNC paths', () => {
    it('preserves the UNC prefix', () => {
      expect(toPosix('\\\\server\\share\\x.s')).toBe('//server/share/x.s');
    });

    it('preserves the prefix while normalizing the rest', () => {
      expect(toPosix('\\\\server\\share\\dir\\..\\x.s')).toBe('//server/share/x.s');
    });

    it('leaves an already-POSIX UNC path alone', () => {
      expect(toPosix('//server/share/x.s')).toBe('//server/share/x.s');
    });

    it('still collapses ordinary absolute paths', () => {
      expect(toPosix('/proj/src/../x.s')).toBe('/proj/x.s');
    });
  });
});
