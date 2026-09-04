// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect, beforeAll, afterAll} from 'bun:test';
import {setJsEngine} from '../src/driver/js/engine.ts';
import {functionEngine} from '../src/driver/js/function.ts';
import {bunCodec} from '../src/driver/codec/bun.ts';
import {JS_MODULES} from '../src/jsmodule/index.ts';
import {jsPreprocess, type JsPreprocessOptions} from '../src/jspreprocessor.ts';
import type {FileCallbacks} from '../src/libassembler.ts';
import {JsActionTable} from '../src/options.ts';
import type {SourceInfo} from '../src/error.ts';

// Every test here needs an engine; nothing else in the suite registers one.
beforeAll(() => setJsEngine(functionEngine));
afterAll(() => setJsEngine(undefined));

/** In-memory `FileCallbacks` over a literal tree, with listing for globs. */
function callbacks(files: Record<string, string> = {}, canList = true): FileCallbacks {
  const join = (base: string, name: string) =>
      !base || base === '.' ? name : `${base}/${name}`;
  const listDir = (dir: string): string[] => {
    const prefix = !dir || dir === '.' ? '' : `${dir}/`;
    const entries = new Set<string>();
    for (const full of Object.keys(files)) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.substring(prefix.length);
      const slash = rest.indexOf('/');
      entries.add(slash < 0 ? rest : `${rest.substring(0, slash)}/`);
    }
    if (prefix.length && !entries.size) throw new Error(`no such directory: ${dir}`);
    return [...entries];
  };
  return {
    resolveText: (bases, name) => {
      for (let i = 0; i < bases.length; i++) {
        const found = files[join(bases[i], name)];
        if (found !== undefined) return {baseIndex: i, content: found};
      }
      return undefined;
    },
    resolveBinary: (bases, name) => {
      for (let i = 0; i < bases.length; i++) {
        const found = files[join(bases[i], name)];
        if (found !== undefined) {
          return {baseIndex: i, content: new TextEncoder().encode(found)};
        }
      }
      return undefined;
    },
    listDir: canList ? listDir : undefined,
  };
}

function run(code: string, files: Record<string, string> = {},
             extra: Partial<JsPreprocessOptions> = {}) {
  const jsActions = new JsActionTable();
  const result = jsPreprocess(code, 'main.s', {
    jsActions, allowJavascript: true, callbacks: callbacks(files),
    includePaths: ['.'], ...extra,
  });
  return {...result, jsActions};
}

describe('jsPreprocess with no JavaScript in the file', function() {
  it('hands back the source untouched', function() {
    const code = '.segment "CODE"\n  lda #3\n';
    const result = run(code);
    expect(result.code).toBe(code);
    expect(result.usedJavascript).toBe(false);
  });

  // A file with no block must not need an engine, or every ordinary build on a
  // frontend without eval would fail.
  it('does not need a JavaScript engine', function() {
    setJsEngine(undefined);
    try {
      expect(run('  lda #3\n').usedJavascript).toBe(false);
    } finally {
      setJsEngine(functionEngine);
    }
  });
});

describe('jsPreprocess block replacement', function() {
  it('replaces the block with a marker and keeps every later line number', function() {
    const result = run([
      '.segment "CODE"',   // 1
      '.jsbegin',          // 2
      '  a.byte([1, 2]);', // 3
      '  a.byte(3);',      // 4
      '.jsend',            // 5
      '  lda #3',          // 6
    ].join('\n'));
    const lines = result.code.split('\n');
    expect(lines[1]).toBe('.jsactions 0');
    expect(lines.slice(2, 5)).toEqual(['', '', '']);
    expect(lines[5]).toBe('  lda #3');
    expect(lines.length).toBe(6);
  });

  it('collects the actions the block emitted', function() {
    const result = run('.jsbegin\na.byte([1, 2]).label("gen");\n.jsend\n');
    expect(result.jsActions.get(0)).toEqual([
      {action: 'byte', bytes: [1, 2], source: {file: 'main.s', line: 1}},
      {action: 'label', label: 'gen', source: {file: 'main.s', line: 1}},
    ]);
  });

  it('numbers multiple blocks in the order they appear', function() {
    const result = run([
      '.jsbegin', 'a.byte(1);', '.jsend',
      '.jsbegin', 'a.byte(2);', '.jsend',
    ].join('\n'));
    const lines = result.code.split('\n');
    expect(lines[0]).toBe('.jsactions 0');
    expect(lines[3]).toBe('.jsactions 1');
    expect(result.jsActions.get(1)![0]).toMatchObject({action: 'byte', bytes: [2]});
  });

  it('shares no state between two blocks in one file', function() {
    expect(() => run('.jsbegin\nconst x = 1;\n.jsend\n.jsbegin\na.byte(x);\n.jsend\n'))
        .toThrow(/x is not defined/);
  });
});

describe('jsPreprocess debug attribution', function() {
  it('attributes every action to the .jsbegin line by default', function() {
    const result = run('\n\n.jsbegin\na.byte(1);\na.byte(2);\n.jsend\n');
    for (const action of result.jsActions.get(0)!) {
      expect(action.source).toEqual({file: 'main.s', line: 3});
    }
  });

  it('lets a.at(n) move attribution to an offset within the block', function() {
    const result = run('.jsbegin\na.at(2).byte(1);\na.byte(2);\n.jsend\n');
    const actions = result.jsActions.get(0)!;
    expect(actions[0].source).toEqual({file: 'main.s', line: 3});
    // `at` is sticky, so the following byte stays on the same line.
    expect(actions[1].source).toEqual({file: 'main.s', line: 3});
  });
});

