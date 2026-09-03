// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect, beforeAll, afterAll} from 'bun:test';
import {setJsEngine} from '../src/driver/js/engine.ts';
import {functionEngine} from '../src/driver/js/function.ts';
import {jsPreprocess, type JsPreprocessOptions} from '../src/jspreprocessor.ts';
import type {FileCallbacks} from '../src/libassembler.ts';
import {JsActionTable} from '../src/options.ts';

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
    const result = run('.jsmodule sample\n.jsbegin\na.byte(sample.double(3));\n.jsend\n');
    expect(result.jsActions.get(0)![0]).toMatchObject({action: 'byte', bytes: [6]});
  });

  it('blanks the declaration so the tokenizer never sees it', function() {
    const result = run('.jsmodule sample\n.jsbegin\n.jsend\n');
    expect(result.code.split('\n')[0]).toBe('');
  });

  it('loads a module even with no block in the file', function() {
    const result = run('.jsmodule sample\nlda #3\n');
    expect(result.usedJavascript).toBe(true);
    expect(result.code.split('\n')).toEqual(['', 'lda #3', '']);
  });

  it('deduplicates a repeated module instead of emitting a second const', function() {
    const result = run(
        '.jsmodule sample\n.jsmodule sample\n.jsbegin\na.byte(sample.double(2));\n.jsend\n');
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [4]});
    expect(result.code.split('\n').slice(0, 2)).toEqual(['', '']);
  });

  it('comes before .jsinclude, so an include can build on it', function() {
    const files = {'lib/on-top.js': 'const four = sample.double(2);'};
    const result = run(
        '.jsinclude "lib/on-top.js"\n.jsmodule sample\n.jsbegin\na.byte(four);\n.jsend\n',
        files);
    expect(result.jsActions.get(0)![0]).toMatchObject({bytes: [4]});
  });

  it('reports an unknown module and lists the known ones', function() {
    expect(() => run('.jsmodule nope\n.jsbegin\n.jsend\n'))
        .toThrow(/Unknown \.jsmodule: nope[\s\S]*Known modules: sample/);
  });

  it('rejects a quoted name, since it is an identifier not a path', function() {
    expect(() => run('.jsmodule "sample"\n')).toThrow(/Expected \.jsmodule <name>/);
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
      expect(() => run(`${open}\n.jsmodule sample\n${close}\n`))
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

  it('reports a runtime error against the .jsbegin line', function() {
    let source;
    try {
      run('\n\n.jsbegin\nthrow new Error("boom");\n.jsend\n');
    } catch (err) {
      source = (err as {source?: {line: number}}).source;
    }
    expect(source).toMatchObject({line: 3});
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
    expect(() => denied('.jsmodule sample\n'))
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
