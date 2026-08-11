
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {parseProject, standaloneProject} from '../src/driver/project.ts';

/** Parse a project file whose text is given as an object, from `/proj/js65.json`. */
function parse(config: unknown) {
  return parseProject('/proj/js65.json', JSON.stringify(config));
}

describe('parseProject', function() {
  it('resolves paths against the project file, not the cwd', function() {
    const config = parse({projects: [{
      name: 'game',
      sources: ['src/main.s'],
      includePaths: ['inc'],
      binIncludePaths: ['assets'],
      linkerConfig: 'cfg/nes.cfg',
      baseRom: 'base.nes',
    }]});
    expect(config.rootDir).toBe('/proj');
    const p = config.projects[0];
    expect(p.includePaths).toEqual(['/proj/inc']);
    expect(p.binIncludePaths).toEqual(['/proj/assets']);
    expect(p.linkerConfigPath).toBe('/proj/cfg/nes.cfg');
    expect(p.baseRom).toBe('/proj/base.nes');
  });

  // Reading a file is I/O, and this module has no filesystem.
  it('leaves sources unexpanded and the linker config unread', function() {
    const p = parse({projects: [{sources: ['src/**/*.s']}]}).projects[0];
    expect(p.sourcePatterns).toEqual(['src/**/*.s']);
    expect(p.sources).toEqual([]);
    expect(p.linkerConfig).toBeUndefined();
  });

  it('normalizes backslashes in patterns', function() {
    const p = parse({projects: [{sources: ['src\\main.s']}]}).projects[0];
    expect(p.sourcePatterns).toEqual(['src/main.s']);
  });

  describe('output defaults', function() {
    it('writes <name>.nes into the default build directory', function() {
      const config = parse({projects: [{name: 'game', sources: ['src/main.s']}]});
      expect(config.outDir).toBe('/proj/build');
      expect(config.projects[0].output).toBe('/proj/build/game.nes');
      expect(config.projects[0].format).toBe('binary');
    });

    it('honors outDir for output, dbgfile and mapfile', function() {
      const config = parse({outDir: 'out/roms', projects: [{
        name: 'game', sources: ['src/main.s'],
        output: 'game.prg', dbgfile: 'game.mlb', mapfile: 'game.map',
      }]});
      expect(config.outDir).toBe('/proj/out/roms');
      const p = config.projects[0];
      expect(p.output).toBe('/proj/out/roms/game.prg');
      expect(p.dbgfile).toBe('/proj/out/roms/game.mlb');
      expect(p.mapfile).toBe('/proj/out/roms/game.map');
    });

    it('names an unnamed project after its first literal source', function() {
      expect(parse({projects: [{sources: ['src/game.s', 'src/x.s']}]}).projects[0].name)
          .toBe('game');
    });

    // `*.s` would make a terrible name, and a worse output file.
    it('falls back to the project directory when every source is a glob', function() {
      expect(parse({projects: [{sources: ['src/**/*.s']}]}).projects[0].name).toBe('proj');
    });
  });

  it('turns the defines object into SymbolDefines, stringifying values', function() {
    const p = parse({projects: [{sources: ['a.s'], defines: {DEBUG: 1, NAME: 'x', ON: true}}]})
        .projects[0];
    expect(p.defines).toEqual([
      {name: 'DEBUG', value: '1'},
      {name: 'NAME', value: 'x'},
      {name: 'ON', value: 'true'},
    ]);
  });

  it('keeps features and the debug level', function() {
    const p = parse({projects: [{sources: ['a.s'], features: ['c_comments'], debug: -1}]})
        .projects[0];
    expect(p.features).toEqual(['c_comments']);
    expect(p.debug).toBe(-1);
  });

  describe('validation', function() {
    const bad = (config: unknown) => () => parse(config);
    it('requires a projects array', function() {
      expect(bad({})).toThrow(/expected a top-level "projects" array/);
      expect(bad({projects: {}})).toThrow(/expected a top-level "projects" array/);
    });

    it('rejects invalid JSON with the file name attached', function() {
      expect(() => parseProject('/proj/js65.json', '{oops')).toThrow(/^\/proj\/js65\.json: invalid JSON/);
    });

    it('requires each project to declare sources', function() {
      expect(bad({projects: [{name: 'x'}]})).toThrow(/projects\[0\]\.sources must be an array of strings/);
      expect(bad({projects: [{sources: [1]}]})).toThrow(/projects\[0\]\.sources must be an array of strings/);
      expect(bad({projects: [{sources: []}]})).toThrow(/projects\[0\]\.sources is empty/);
    });

    it('checks field types', function() {
      expect(bad({outDir: 3, projects: []})).toThrow(/outDir must be a string/);
      expect(bad({projects: [{sources: ['a.s'], includePaths: 'inc'}]}))
          .toThrow(/includePaths must be an array of strings/);
      expect(bad({projects: [{sources: ['a.s'], format: 'nes'}]}))
          .toThrow(/format must be one of binary, ips, object/);
      expect(bad({projects: [{sources: ['a.s'], debug: 'yes'}]}))
          .toThrow(/debug must be an integer/);
      expect(bad({projects: [{sources: ['a.s'], defines: ['DEBUG=1']}]}))
          .toThrow(/defines must be an object/);
      expect(bad({projects: [{sources: ['a.s'], defines: {D: {}}}]}))
          .toThrow(/defines\.D must be a string, number or boolean/);
    });

    // A silently-ignored typo builds the wrong ROM.
    it('rejects unknown keys, but tolerates $schema', function() {
      expect(bad({projects: [], outdir: 'build'})).toThrow(/unknown key "outdir"/);
      expect(bad({projects: [{sources: ['a.s'], binIncludePath: 'chr'}]}))
          .toThrow(/unknown key "projects\[0\]\.binIncludePath"/);
      expect(parse({$schema: './js65.schema.json', projects: []}).projects).toEqual([]);
    });

    it('validates the lint block', function() {
      expect(parse({projects: [], lint: {enabled: true, rules: {'jmp-fallthrough': 'off'}}}).lint)
          .toEqual({enabled: true, rules: {'jmp-fallthrough': 'off'}});
      expect(parse({projects: []}).lint).toBeUndefined();
      expect(bad({projects: [], lint: 'off'})).toThrow(/"lint" must be an object/);
      expect(bad({projects: [], lint: {enabled: 'no'}})).toThrow(/lint\.enabled/);
      expect(bad({projects: [], lint: {rules: []}})).toThrow(/lint\.rules" must be an object/);
      expect(bad({projects: [], lint: {rules: {'jmp-falthrough': 'off'}}}))
          .toThrow(/unknown lint rule/);
      expect(bad({projects: [], lint: {rules: {'jmp-fallthrough': 'error'}}}))
          .toThrow(/off, info, warning/);
    });
  });
});

describe('standaloneProject', function() {
  it('is ready to assemble without any expansion step', function() {
    const p = standaloneProject('/proj/src/x.s', '/proj');
    expect(p.sources).toEqual(['/proj/src/x.s']);
    expect(p.includePaths).toEqual(['/proj/src', '/proj']);
    expect(p.format).toBe('binary');
  });
});