describe('.jsinclude', function() {
  it('makes a helper from the included file callable in the block', function() {
    const files = {'lib/nes.js': 'function two() { return [2, 2]; }'};
    const result = run('.jsinclude "lib/nes.js"\n.jsbegin\na.byte(two());\n.jsend\n', files);
    expect(result.jsActions.get(0)![0]).toMatchObject({action: 'byte', bytes: [2, 2]});
  });

  it('blanks the declaration so the tokenizer never sees it', function() {
    const files = {'lib/nes.js': ''};
    const result = run('.jsinclude "lib/nes.js"\n.jsbegin\n.jsend\n', files);
    expect(result.code.split('\n')[0]).toBe('');
  });

  it('concatenates several includes in declared order', function() {
    const files = {'a.js': 'const v = 1;', 'b.js': 'const w = v + 1;'};
    const result = run(
        '.jsinclude "a.js"\n.jsinclude "b.js"\n.jsbegin\na.byte(w);\n.jsend\n', files);
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [2]});
  });

  it('reports a missing include file', function() {
    expect(() => run('.jsinclude "nope.js"\n.jsbegin\n.jsend\n'))
        .toThrow(/Could not find .jsinclude file: nope.js/);
  });
});

describe('.jsmodule', function() {
  it('binds the module name for the block to call', function() {
    const result = run('.jsmodule bmp\n.jsbegin\na.byte(bmp.load ? 1 : 0);\n.jsend\n');
    expect(result.jsActions.get(0)![0]).toMatchObject({action: 'byte', bytes: [1]});
  });

  it('blanks the declaration so the tokenizer never sees it', function() {
    const result = run('.jsmodule bmp\n.jsbegin\n.jsend\n');
    expect(result.code.split('\n')[0]).toBe('');
  });

  it('loads a module even with no block in the file', function() {
    const result = run('.jsmodule bmp\nlda #3\n');
    expect(result.usedJavascript).toBe(true);
    expect(result.code.split('\n')).toEqual(['', 'lda #3', '']);
  });

  it('deduplicates a repeated module instead of emitting a second const', function() {
    const result = run(
        '.jsmodule bmp\n.jsmodule bmp\n.jsbegin\na.byte(bmp.load ? 4 : 0);\n.jsend\n');
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [4]});
    expect(result.code.split('\n').slice(0, 2)).toEqual(['', '']);
  });

  it('comes before .jsinclude, so an include can build on it', function() {
    const files = {'lib/on-top.js': 'const four = bmp.load ? 4 : 0;'};
    const result = run(
        '.jsinclude "lib/on-top.js"\n.jsmodule bmp\n.jsbegin\na.byte(four);\n.jsend\n',
        files);
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [4]});
  });

  it('gives a png block the frontend deflate, so encode works end to end', function() {
    // The module is bundled on its own, so the deflate can only arrive through the scope.
    const result = run(
        '.jsmodule png\n.jsbegin\n' +
        'const p = [[0, 0, 0], [255, 0, 0]];\n' +
        'const b = png.encode({width: 2, height: 1, pixels: new Uint8Array([1, 0]), palette: p});\n' +
        'a.byte([...png.load(b).pixels]);\n.jsend\n');
    expect(result.jsActions.get(0)![0]).toMatchObject({action: 'byte', bytes: [1, 0]});
  });

  it('reports an unknown module and lists the known ones', function() {
    expect(() => run('.jsmodule nope\n.jsbegin\n.jsend\n'))
        .toThrow(/Unknown \.jsmodule: nope[\s\S]*Known modules: bmp, png/);
  });

  it('rejects a quoted name, since it is an identifier not a path', function() {
    expect(() => run('.jsmodule "bmp"\n')).toThrow(/Expected \.jsmodule <name>/);
  });

  it('rejects a bare .jsmodule with no name', function() {
    expect(() => run('.jsmodule\n')).toThrow(/Expected \.jsmodule <name>, got: \(nothing\)/);
  });
});

