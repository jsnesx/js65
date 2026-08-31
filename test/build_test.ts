
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect, beforeAll, afterAll} from 'bun:test';
import {Builder, BuildSession, selectProjects, STDIN,
        type BuildOverrides} from '../src/driver/build.ts';
import {Cli} from '../src/driver/cli.ts';
import type {Callbacks} from '../src/driver/fs.ts';
import {parseProject} from '../src/driver/project.ts';
import type {CompileResult, OutputFile, OutputType} from '../src/libassembler.ts';
import {setJsEngine} from '../src/driver/js/engine.ts';
import {functionEngine} from '../src/driver/js/function.ts';
import {fakeFs} from './fakefs.ts';

/** An in-memory filesystem, so a session can be driven without argv or a real disk. */
function session(files: Record<string, string|Uint8Array> = {}) {
  const written = new Map<string, Uint8Array>();
  const callbacks: Callbacks = {
    fsReadString: (path, filename) => {
      const data = read(path, filename);
      return typeof data === 'string' ? data : new TextDecoder().decode(data);
    },
    fsReadBytes: (path, filename) => {
      const data = read(path, filename);
      return typeof data === 'string' ? new TextEncoder().encode(data) : data;
    },
    fsReadStdin: async () => {
      const data = read('', STDIN);
      return typeof data === 'string' ? new TextEncoder().encode(data) : data;
    },
    fsWriteString: async (path, filename, data) => {
      written.set(path ? `${path}/${filename}` : filename,
                  new TextEncoder().encode(data));
    },
    fsWriteBytes: async (path, filename, data) => {
      written.set(path ? `${path}/${filename}` : filename, data);
    },
    fsListDir: () => [],
    exit: () => {},
  };
  function read(path: string, filename: string): string|Uint8Array {
    // Deliberately not joinDir: it would normalize the `//stdin` pseudo-path away.
    const full = path ? `${path}/${filename}` : filename;
    const data = files[full];
    if (data === undefined) throw new Error(`no such file: ${full}`);
    return data;
  }
  return {session: new BuildSession(callbacks), written,
          text: (name: string) => new TextDecoder().decode(written.get(name))};
}

function output(name: string, type: OutputType, data = new Uint8Array([1])): OutputFile {
  return {name, type, data};
}

function result(...outputs: OutputFile[]): CompileResult {
  return {success: true, outputs, messages: []};
}

describe('BuildSession inputs', function() {
  it('reads a source file as an assembly input', async function() {
    const {session: s} = session({'main.s': 'lda #3\n'});
    expect(await s.readInput('main.s'))
        .toEqual({type: 'source', code: 'lda #3\n', name: 'main.s'});
  });

  it('strips a UTF-8 BOM', async function() {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x6c, 0x64, 0x61]);
    const {session: s} = session({'main.s': bom});
    const input = await s.readInput('main.s');
    expect(input).toEqual({type: 'source', code: 'lda', name: 'main.s'});
  });

  // An uncompressed .o is JSON, and feeding that to the tokenizer produces a pile of
  // nonsense errors instead of naming the real problem.
  it('rejects a JSON file that is not a gzipped object', async function() {
    const {session: s} = session({'main.o': '{"modules":[]}'});
    await expect(s.readInput('main.o'))
        .rejects.toThrow('main.o: not a valid object file');
  });
});

describe('BuildSession directory listing', function() {
  it('exposes the frontend listing as FileCallbacks.listDir', function() {
    const {callbacks} = fakeFs({'assets/a.png': 'x', 'assets/b.png': 'y'});
    const s = new BuildSession(callbacks);
    expect(s.fileCallbacks.listDir).toBeDefined();
    expect(s.fileCallbacks.listDir!('assets').sort()).toEqual(['a.png', 'b.png']);
  });

});

