// SPDX-License-Identifier: MPL-2.0

/**
 * The node-`fs` half of project loading. Parsing and validation are covered by
 * `test/project_test.ts` against `src/driver/project.ts`; what matters here is that
 * the server finds the file, expands globs and reads the linker config off disk.
 */

import {describe, it, expect} from 'bun:test';
import * as path from 'node:path';

import {findProjectFile, loadProject, projectsOwningFile, standaloneProject, toPosix} from '../project.ts';
import {MemFs} from './memfs.ts';

describe('project', () => {
  describe('findProjectFile', () => {
    it('walks up until it finds a js65.json', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: '{"projects":[]}'},
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
    it('parses a multi-project file and resolves paths against root', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: JSON.stringify({
          projects: [{
            name: 'main',
            sources: ['src/main.s'],
            includePaths: ['inc'],
            binIncludePaths: ['chr'],
            target: 'nes',
          }],
        })},
        '/proj/src/main.s': {content: ''},
      });
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(proj.projects).toHaveLength(1);
      const u = proj.projects[0];
      expect(u.name).toBe('main');
      // Paths get resolved absolute + normalized POSIX.
      expect(toPosix(u.sources[0]).endsWith('src/main.s')).toBe(true);
      expect(toPosix(u.includePaths[0]).endsWith('inc')).toBe(true);
    });

    it('expands source globs against the filesystem, sorted', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: JSON.stringify({
          projects: [{name: 'main', sources: ['src/**/*.s']}],
        })},
        '/proj/src/b.s': {content: ''},
        '/proj/src/a.s': {content: ''},
        '/proj/src/deep/c.s': {content: ''},
        '/proj/src/notes.txt': {content: ''},
      });
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(proj.projects[0].sources)
          .toEqual(['/proj/src/a.s', '/proj/src/b.s', '/proj/src/deep/c.s']);
    });

    it('reports a glob that matches nothing', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: JSON.stringify({
          projects: [{name: 'main', sources: ['src/*.s']}],
        })},
        '/proj/src/main.txt': {content: ''},
      });
      expect(() => loadProject('/proj/js65.json', fs.sync as any))
          .toThrow(/no files matched source pattern/);
    });

    it('reads linkerConfig from the referenced file', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: JSON.stringify({
          projects: [{name: 'x', sources: ['x.s'], linkerConfig: 'cfg/x.cfg'}],
        })},
        '/proj/cfg/x.cfg': {content: 'MEMORY { ... }'},
      });
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(proj.projects[0].linkerConfig).toBe('MEMORY { ... }');
      expect(proj.projects[0].linkerConfigPath).toBe('/proj/cfg/x.cfg');
    });

    it('names the file when the linker config is missing', () => {
      const fs = new MemFs({
        '/proj/js65.json': {content: JSON.stringify({
          projects: [{name: 'x', sources: ['x.s'], linkerConfig: 'cfg/x.cfg'}],
        })},
      });
      expect(() => loadProject('/proj/js65.json', fs.sync as any))
          .toThrow(/could not read linkerConfig \/proj\/cfg\/x\.cfg/);
    });

    it('surfaces validation errors from the parser', () => {
      const fs = new MemFs({'/proj/js65.json': {content: '{}'}});
      expect(() => loadProject('/proj/js65.json', fs.sync as any)).toThrow(/projects/);
    });
  });

  describe('projectsOwningFile', () => {
    it('finds direct sources entries', () => {
      const fs = new MemFs({'/proj/js65.json': {content: JSON.stringify({
        projects: [{name: 'a', sources: ['src/a.s']}, {name: 'b', sources: ['src/b.s']}],
      })}});
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(projectsOwningFile(proj, toPosix('/proj/src/a.s')).map(u => u.name)).toEqual(['a']);
    });

    it('returns nothing for an orphan leaf (handled by include graph later)', () => {
      const fs = new MemFs({'/proj/js65.json': {content: JSON.stringify({
        projects: [{name: 'a', sources: ['src/a.s']}],
      })}});
      const proj = loadProject('/proj/js65.json', fs.sync as any);
      expect(projectsOwningFile(proj, toPosix('/proj/include/leaf.inc'))).toHaveLength(0);
    });
  });

  describe('standaloneProject', () => {
    it('sets include paths to the file dir + workspace root', () => {
      const project = standaloneProject(toPosix('/proj/src/x.s'), '/proj');
      expect(toPosix(project.sources[0]).endsWith('src/x.s')).toBe(true);
      expect(project.includePaths.some(p => toPosix(p).endsWith('src'))).toBe(true);
    });

    // Finding #21: keying by basename collided for two same-named files.
    it('names the project by full path, so same-named files stay distinct', () => {
      const one = standaloneProject(toPosix('/proj/one/main.s'), '/proj');
      const two = standaloneProject(toPosix('/proj/two/main.s'), '/proj');
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