describe('.jsinput', function() {
  const assets = {'assets/b.bin': 'BB', 'assets/a.bin': 'AA', 'assets/notes.txt': 'x'};

  it('binds a glob to a sorted array, even when it matches one file', function() {
    const one = {'assets/only.bin': 'Z'};
    const result = run(
        '.jsinput tiles, "assets/*.bin"\n.jsbegin\na.byte(tiles.length);\n.jsend\n', one);
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [1]});
  });

  it('binds each match with its path, bytes, and text', function() {
    const result = run(
        '.jsinput tiles, "assets/*.bin"\n' +
        '.jsbegin\na.byte(tiles.map(t => t.bytes[0]));\n' +
        'a.label(tiles.map(t => t.path).join("|"));\n.jsend\n', assets);
    const actions = result.jsActions.get(0)!;
    expect(actions[0]).toMatchObject({bytes: [0x41, 0x42]});
    expect(actions[1]).toMatchObject({label: 'assets/a.bin|assets/b.bin'});
  });

  it('binds a literal path to a single object, not an array', function() {
    const result = run(
        '.jsinput font, "assets/a.bin"\n.jsbegin\na.label(font.text);\n.jsend\n', assets);
    expect(result.jsActions.get(0)![0]).toMatchObject({label: 'AA'});
  });

  it('reports a literal path that does not exist', function() {
    expect(() => run('.jsinput font, "assets/missing.bin"\n.jsbegin\n.jsend\n', assets))
        .toThrow(/Could not find .jsinput file: assets\/missing.bin/);
  });

  it('binds an empty array when a glob matches nothing', function() {
    const result = run(
        '.jsinput tiles, "assets/*.chr"\n.jsbegin\na.byte(tiles.length);\n.jsend\n', assets);
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [0]});
  });

  it('errors on a glob when the frontend cannot list directories', function() {
    const jsActions = new JsActionTable();
    expect(() => jsPreprocess(
        '.jsinput tiles, "assets/*.bin"\n.jsbegin\n.jsend\n', 'main.s',
        {jsActions, allowJavascript: true, callbacks: callbacks(assets, false),
         includePaths: ['.']}))
        .toThrow(/no directory listing callback/);
  });

  it('rejects a declaration that is missing its name', function() {
    expect(() => run('.jsinput "assets/a.bin"\n.jsbegin\n.jsend\n', assets))
        .toThrow(/Expected .jsinput <name>, "<path>"/);
  });
});

describe('the defines binding', function() {
  it('exposes -D values, numeric where they parse', function() {
    const result = run('.jsbegin\na.byte(defines.LEVEL);\n.jsend\n', {},
                       {defines: [{name: 'LEVEL', value: '4'}]});
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [4]});
  });

  it('keeps a non-numeric value as a string', function() {
    const result = run('.jsbegin\na.label(defines.NAME);\n.jsend\n', {},
                       {defines: [{name: 'NAME', value: 'game'}]});
    expect(result.jsActions.get(0)![0]).toMatchObject({label: 'game'});
  });
});

describe('jsPreprocess rejections', function() {
  // A declaration resolves before any block runs, so an .if around it could never
  // gate it; saying so beats silently binding it either way.
  for (const [open, close] of [['.if 1', '.endif'], ['.macro m', '.endmacro'],
                               ['.proc p', '.endproc'], ['.repeat 2', '.endrepeat']]) {
    it(`rejects a declaration inside ${open.split(' ')[0]}`, function() {
      expect(() => run(`${open}\n.jsinput t, "a.bin"\n${close}\n`))
          .toThrow(/cannot appear inside/);
    });

    it(`rejects a .jsmodule inside ${open.split(' ')[0]}`, function() {
      expect(() => run(`${open}\n.jsmodule bmp\n${close}\n`))
          .toThrow(/cannot appear inside/);
    });
  }

  it('allows a declaration after a conditional has closed', function() {
    const result = run('.if 1\n.endif\n.jsinput t, "a.bin"\n', {'a.bin': 'x'});
    expect(result.code.split('\n')[2]).toBe('');
  });

  it('reports the line of the offending declaration', function() {
    let source;
    try {
      run('\n.if 1\n\n.jsinput t, "a.bin"\n.endif\n');
    } catch (err) {
      source = (err as {source?: {file: string, line: number}}).source;
    }
    expect(source).toMatchObject({file: 'main.s', line: 4});
  });

  it('rejects a .jsbegin with no .jsend', function() {
    expect(() => run('.jsbegin\na.byte(1);\n')).toThrow(/without a matching .jsend/);
  });

  it('rejects a .jsend with no .jsbegin', function() {
    expect(() => run('.jsend\n')).toThrow(/without a matching .jsbegin/);
  });

  it('rejects a nested .jsbegin', function() {
    expect(() => run('.jsbegin\n.jsbegin\n.jsend\n')).toThrow(/inside a block/);
  });

  /** The `source` chain a failed block reports, innermost first. */
  function errorSource(code: string, files: Record<string, string> = {}) {
    try {
      run(code, files);
    } catch (err) {
      return (err as {source?: SourceInfo}).source;
    }
    throw new Error('expected the block to fail');
  }

  it('reports a runtime error against the line that threw', function() {
    expect(errorSource('\n\n.jsbegin\na.byte(1);\nthrow new Error("boom");\n.jsend\n'))
        .toMatchObject({file: 'main.s', line: 5, parent: {line: 3}});
  });

  it('walks the frames back to the throwing line inside a block function', function() {
    const source = errorSource(
        '.jsbegin\nfunction f() {\n  throw new Error("boom");\n}\nf();\n.jsend\n');
    expect(source).toMatchObject({file: 'main.s', line: 3});
    expect(source!.parent).toMatchObject({file: 'main.s', line: 5, parent: {line: 1}});
  });

  it('maps a frame in a .jsinclude back to that file', function() {
    const source = errorSource(
        '.jsinclude "lib.js"\n.jsbegin\nboom();\n.jsend\n',
        {'lib.js': '// helper\nfunction boom() {\n  throw new Error("nope");\n}\n'});
    expect(source).toMatchObject({file: 'lib.js', line: 3});
    expect(source!.parent).toMatchObject({file: 'main.s', line: 3});
  });

  it('anchors a throw inside a .jsmodule at the block, not the bundled module', function() {
    // `<jsmodule bmp>` is no file an editor can open, so the diagnostic has to
    // land on the caller; the module frame stays in the stack.
    const source = errorSource(
        '.jsmodule bmp\n.jsbegin\nbmp.load(new Uint8Array([1, 2, 3]));\n.jsend\n');
    expect(source).toMatchObject({file: 'main.s', line: 3});
    expect(source!.parent).toMatchObject({file: 'main.s', line: 2});
  });

  it('remaps the error stack into source coordinates', function() {
    try {
      run('.jsbegin\nthrow new Error("boom");\n.jsend\n');
    } catch (err) {
      expect((err as Error).stack).toContain('main.s:2:');
      return;
    }
    throw new Error('expected the block to fail');
  });

  it('reports the block error message', function() {
    expect(() => run('.jsbegin\nthrow new Error("boom");\n.jsend\n'))
        .toThrow(/JavaScript block failed: boom/);
  });

  it('reports when the frontend registered no engine', function() {
    setJsEngine(undefined);
    try {
      expect(() => run('.jsbegin\n.jsend\n')).toThrow(/no JavaScript engine/);
    } finally {
      setJsEngine(functionEngine);
    }
  });
});