describe('BuildSession dependency tracking', function() {
  it('records every file read, in order, without duplicates', async function() {
    const {session: s} = session(
        {'main.s': 'a', 'inc/defs.inc': 'b', 'assets/tiles.chr': 'c'});
    await s.readInput('main.s');
    s.fileCallbacks.resolveText(['inc'], 'defs.inc');
    s.fileCallbacks.resolveBinary(['assets'], 'tiles.chr');
    // The same header included twice is still one prerequisite.
    s.fileCallbacks.resolveText(['inc'], 'defs.inc');
    expect(s.dependencies()).toEqual(['main.s', 'inc/defs.inc', 'assets/tiles.chr']);
  });

  it('leaves stdin out, since make cannot rebuild it', async function() {
    const {session: s} = session({[STDIN]: 'lda #3'});
    await s.readInput(STDIN);
    expect(s.dependencies()).toEqual([]);
  });

  it('writes the target and a phony rule for each prerequisite', async function() {
    const {session: s, text} = session({'main.s': 'a', 'my src/defs.inc': 'b'});
    await s.readInput('main.s');
    s.fileCallbacks.resolveText(['my src'], 'defs.inc');
    await s.writeDepFile('out.d', './out.nes');
    // Spaces have to be escaped for make, and the target is normalized first.
    expect(text('out.d')).toBe(
        'out.nes:\tmain.s my\\ src/defs.inc\n\nmain.s my\\ src/defs.inc:\n\n');
  });

  it('omits the phony rule when nothing was read', async function() {
    const {session: s, text} = session();
    await s.writeDepFile('out.d', 'out.nes');
    expect(text('out.d')).toBe('out.nes:\t\n\n');
  });
});

describe('BuildSession outputs', function() {
  it('writes the linked binary and the requested sidecars', async function() {
    const {session: s, written} = session();
    await s.writeOutputs(
        result(output('rom', 'binary'), output('dbg', 'debug'), output('m', 'map')),
        {outfile: 'out.nes', dbgfile: 'out.mlb', mapfile: 'out.map'});
    expect([...written.keys()].sort()).toEqual(['out.map', 'out.mlb', 'out.nes']);
  });

  it('leaves out sidecars that were not asked for', async function() {
    const {session: s, written} = session();
    await s.writeOutputs(
        result(output('rom', 'binary'), output('dbg', 'debug'), output('m', 'map')),
        {outfile: 'out.nes'});
    expect([...written.keys()]).toEqual(['out.nes']);
  });

  it('picks the object file as the primary output when there is no binary', async function() {
    const {session: s, written} = session();
    await s.writeOutputs(result(output('main.o', 'object', new Uint8Array([7]))),
                         {outfile: 'main.o'});
    expect(written.get('main.o')).toEqual(new Uint8Array([7]));
  });

  // A linker config names its own extra files, and those names can contain `%O`.
  it('substitutes %O in extra binary outputs', async function() {
    const {session: s, written} = session();
    await s.writeOutputs(
        result(output('rom', 'binary'), output('%O.chr', 'binary', new Uint8Array([9]))),
        {outfile: 'build/game.nes'});
    expect([...written.keys()]).toEqual(['build/game.nes', 'build/game.nes.chr']);
    expect(written.get('build/game.nes.chr')).toEqual(new Uint8Array([9]));
  });

  it('writes the dependency file only after the outputs', async function() {
    const {session: s, written, text} = session({'main.s': 'lda #3'});
    await s.readInput('main.s');
    await s.writeOutputs(result(output('rom', 'binary')),
                         {outfile: 'out.nes', depfile: 'out.d'});
    expect([...written.keys()]).toEqual(['out.nes', 'out.d']);
    expect(text('out.d')).toBe('out.nes:\tmain.s\n\nmain.s:\n\n');
  });
});