describe('jsPreprocess scanning', function() {
  it('ignores a marker that is not the first thing on its line', function() {
    const code = '  lda #3 ; .jsbegin\n';
    expect(run(code).code).toBe(code);
  });

  it('accepts an indented block marker', function() {
    const result = run('  .jsbegin\n  a.byte(1);\n  .jsend\n');
    expect(result.code.split('\n')[0]).toBe('.jsactions 0');
  });

  it('is case insensitive on the directive', function() {
    const result = run('.JSBEGIN\na.byte(1);\n.JSEND\n');
    expect(result.code.split('\n')[0]).toBe('.jsactions 0');
  });
});

describe('the --allow-javascript gate', function() {
  /** Same as `run`, but leaving the flag off the way a default build does. */
  function denied(code: string, files: Record<string, string> = {}) {
    return jsPreprocess(code, 'main.s',
        {jsActions: new JsActionTable(), callbacks: callbacks(files), includePaths: ['.']});
  }

  it('rejects a block, naming the flag', function() {
    expect(() => denied('.jsbegin\na.byte(1);\n.jsend\n'))
        .toThrow(/\.jsbegin requires --allow-javascript/);
  });

  it('explains why it is off by default', function() {
    expect(() => denied('.jsbegin\n.jsend\n'))
        .toThrow(/execute arbitrary code at build time/);
  });

  it('rejects a bare .jsinclude, even with no block', function() {
    expect(() => denied('.jsinclude "lib/nes.js"\n', {'lib/nes.js': ''}))
        .toThrow(/\.jsinclude requires --allow-javascript/);
  });

  it('rejects a bare .jsinput, even with no block', function() {
    expect(() => denied('.jsinput t, "a.bin"\n', {'a.bin': 'x'}))
        .toThrow(/\.jsinput requires --allow-javascript/);
  });

  it('rejects a bare .jsmodule, even with no block', function() {
    expect(() => denied('.jsmodule bmp\n'))
        .toThrow(/\.jsmodule requires --allow-javascript/);
  });

  // The gate is about running JS at all, so it outranks whether the name resolves.
  it('reports the gate, not the unknown name, for an unknown module', function() {
    expect(() => denied('.jsmodule nope\n'))
        .toThrow(/\.jsmodule requires --allow-javascript/);
  });

  it('reports the earliest .js construct in the file', function() {
    let source;
    try {
      denied('\n.jsinput t, "a.bin"\n.jsbegin\n.jsend\n', {'a.bin': 'x'});
    } catch (err) {
      source = (err as {source?: {line: number}}).source;
    }
    expect(source).toMatchObject({line: 2});
  });

  // The whole point of the flag is that a denied build reads nothing and runs
  // nothing, so refusing has to come before any callback fires.
  it('reads no file and runs no code when it refuses', function() {
    let reads = 0;
    const cb = callbacks({'lib/nes.js': 'throw new Error("ran");'});
    const watched: FileCallbacks = {
      ...cb,
      resolveText: (bases, name) => { reads++; return cb.resolveText(bases, name); },
      resolveBinary: (bases, name) => { reads++; return cb.resolveBinary(bases, name); },
    };
    expect(() => jsPreprocess(
        '.jsinclude "lib/nes.js"\n.jsbegin\nthrow new Error("ran");\n.jsend\n', 'main.s',
        {jsActions: new JsActionTable(), callbacks: watched, includePaths: ['.']}))
        .toThrow(/--allow-javascript/);
    expect(reads).toBe(0);
  });

  it('leaves a file with no JavaScript alone, flag or not', function() {
    const code = '.segment "CODE"\n  lda #3\n';
    expect(denied(code).code).toBe(code);
  });

  it('reports how many blocks ran once allowed', function() {
    const result = run('.jsbegin\na.byte(1);\n.jsend\n.jsbegin\na.byte(2);\n.jsend\n');
    expect(result.blocks).toBe(2);
  });
});

describe('a block inside a conditional', function() {
  // The block always runs at stage 0, but the marker it leaves is an ordinary
  // directive, so the assembler decides whether those bytes are emitted.
  for (const [open, close] of [['.if 1', '.endif'], ['.macro m', '.endmacro'],
                               ['.proc p', '.endproc'], ['.repeat 2', '.endrepeat']]) {
    it(`is allowed inside ${open.split(' ')[0]}`, function() {
      const result = run(`${open}\n.jsbegin\na.byte(1);\n.jsend\n${close}\n`);
      expect(result.code.split('\n')[1]).toBe('.jsactions 0');
      expect(result.blocks).toBe(1);
    });
  }

  it('leaves the marker where the assembler can skip it', function() {
    const result = run('.if 0\n.jsbegin\na.byte(1);\n.jsend\n.endif\n');
    const lines = result.code.split('\n');
    expect(lines[0]).toBe('.if 0');
    expect(lines[1]).toBe('.jsactions 0');
    expect(lines[4]).toBe('.endif');
  });
});

// -----
// The `bmp` module. Its tests live here rather than in their own file so that every
// .jsmodule behaviour, plumbing and payload alike, stays in one place.

type Rgb = [number, number, number];

interface BmpApi {
  load(bytes: Uint8Array, opts?: {palette?: Rgb[], exact?: boolean}):
      {width: number, height: number, pixels: Uint8Array, palette: Rgb[]};
  loadRgba(bytes: Uint8Array): {width: number, height: number, data: Uint8Array};
  encode(image: unknown, opts?: {bits?: number, palette?: Rgb[]}): Uint8Array;
  lib: {decode: unknown, encode: unknown};
}

/**
 * Evaluates the module text the way the prelude does. The `.jsmodule` describe above
 * covers the directive itself; these tests are about what the module does once bound.
 */
function loadModule(): BmpApi {
  const out: BmpApi[] = [];
  new Function('out', `"use strict";\n${JS_MODULES.get('bmp')}\nout.push(bmp);`)(out);
  return out[0];
}

const bmp = loadModule();

// -----
// Fixtures are built here rather than checked in: a hand-written header is the only way
// to assert on exact palette indices, and it keeps binary assets out of the repo.

function u16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function u32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

/**
 * An indexed BMP at 1, 4 or 8 bits. `rows` is top-down, one palette index per pixel;
 * the rows are written bottom-up, which is what an ordinary BMP does.
 */
function indexedBmp(bits: 1 | 4 | 8, palette: Rgb[], rows: number[][]): Uint8Array {
  const height = rows.length, width = rows[0].length;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const perByte = 8 / bits;
  const pixels: number[] = [];
  for (let y = height - 1; y >= 0; y--) {
    const row = new Array(stride).fill(0);
    rows[y].forEach((idx, x) => {
      const shift = 8 - bits - (x % perByte) * bits;
      row[Math.floor(x / perByte)] |= (idx & ((1 << bits) - 1)) << shift;
    });
    pixels.push(...row);
  }
  const table = palette.flatMap(([r, g, b]) => [b, g, r, 0]);
  const offset = 14 + 40 + table.length;
  return new Uint8Array([
    0x42, 0x4d, ...u32(offset + pixels.length), ...u16(0), ...u16(0), ...u32(offset),
    ...u32(40), ...u32(width), ...u32(height), ...u16(1), ...u16(bits),
    ...u32(0), ...u32(pixels.length), ...u32(2835), ...u32(2835),
    ...u32(palette.length), ...u32(0),
    ...table, ...pixels,
  ]);
}

/** A 24-bit truecolor BMP, rows given top-down as [r, g, b] triples. */
function truecolorBmp(rows: Rgb[][]): Uint8Array {
  const height = rows.length, width = rows[0].length;
  const stride = Math.ceil((width * 3) / 4) * 4;
  const pixels: number[] = [];
  for (let y = height - 1; y >= 0; y--) {
    const row = new Array(stride).fill(0);
    rows[y].forEach(([r, g, b], x) => {
      row[x * 3] = b;
      row[x * 3 + 1] = g;
      row[x * 3 + 2] = r;
    });
    pixels.push(...row);
  }
  const offset = 14 + 40;
  return new Uint8Array([
    0x42, 0x4d, ...u32(offset + pixels.length), ...u16(0), ...u16(0), ...u32(offset),
    ...u32(40), ...u32(width), ...u32(height), ...u16(1), ...u16(24),
    ...u32(0), ...u32(pixels.length), ...u32(2835), ...u32(2835), ...u32(0), ...u32(0),
  ].concat(pixels));
}

const RED: Rgb = [0xff, 0, 0];
const GREEN: Rgb = [0, 0xff, 0];
const BLUE: Rgb = [0, 0, 0xff];
const BLACK: Rgb = [0, 0, 0];