/** Build `js65.json` (plus whatever else is in `files`) and report what came out. */
async function runBuild(files: Record<string, string|Uint8Array>,
                        names: string[] = [], overrides: BuildOverrides = {}) {
  const {callbacks, written, text} = fakeFs(files);
  const lines: string[] = [];
  const config = parseProject(
      'js65.json', await callbacks.fsReadString('', 'js65.json'));
  const messages: string[] = [];
  const builder = new Builder(new BuildSession(callbacks), {
    log: line => lines.push(line),
    messages: msgs => { for (const m of msgs) messages.push(m.message); },
  });
  const result = await builder.build(config, selectProjects(config, names), overrides);
  return {result, written, text, lines, messages,
          files: [...written.keys()].sort()};
}

/** Two independent projects, each with sources of its own. */
const TWO_PROJECTS = {
  'js65.json': JSON.stringify({projects: [
    {name: 'game', sources: ['src/*.s'], target: 'sim'},
    {name: 'tools', sources: ['tools/*.s'], target: 'sim'},
  ]}),
  'src/a.s': 'lda #1\n',
  'src/b.s': 'lda #2\n',
  'tools/t.s': 'lda #3\n',
};

describe('selectProjects', function() {
  const config = parseProject('js65.json', TWO_PROJECTS['js65.json']);

  it('selects every project when none are named', function() {
    expect(selectProjects(config, []).map(p => p.name)).toEqual(['game', 'tools']);
  });

  it('selects the named projects, in the order they were named', function() {
    expect(selectProjects(config, ['tools', 'game']).map(p => p.name))
        .toEqual(['tools', 'game']);
  });

  // Silently building nothing is the worst possible answer to a typo'd name.
  it('rejects a name that is not in the file', function() {
    expect(() => selectProjects(config, ['gaem']))
        .toThrow(/no project named "gaem" in js65.json \(known projects: game, tools\)/);
  });
});