describe('bmp.load on an indexed source', function() {
  it('reads 1-bit indices straight out of the file', function() {
    const image = indexedBmp(1, [BLACK, RED], [[0, 1, 1, 0], [1, 0, 0, 1]]);
    const out = bmp.load(image);
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    expect(Array.from(out.pixels)).toEqual([0, 1, 1, 0, 1, 0, 0, 1]);
    expect(out.palette).toEqual([BLACK, RED]);
  });

  it('reads 4-bit indices, including ones past the low nibble', function() {
    const palette: Rgb[] = [BLACK, RED, GREEN, BLUE, [1, 1, 1], [2, 2, 2]];
    const out = bmp.load(indexedBmp(4, palette, [[0, 5, 3, 1, 2]]));
    expect(Array.from(out.pixels)).toEqual([0, 5, 3, 1, 2]);
    expect(out.palette).toEqual(palette);
  });

  it('reads 8-bit indices', function() {
    const palette: Rgb[] = Array.from({length: 200}, (_, i) => [i, 0, 0]);
    const out = bmp.load(indexedBmp(8, palette, [[0, 199, 7], [42, 42, 1]]));
    expect(Array.from(out.pixels)).toEqual([0, 199, 7, 42, 42, 1]);
  });

  // The whole reason indices are read at the source: neither of these survives a
  // round trip through RGBA and back.
  it('keeps distinct indices that share a color', function() {
    const out = bmp.load(indexedBmp(4, [RED, RED, RED], [[0, 1, 2]]));
    expect(Array.from(out.pixels)).toEqual([0, 1, 2]);
  });

  it('preserves index order as authored rather than by first appearance', function() {
    const out = bmp.load(indexedBmp(4, [BLUE, GREEN, RED], [[2, 2, 0]]));
    expect(Array.from(out.pixels)).toEqual([2, 2, 0]);
    expect(out.palette[0]).toEqual(BLUE);
  });

  // An 8-bit RLE stream can end a row early, leaving pixels with no index at all.
  // Upstream paints those white; claiming they are palette entry 0 would be a lie.
  it('refuses an RLE image that leaves a pixel undefined', function() {
    const table = [0, 0, 0, 0, 0, 0, 0xff, 0]; // black, then red
    const rle = [0x02, 0x01, 0x00, 0x00, 0x02, 0x01, 0x00, 0x01]; // row of 2, EOL, row, EOF
    const offset = 14 + 40 + table.length;
    const image = new Uint8Array([
      0x42, 0x4d, ...u32(offset + rle.length), ...u16(0), ...u16(0), ...u32(offset),
      ...u32(40), ...u32(3), ...u32(2), ...u16(1), ...u16(8),
      ...u32(1), ...u32(rle.length), ...u32(2835), ...u32(2835), ...u32(2), ...u32(0),
      ...table, ...rle,
    ]);
    expect(() => bmp.load(image)).toThrow(/leaves the pixel at \(2, \d\) undefined/);
  });

  it('needs no palette option, and ignores one that is passed', function() {
    const out = bmp.load(indexedBmp(1, [BLACK, RED], [[1, 0]]), {palette: [GREEN]});
    expect(Array.from(out.pixels)).toEqual([1, 0]);
    expect(out.palette).toEqual([BLACK, RED]);
  });
});

describe('bmp.load on a truecolor source', function() {
  const image = truecolorBmp([[RED, GREEN], [BLUE, RED]]);

  it('maps each pixel through a supplied palette', function() {
    const out = bmp.load(image, {palette: [GREEN, BLUE, RED]});
    expect(Array.from(out.pixels)).toEqual([2, 0, 1, 2]);
    expect(out.palette).toEqual([GREEN, BLUE, RED]);
  });

  it('throws without a palette, since it carries none of its own', function() {
    expect(() => bmp.load(image)).toThrow(/24-bit image with no palette of its own/);
  });

  it('names the color and its coordinate when it is not in the palette', function() {
    expect(() => bmp.load(image, {palette: [RED, GREEN]}))
        .toThrow(/rgb\(0, 0, 255\) at \(0, 1\)/);
  });

  it('takes the nearest match when exact is off', function() {
    // Blue is unmapped; a dark blue is much closer to it than red or green.
    const out = bmp.load(image, {palette: [RED, GREEN, [0, 0, 0xc0]], exact: false});
    expect(Array.from(out.pixels)).toEqual([0, 1, 2, 0]);
  });

  it('breaks a nearest-match tie toward the lower index', function() {
    const out = bmp.load(image, {palette: [RED, GREEN], exact: false});
    expect(Array.from(out.pixels)).toEqual([0, 1, 0, 0]);
  });

  it('picks the lowest index when a color appears twice in the palette', function() {
    const out = bmp.load(image, {palette: [RED, GREEN, BLUE, RED]});
    expect(Array.from(out.pixels)).toEqual([0, 1, 2, 0]);
  });

  it('rejects a malformed palette entry', function() {
    expect(() => bmp.load(image, {palette: [[1, 2] as unknown as Rgb]}))
        .toThrow(/not an \[r, g, b\] triple/);
  });

  it('rejects a channel outside 0-255', function() {
    expect(() => bmp.load(image, {palette: [[0, 0, 300]]}))
        .toThrow(/channel outside 0-255/);
  });
});

describe('bmp.loadRgba', function() {
  it('hands back straight RGBA in row-major order', function() {
    const out = bmp.loadRgba(truecolorBmp([[RED, GREEN]]));
    expect(out.width).toBe(2);
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('expands an indexed source through its own palette', function() {
    const out = bmp.loadRgba(indexedBmp(1, [BLACK, RED], [[1, 0]]));
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255, 0, 0, 0, 255]);
  });
});