describe('Builder', function() {
  it('writes each project to its own output path', async function() {
    const {result, files} = await runBuild(TWO_PROJECTS);
    expect(result.success).toBe(true);
    expect(files).toEqual(['build/game.nes', 'build/tools.nes']);
    expect(result.projects.map(p => p.name)).toEqual(['game', 'tools']);
    expect(result.projects[0].bytes).toBeGreaterThan(0);
  });

  it('builds only the named project', async function() {
    const {files} = await runBuild(TWO_PROJECTS, ['tools']);
    expect(files).toEqual(['build/tools.nes']);
  });

  it('assembles every source a glob matched, in sorted order', async function() {
    // Both modules linked into one ROM: `lda #1` then `lda #2`.
    const {written} = await runBuild(TWO_PROJECTS, ['game']);
    expect([...written.get('build/game.nes')!].slice(0, 4))
        .toEqual([0xa9, 0x01, 0xa9, 0x02]);
  });

  it('reports progress and the output size', async function() {
    const {lines} = await runBuild(TWO_PROJECTS, ['game']);
    expect(lines[0]).toBe('js65: building 1 project from js65.json');
    expect(lines[1]).toMatch(/^\[1\/1\] game {2}ok {6}build\/game\.nes \(\d+ bytes\)$/);
  });

  // Unlike make, which stops at the first failed recipe.
  it('keeps going after a project fails, and reports the failure', async function() {
    const files = {...TWO_PROJECTS, 'src/b.s': 'lda #(\n'};
    const {result, files: written, lines, messages} = await runBuild(files);
    expect(result.success).toBe(false);
    expect(result.projects.map(p => p.success)).toEqual([false, true]);
    // The good project still built.
    expect(written).toEqual(['build/tools.nes']);
    expect(messages.length).toBeGreaterThan(0);
    expect(lines[1]).toMatch(/^\[1\/2\] game {3}FAILED {2}\d+ errors?$/);
    expect(lines.at(-1)).toBe('js65: 1 of 2 projects failed');
  });

  it('fails only the project whose source pattern matched nothing', async function() {
    const files = {...TWO_PROJECTS, 'js65.json': JSON.stringify({projects: [
      {name: 'game', sources: ['src/*.asm'], target: 'sim'},
      {name: 'tools', sources: ['tools/*.s'], target: 'sim'},
    ]})};
    const {result, messages, files: written} = await runBuild(files);
    expect(result.success).toBe(false);
    expect(messages[0]).toMatch(/game: no files matched source pattern "src\/\*\.asm"/);
    expect(written).toEqual(['build/tools.nes']);
  });

  it('fails the project when a source is missing rather than throwing', async function() {
    const files = {'js65.json': JSON.stringify({projects: [
      {name: 'game', sources: ['src/gone.s'], target: 'sim'},
    ]})};
    const {result, messages} = await runBuild(files);
    expect(result.success).toBe(false);
    expect(messages[0]).toMatch(/game: no such file: src\/gone\.s/);
  });

  describe('project settings', function() {
    it('honors outDir, output and the sidecar paths', async function() {
      const files = {
        'js65.json': JSON.stringify({outDir: 'out', projects: [{
          name: 'game', sources: ['src/a.s'], target: 'sim',
          output: 'game.prg', dbgfile: 'game.mlb', mapfile: 'game.map',
        }]}),
        'src/a.s': 'lda #1\n',
      };
      expect((await runBuild(files)).files)
          .toEqual(['out/game.map', 'out/game.mlb', 'out/game.prg']);
    });

    it('passes includePaths and binIncludePaths to the assembler', async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [{
          name: 'game', sources: ['src/a.s'], target: 'sim',
          includePaths: ['inc'], binIncludePaths: ['assets'],
        }]}),
        'src/a.s': '.include "defs.inc"\n.incbin "tiles.chr"\n',
        'inc/defs.inc': 'lda #1\n',
        'assets/tiles.chr': new Uint8Array([7, 8]),
      };
      const {result, written} = await runBuild(files);
      expect(result.success).toBe(true);
      expect([...written.get('build/game.nes')!].slice(0, 4)).toEqual([0xa9, 1, 7, 8]);
    });

    it('applies defines and features from the project file', async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [{
          name: 'game', sources: ['src/a.s'], target: 'sim',
          defines: {LEVEL: 4}, features: ['c_comments'],
        }]}),
        'src/a.s': '/* a c comment */\nlda #LEVEL\n',
      };
      const {result, written} = await runBuild(files);
      expect(result.success).toBe(true);
      expect([...written.get('build/game.nes')!].slice(0, 2)).toEqual([0xa9, 4]);
    });

    it('links with a linker config and writes its %O outputs', async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [{
          name: 'game', sources: ['src/a.s'], linkerConfig: 'nes.cfg',
        }]}),
        'src/a.s': '.segment "HEADER"\n.byte 1,2,3,4\n.segment "CODE"\nlda #3\n',
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
      const {result, written} = await runBuild(files);
      expect(result.success).toBe(true);
      expect([...written.get('build/game.nes')!]).toEqual([0xa9, 3, 0xff, 0xff]);
      expect([...written.get('build/game.nes_header')!]).toEqual([1, 2, 3, 4]);
    });

    it('reports a broken linker config against the project, not the run',
       async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [
          {name: 'game', sources: ['src/a.s'], linkerConfig: 'gone.cfg'},
          {name: 'tools', sources: ['tools/t.s'], target: 'sim'},
        ]}),
        'src/a.s': 'lda #1\n',
        'tools/t.s': 'lda #3\n',
      };
      const {result, messages, files: written} = await runBuild(files);
      expect(result.success).toBe(false);
      expect(messages[0]).toMatch(/game: no such file: gone\.cfg/);
      expect(written).toEqual(['build/tools.nes']);
    });

    it('produces an IPS patch for format "ips"', async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [{
          name: 'patch', sources: ['src/a.s'], target: 'sim',
          format: 'ips', baseRom: 'base.nes', output: 'patch.ips',
        }]}),
        'src/a.s': 'lda #3\n',
        'base.nes': new Uint8Array([0, 1, 2, 3]),
      };
      const {files: written, text} = await runBuild(files);
      expect(written).toEqual(['build/patch.ips']);
      expect(text('build/patch.ips').startsWith('PATCH')).toBe(true);
    });

    it('produces an object file for format "object"', async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [{
          name: 'lib', sources: ['src/a.s'], format: 'object', output: 'lib.o',
        }]}),
        'src/a.s': 'lda #3\n',
      };
      const {result, written} = await runBuild(files);
      expect(result.success).toBe(true);
      // A serialized module is gzipped, so it starts with the gzip magic.
      expect([...written.get('build/lib.o')!].slice(0, 2)).toEqual([0x1f, 0x8b]);
    });

    it('turns debug info off for debug: -1', async function() {
      const withDebug = {
        'js65.json': JSON.stringify({projects: [{
          name: 'game', sources: ['src/a.s'], target: 'sim', dbgfile: 'game.mlb',
        }]}),
        'src/a.s': 'label: lda #1\n',
      };
      const off = {...withDebug, 'js65.json': JSON.stringify({projects: [{
        name: 'game', sources: ['src/a.s'], target: 'sim', dbgfile: 'game.mlb',
        debug: -1,
      }]})};
      expect((await runBuild(withDebug)).files).toContain('build/game.mlb');
      expect((await runBuild(off)).files).not.toContain('build/game.mlb');
    });
  });

  describe('overrides', function() {
    it('lets -D beat a define of the same name in the file', async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [{
          name: 'game', sources: ['src/a.s'], target: 'sim', defines: {LEVEL: 4},
        }]}),
        'src/a.s': 'lda #LEVEL\n',
      };
      const {written} = await runBuild(files, [], {defines: [{name: 'LEVEL', value: '9'}]});
      expect([...written.get('build/game.nes')!].slice(0, 2)).toEqual([0xa9, 9]);
    });

    it('sends the output somewhere else', async function() {
      const {files} = await runBuild(TWO_PROJECTS, ['game'], {outfile: 'other/rom.nes'});
      expect(files).toEqual(['other/rom.nes']);
    });

    it('writes a dependency file listing only that project\'s inputs',
       async function() {
      const {text} = await runBuild(TWO_PROJECTS, ['game'], {depfile: 'game.d'});
      expect(text('game.d')).toBe(
          'build/game.nes:\tsrc/a.s src/b.s\n\nsrc/a.s src/b.s:\n\n');
    });

    // The dep list is per project; carrying one project's sources into the next would
    // make every dep file after the first wrong.
    it('does not carry one project\'s dependencies into the next', async function() {
      const {text} = await runBuild(TWO_PROJECTS, ['game', 'tools'],
                                    {depfile: 'out.d'});
      expect(text('out.d')).toBe(
          'build/tools.nes:\ttools/t.s\n\ntools/t.s:\n\n');
    });

    it('turns lints off for every selected project', async function() {
      const files = {
        'js65.json': JSON.stringify({projects: [{
          name: 'game', sources: ['src/a.s'], target: 'sim',
        }]}),
        // A jmp to the very next instruction: the jmp-fallthrough lint fires here.
        'src/a.s': 'jmp next\nnext:\n  lda #1\n',
      };
      expect((await runBuild(files)).messages.length).toBeGreaterThan(0);
      expect((await runBuild(files, [], {lint: {enabled: false}})).messages).toEqual([]);
    });

    it('honors the project file\'s own lint block', async function() {
      const files = {
        'js65.json': JSON.stringify({
          projects: [{name: 'game', sources: ['src/a.s'], target: 'sim'}],
          lint: {enabled: false},
        }),
        'src/a.s': 'jmp next\nnext:\n  lda #1\n',
      };
      expect((await runBuild(files)).messages).toEqual([]);
    });
  });
});

describe('js65 build', function() {
  /** Run the CLI over an in-memory tree, capturing its exit code and its output. */
  async function run(files: Record<string, string|Uint8Array>, args: string[]) {
    const {callbacks, written} = fakeFs(files);
    const lines: string[] = [];
    let exitCode = 0;
    const log = console.log;
    console.log = (...parts: unknown[]) => { lines.push(...parts.join(' ').split('\n')); };
    try {
      await new Cli({...callbacks, exit: code => { exitCode = code; }}).run(args);
    } finally {
      console.log = log;
    }
    return {exitCode, written, lines, out: lines.join('\n'),
            files: [...written.keys()].sort()};
  }

  it('builds every project in ./js65.json', async function() {
    const {exitCode, files} = await run(TWO_PROJECTS, ['build']);
    expect(exitCode).toBe(0);
    expect(files).toEqual(['build/game.nes', 'build/tools.nes']);
  });

  it('builds only the projects named on the command line', async function() {
    expect((await run(TWO_PROJECTS, ['build', 'tools'])).files)
        .toEqual(['build/tools.nes']);
  });

  it('reads another project file with -p', async function() {
    const files = {...TWO_PROJECTS, 'alt/js65.json': JSON.stringify({projects: [
      {name: 'alt', sources: ['src/a.s'], target: 'sim'},
    ]}), 'alt/src/a.s': 'lda #1\n'};
    expect((await run(files, ['build', '-p', 'alt/js65.json'])).files)
        .toEqual(['alt/build/alt.nes']);
  });

  it('exits 1 when a project fails', async function() {
    const files = {...TWO_PROJECTS, 'src/b.s': 'lda #(\n'};
    const {exitCode, files: written} = await run(files, ['build']);
    expect(exitCode).toBe(1);
    expect(written).toEqual(['build/tools.nes']);
  });

  it('exits 1 when the project file cannot be read', async function() {
    const {exitCode, out} = await run({}, ['build']);
    expect(exitCode).toBe(1);
    expect(out).toContain('no such file: js65.json');
  });

  it('exits 8 for a project name that is not in the file', async function() {
    const {exitCode, out} = await run(TWO_PROJECTS, ['build', 'nope']);
    expect(exitCode).toBe(8);
    expect(out).toContain('no project named "nope"');
  });

  // Two projects writing through one -o would clobber each other.
  it('exits 8 when a single-output flag meets several projects', async function() {
    const {exitCode, out} = await run(TWO_PROJECTS, ['build', '-o', 'rom.nes']);
    expect(exitCode).toBe(8);
    expect(out).toContain('-o names a single file, but 2 projects are selected');
  });

  it('accepts a single-output flag when one project is selected', async function() {
    const {exitCode, files} =
        await run(TWO_PROJECTS, ['build', '-o', 'rom.nes', 'game']);
    expect(exitCode).toBe(0);
    expect(files).toEqual(['rom.nes']);
  });

  it('exits 8 for an option that only makes sense for a single assembly',
     async function() {
    for (const flag of [['-c'], ['--ips'], ['--stdin'], ['-C', 'nes.cfg'],
                        ['-t', 'sim'], ['-r', 'base.nes']]) {
      const {exitCode, out} = await run(TWO_PROJECTS, ['build', ...flag]);
      expect(exitCode).toBe(8);
      expect(out).toContain('cannot be used with `js65 build`');
    }
  });

  it('does not mistake an option value for an option', async function() {
    // `-p` takes the next argument, so the `-c` here is this file's name, not a flag.
    const {exitCode} = await run({'-c': JSON.stringify({projects: []})},
                                 ['build', '-p', '-c']);
    expect(exitCode).toBe(0);
  });

  it('passes -D and -I through to every selected project', async function() {
    const files = {
      'js65.json': JSON.stringify({projects: [
        {name: 'a', sources: ['a/a.s'], target: 'sim'},
        {name: 'b', sources: ['b/b.s'], target: 'sim'},
      ]}),
      'a/a.s': '.include "defs.inc"\nlda #LEVEL\n',
      'b/b.s': '.include "defs.inc"\nlda #LEVEL\n',
      'inc/defs.inc': '; nothing to declare\n',
    };
    const {exitCode, written} =
        await run(files, ['build', '-D', 'LEVEL=7', '-I', 'inc']);
    expect(exitCode).toBe(0);
    expect([...written.get('build/a.nes')!].slice(0, 2)).toEqual([0xa9, 7]);
    expect([...written.get('build/b.nes')!].slice(0, 2)).toEqual([0xa9, 7]);
  });

  it('prints build usage for `build --help` without building', async function() {
    const {exitCode, out, files} = await run(TWO_PROJECTS, ['build', '--help']);
    expect(exitCode).toBe(0);
    expect(out).toContain('Usage: js65 build [options] [PROJECT...]');
    expect(files).toEqual([]);
  });

  it('rejects -p on the plain assembler path', async function() {
    const {exitCode, out} = await run(TWO_PROJECTS, ['-p', 'js65.json', 'src/a.s']);
    expect(exitCode).toBe(8);
    expect(out).toContain('-p/--project only applies to `js65 build`');
  });
});