describe('bmp.encode', function() {
  it('round trips an indexed image back to the same indices', function() {
    const palette: Rgb[] = [BLACK, RED, GREEN, BLUE];
    const rows = [[0, 1, 2, 3], [3, 2, 1, 0]];
    const encoded = bmp.encode(
        {width: 4, height: 2, pixels: new Uint8Array(rows.flat()), palette}, {bits: 8});
    const out = bmp.load(encoded);
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    expect(Array.from(out.pixels)).toEqual(rows.flat());
  });

  it('round trips at 4 bits', function() {
    const palette: Rgb[] = [BLACK, RED, GREEN, BLUE];
    const encoded = bmp.encode(
        {width: 3, height: 1, pixels: new Uint8Array([3, 0, 2]), palette}, {bits: 4});
    expect(Array.from(bmp.load(encoded).pixels)).toEqual([3, 0, 2]);
  });

  it('round trips an RGBA image at 24 bits', function() {
    const source = bmp.loadRgba(truecolorBmp([[RED, GREEN], [BLUE, BLACK]]));
    const out = bmp.loadRgba(bmp.encode(source));
    expect(Array.from(out.data)).toEqual(Array.from(source.data));
  });

  it('rejects an index the palette does not reach', function() {
    expect(() => bmp.encode(
        {width: 2, height: 1, pixels: new Uint8Array([0, 9]), palette: [RED, GREEN]}))
        .toThrow(/index 9, outside a palette of 2/);
  });

  it('needs no deflate, so it works wherever the module loads', function() {
    // BMP carries no compression, unlike PNG: this is the whole reason bmp lands first.
    expect(bmp.encode({width: 1, height: 1, pixels: new Uint8Array([0]), palette: [RED]}))
        .toBeInstanceOf(Uint8Array);
  });
});

// -----
// png

interface PngApi {
  load(bytes: Uint8Array, opts?: {palette?: Rgb[], exact?: boolean}):
      {width: number, height: number, pixels: Uint8Array, palette: Rgb[]};
  loadRgba(bytes: Uint8Array): {width: number, height: number, data: Uint8Array};
  encode(image: unknown, opts?: {palette?: Rgb[], colors?: number}): Uint8Array;
  upng: {decode: unknown, encode: unknown};
}

/**
 * Same as loadModule, plus the deflate binding jsPreprocess injects for png.encode.
 * Takes the deflate positionally, not defaulted, so passing undefined really does bind
 * undefined and exercises the frontend-without-a-deflate path.
 */
function loadPng(deflate: unknown): PngApi {
  const out: PngApi[] = [];
  new Function('out', '__js65_deflate',
               `"use strict";\n${JS_MODULES.get('png')}\nout.push(png);`)(out, deflate);
  return out[0];
}

const png = loadPng(bunCodec.deflate);