describe('BuildSession source cache', function() {
  it('returns a line by its 1-based number, whatever the line endings', async function() {
    const {session: s} = session({'main.s': 'one\r\ntwo\rthree\nfour'});
    await s.readInput('main.s');
    expect(s.sourceLine('main.s', 1)).toBe('one');
    expect(s.sourceLine('main.s', 2)).toBe('two');
    expect(s.sourceLine('main.s', 3)).toBe('three');
    expect(s.sourceLine('main.s', 4)).toBe('four');
  });

  it('has nothing for a file it never read, or a line past the end', async function() {
    const {session: s} = session({'main.s': 'lda #3\n'});
    expect(s.sourceLine('other.s', 1)).toBeUndefined();
    await s.readInput('main.s');
    expect(s.sourceLine('main.s', 9)).toBeUndefined();
  });

  it('picks up the new text when a file is read again', async function() {
    const files: Record<string, string> = {'main.s': 'first\n'};
    const {session: s} = session(files);
    await s.readInput('main.s');
    expect(s.sourceLine('main.s', 1)).toBe('first');
    files['main.s'] = 'second\n';
    await s.readInput('main.s');
    expect(s.sourceLine('main.s', 1)).toBe('second');
  });
});

describe('JavaScript blocks in a build', function() {
  // Only the frontend entry points register an engine, so a test has to do it too.
  beforeAll(() => setJsEngine(functionEngine));
  afterAll(() => setJsEngine(undefined));

  const PROJECT = JSON.stringify({projects: [{
    name: 'game', sources: ['src/a.s'], target: 'sim', allowJavascript: true,
  }]});

  it('puts the bytes a block emitted into the linked output', async function() {
    const files = {
      'js65.json': PROJECT,
      'src/a.s': [
        '.segment "CODE"',
        '.jsbegin',
        '  a.byte([0x11, 0x22]);',
        '.jsend',
        '  lda #3',
      ].join('\n'),
    };
    const {written, result} = await runBuild(files);
    expect(result.success).toBe(true);
    expect([...written.get('build/game.nes')!].slice(0, 4))
        .toEqual([0x11, 0x22, 0xa9, 3]);
  });

  it('resolves a label a block defined from ordinary assembly', async function() {
    const files = {
      'js65.json': PROJECT,
      'src/a.s': [
        '.segment "CODE"',
        '.jsbegin',
        '  a.label("gen");',
        '  a.byte(0x42);',
        '.jsend',
        '  lda gen',
      ].join('\n'),
    };
    const {written, result} = await runBuild(files);
    expect(result.success).toBe(true);
    expect([...written.get('build/game.nes')!].slice(0, 2)).toEqual([0x42, 0xad]);
  });

  it('reads assets through .jsinput and lists them as dependencies', async function() {
    const files = {
      'js65.json': PROJECT,
      'src/a.s': [
        '.jsinclude "enc.js"',
        '.jsinput tiles, "assets/*.bin"',
        '.segment "CODE"',
        '.jsbegin',
        '  a.byte(tiles.map(t => encode(t.bytes[0])));',
        '.jsend',
      ].join('\n'),
      'src/enc.js': 'function encode(b) { return b ^ 0xff; }',
      'assets/a.bin': '\x01',
      'assets/b.bin': '\x02',
    };
    const {written, text, result} = await runBuild(files, [], {depfile: 'game.d'});
    expect(result.success).toBe(true);
    expect([...written.get('build/game.nes')!].slice(0, 2)).toEqual([0xfe, 0xfd]);
    // Touching any asset or helper has to trigger a rebuild, so all of them
    // belong in the dep file alongside the source.
    const dep = text('game.d');
    for (const path of ['src/a.s', 'src/enc.js', 'assets/a.bin', 'assets/b.bin']) {
      expect(dep).toContain(path);
    }
  });

  it('passes -D values into the block as defines', async function() {
    const files = {
      'js65.json': PROJECT,
      'src/a.s': '.segment "CODE"\n.jsbegin\na.byte(defines.LEVEL);\n.jsend\n',
    };
    const {written} = await runBuild(files, [], {defines: [{name: 'LEVEL', value: '7'}]});
    expect([...written.get('build/game.nes')!].slice(0, 1)).toEqual([7]);
  });

  it('reports a block error against its line in the source file', async function() {
    const files = {
      'js65.json': PROJECT,
      'src/a.s': '.segment "CODE"\n\n.jsbegin\nthrow new Error("boom");\n.jsend\n',
    };
    const {messages} = await runBuild(files);
    expect(messages.join('\n')).toContain('boom');
  });

  it('leaves a file with no block completely alone', async function() {
    const files = {'js65.json': PROJECT, 'src/a.s': 'lda #3\n'};
    const {written, result, messages} = await runBuild(files);
    expect(result.success).toBe(true);
    expect(messages).toEqual([]);
    expect([...written.get('build/game.nes')!].slice(0, 2)).toEqual([0xa9, 3]);
  });
});