function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: length, type, body, CRC. */
function chunk(type: string, body: number[]): number[] {
  const bytes = [...type].map(c => c.charCodeAt(0)).concat(body);
  return [...be32(body.length), ...bytes, ...be32(crc32(bytes))];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** An indexed PNG at 1, 2, 4 or 8 bits, rows top-down as palette indices. */
function indexedPng(bits: 1 | 2 | 4 | 8, palette: Rgb[], rows: number[][]): Uint8Array {
  const height = rows.length, width = rows[0].length;
  const bpl = Math.ceil((width * bits) / 8);
  const perByte = 8 / bits;
  const raw = new Uint8Array((bpl + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (bpl + 1);
    raw[off] = 0;
    rows[y].forEach((idx, x) => {
      const shift = 8 - bits - (x % perByte) * bits;
      raw[off + 1 + Math.floor(x / perByte)] |= idx << shift;
    });
  }
  const ihdr = [...be32(width), ...be32(height), bits, 3, 0, 0, 0];
  return new Uint8Array([
    ...PNG_SIGNATURE,
    ...chunk('IHDR', ihdr),
    ...chunk('PLTE', palette.flat()),
    ...chunk('IDAT', Array.from(bunCodec.deflate!(raw))),
    ...chunk('IEND', []),
  ]);
}

/** A truecolor PNG, rows given top-down as [r, g, b] triples. */
function truecolorPng(rows: Rgb[][]): Uint8Array {
  const height = rows.length, width = rows[0].length;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (width * 3 + 1);
    rows[y].forEach(([r, g, b], x) => {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    });
  }
  return new Uint8Array([
    ...PNG_SIGNATURE,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', Array.from(bunCodec.deflate!(raw))),
    ...chunk('IEND', []),
  ]);
}

describe('png.load on an indexed source', function() {
  it('reads 1-bit indices straight out of the file', function() {
    const out = png.load(indexedPng(1, [BLACK, RED], [[0, 1, 1, 0], [1, 0, 0, 1]]));
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    expect(Array.from(out.pixels)).toEqual([0, 1, 1, 0, 1, 0, 0, 1]);
    expect(out.palette).toEqual([BLACK, RED]);
  });

  it('reads 2-bit indices', function() {
    const palette = [BLACK, RED, GREEN, BLUE];
    const out = png.load(indexedPng(2, palette, [[0, 1, 2, 3], [3, 2, 1, 0]]));
    expect(Array.from(out.pixels)).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
    expect(out.palette).toEqual(palette);
  });

  it('reads 4-bit indices', function() {
    const palette = [BLACK, RED, GREEN, BLUE];
    const out = png.load(indexedPng(4, palette, [[3, 0, 2]]));
    expect(Array.from(out.pixels)).toEqual([3, 0, 2]);
  });

  it('reads 8-bit indices', function() {
    const palette = [BLACK, RED, GREEN, BLUE];
    const out = png.load(indexedPng(8, palette, [[2, 3], [1, 0]]));
    expect(Array.from(out.pixels)).toEqual([2, 3, 1, 0]);
  });

  // A row is padded to a byte boundary, so an odd width is where a stride bug shows up.
  it('handles a width that does not fill the last byte of a row', function() {
    const out = png.load(indexedPng(1, [BLACK, RED], [[1, 0, 1], [0, 1, 1]]));
    expect(out.width).toBe(3);
    expect(Array.from(out.pixels)).toEqual([1, 0, 1, 0, 1, 1]);
  });

  it('keeps duplicate palette entries distinct, which an RGBA round trip cannot', function() {
    const out = png.load(indexedPng(2, [BLACK, RED, RED, BLUE], [[0, 1, 2, 3]]));
    expect(Array.from(out.pixels)).toEqual([0, 1, 2, 3]);
    expect(out.palette).toEqual([BLACK, RED, RED, BLUE]);
  });

  it('needs no palette, since the file carries its own', function() {
    expect(() => png.load(indexedPng(1, [BLACK, RED], [[0, 1]]))).not.toThrow();
  });
});

describe('png.load on a truecolor source', function() {
  it('maps each pixel through the supplied palette', function() {
    const out = png.load(truecolorPng([[RED, GREEN], [BLUE, BLACK]]),
                         {palette: [BLACK, RED, GREEN, BLUE]});
    expect(Array.from(out.pixels)).toEqual([1, 2, 3, 0]);
    expect(out.palette).toEqual([BLACK, RED, GREEN, BLUE]);
  });

  it('throws naming the color and its coordinate when it is not in the palette', function() {
    expect(() => png.load(truecolorPng([[RED, GREEN]]), {palette: [BLACK, RED]}))
        .toThrow(/color rgb\(0, 255, 0\) at \(1, 0\) is not in the palette/);
  });

  it('takes the nearest match when exact is off', function() {
    const almost: Rgb = [0xfe, 0, 0];
    const out = png.load(truecolorPng([[almost]]), {palette: [BLUE, RED], exact: false});
    expect(Array.from(out.pixels)).toEqual([1]);
  });

  it('throws when there is no palette to map against', function() {
    expect(() => png.load(truecolorPng([[RED]]))).toThrow(/\.load needs one/);
  });
});

describe('png.loadRgba', function() {
  it('hands back straight RGBA in row-major order', function() {
    const out = png.loadRgba(truecolorPng([[RED, GREEN]]));
    expect(out.width).toBe(2);
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('expands an indexed source through its own palette', function() {
    const out = png.loadRgba(indexedPng(1, [BLACK, RED], [[1, 0]]));
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255, 0, 0, 0, 255]);
  });
});

describe('png.encode', function() {
  it('round trips an indexed image back to the same indices', function() {
    const palette: Rgb[] = [BLACK, RED, GREEN, BLUE];
    const rows = [[0, 1, 2, 3], [3, 2, 1, 0]];
    const encoded = png.encode(
        {width: 4, height: 2, pixels: new Uint8Array(rows.flat()), palette});
    const out = png.load(encoded);
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    expect(Array.from(out.pixels)).toEqual(rows.flat());
    expect(out.palette).toEqual(palette);
  });

  // UPNG.encode quantizes from RGBA, which would reorder these and merge the duplicate.
  it('writes the palette as given, duplicates and order intact', function() {
    const palette: Rgb[] = [BLUE, RED, RED, BLACK];
    const out = png.load(png.encode(
        {width: 4, height: 1, pixels: new Uint8Array([3, 2, 1, 0]), palette}));
    expect(out.palette).toEqual(palette);
    expect(Array.from(out.pixels)).toEqual([3, 2, 1, 0]);
  });

  it('round trips an RGBA image losslessly', function() {
    const source = png.loadRgba(truecolorPng([[RED, GREEN], [BLUE, BLACK]]));
    const out = png.loadRgba(png.encode(source));
    expect(Array.from(out.data)).toEqual(Array.from(source.data));
  });

  it('rejects an index the palette does not reach', function() {
    expect(() => png.encode(
        {width: 2, height: 1, pixels: new Uint8Array([0, 9]), palette: [RED, GREEN]}))
        .toThrow(/index 9, outside a palette of 2/);
  });

  it('gives a clear error when the frontend registered no deflate', function() {
    const noDeflate = loadPng(undefined);
    const source = noDeflate.loadRgba(truecolorPng([[RED, GREEN], [BLUE, BLACK]]));
    expect(() => noDeflate.encode(source))
        .toThrow(/this frontend registered no deflate/);
  });

  it('still decodes when the frontend registered no deflate', function() {
    // UPNG bundles its own inflate, so only the encode path needs the codec.
    const noDeflate = loadPng(undefined);
    expect(Array.from(noDeflate.load(indexedPng(1, [BLACK, RED], [[1, 0]])).pixels))
        .toEqual([1, 0]);
  });
});