describe('the --allow-javascript gate in a build', function() {
  beforeAll(() => setJsEngine(functionEngine));
  afterAll(() => setJsEngine(undefined));

  const BLOCK = '.segment "CODE"\n.jsbegin\n  a.byte(1);\n.jsend\n';

  function project(extra: Record<string, unknown> = {}) {
    return JSON.stringify({projects: [{
      name: 'game', sources: ['src/a.s'], target: 'sim', ...extra,
    }]});
  }

  it('fails with a message naming the flag when nothing opted in', async function() {
    const {result, messages} = await runBuild(
        {'js65.json': project(), 'src/a.s': BLOCK});
    expect(result.success).toBe(false);
    expect(messages.join('\n')).toContain('--allow-javascript');
    expect(messages.join('\n')).toContain('arbitrary code at build time');
  });

  it('builds when js65.json sets allowJavascript', async function() {
    const {result, written} = await runBuild(
        {'js65.json': project({allowJavascript: true}), 'src/a.s': BLOCK});
    expect(result.success).toBe(true);
    expect([...written.get('build/game.nes')!].slice(0, 1)).toEqual([1]);
  });

  it('builds when the flag is passed, whatever the project file says',
     async function() {
    const {result} = await runBuild(
        {'js65.json': project(), 'src/a.s': BLOCK}, [], {allowJavascript: true});
    expect(result.success).toBe(true);
  });

  it('rejects a non-boolean allowJavascript in js65.json', function() {
    expect(() => parseProject('js65.json', project({allowJavascript: 'yes'})))
        .toThrow(/allowJavascript must be a boolean/);
  });
});
