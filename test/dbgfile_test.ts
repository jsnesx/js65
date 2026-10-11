// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {
  parseDbg, checkDbgSyntax, normalizeDbg, DbgError, type DbgSym,
} from './dbgparse.ts';
import {
  assemble, compile, deserializeObjectFile, findOutput, serializeObjectFile,
} from '../src/libassembler.ts';
import type {Module} from '../src/module.ts';

const T = (...fields: string[]) => fields.join('\t');

const GOOD = [
  T('version', 'major=2,minor=0'),
  T('info', 'csym=1,file=2,lib=0,line=3,mod=1,scope=2,seg=1,span=2,sym=3,type=1'),
  T('csym', 'id=0,name="main",scope=1,type=0,sc=ext,sym=1'),
  T('file', 'id=0,name="main.s",size=40,mtime=0x00000000,mod=0'),
  T('file', 'id=1,name="a.inc",size=10,mtime=0x6C1A2B3C,mod=0'),
  T('line', 'id=0,file=0,line=1,span=0'),
  T('line', 'id=1,file=0,line=2,type=2,count=1,span=0+1'),
  T('line', 'id=2,file=1,line=7'),
  T('mod', 'id=0,name="main.o",file=0'),
  T('seg', 'id=0,name="CODE",start=0x008000,size=0x0003,addrsize=absolute,type=ro,oname="out.nes",ooffs=16'),
  T('span', 'id=0,seg=0,start=0,size=2'),
  T('span', 'id=1,seg=0,start=2,size=1,type=0'),
  T('scope', 'id=0,name="",mod=0,size=3,span=0+1'),
  T('scope', 'id=1,name="main",mod=0,type=scope,size=2,parent=0,sym=1,span=0'),
  T('sym', 'id=0,name="@loop",addrsize=absolute,parent=1,def=0,val=0x8001,seg=0,type=lab'),
  T('sym', 'id=1,name="main",addrsize=absolute,size=2,scope=0,def=0,ref=1+2,val=0x8000,seg=0,type=lab'),
  T('sym', 'id=2,name="puts",addrsize=absolute,scope=0,ref=1,type=imp'),
  T('type', 'id=0,val="00"'),
  '',
].join('\n');

describe('dbg reader', () => {
  it('parses every record kind', () => {
    const m = parseDbg(GOOD);
    expect(m.major).toBe(2);
    expect(m.segs[0]).toMatchObject({name: 'CODE', start: 0x8000, ooffs: 16});
    expect(m.files[1].mtime).toBe(0x6C1A2B3C);
    expect(m.lines[1]).toMatchObject({type: 2, count: 1, spans: [0, 1]});
    expect(m.scopes[1]).toMatchObject({type: 'scope', parent: 0, sym: 1});
    expect(m.syms[0]).toMatchObject({parent: 1, kind: 'lab', val: 0x8001});
    expect(m.syms[2].kind).toBe('imp');
    expect(m.csyms[0]).toMatchObject({sc: 'ext', sym: 1});
  });

  it('accepts CRLF', () => {
    expect(() => parseDbg(GOOD.replace(/\n/g, '\r\n'))).not.toThrow();
  });

  it('keeps commas inside strings', () => {
    const m = parseDbg(GOOD.replace('"main.s"', '"a,b.s"'));
    expect(m.files[0].name).toBe('a,b.s');
  });

  it('rejects a missing version', () => {
    expect(() => parseDbg(GOOD.split('\n').slice(1).join('\n'))).toThrow(DbgError);
  });

  it('rejects an id gap', () => {
    expect(() => parseDbg(GOOD.replace('id=1,name="a.inc"', 'id=2,name="a.inc"')))
        .toThrow(/dense/);
  });

  it('rejects a missing required attribute', () => {
    expect(() => parseDbg(GOOD.replace('size=40,', ''))).toThrow(/required/);
  });

  it('rejects a dangling reference', () => {
    expect(() => parseDbg(GOOD.replace('seg=0,start=0,size=2', 'seg=5,start=0,size=2')))
        .toThrow(/out of range/);
  });

  it('rejects a sym with both scope and parent', () => {
    expect(() => parseDbg(GOOD.replace('scope=0,def=0,ref=1+2', 'scope=0,parent=0,def=0')))
        .toThrow(/exactly one/);
  });

  it('rejects a sym with neither scope nor parent', () => {
    expect(() => parseDbg(GOOD.replace('parent=1,def=0', 'def=0'))).toThrow(/exactly one/);
  });

  it('rejects an auto csym with a sym', () => {
    expect(() => parseDbg(GOOD.replace('sc=ext,sym=1', 'sc=auto,sym=1')))
        .toThrow(/auto/);
  });

  it('rejects scopes without a root', () => {
    expect(() => parseDbg(GOOD.replace(',size=3,span=0+1', ',parent=1'))).toThrow();
  });
});

describe('dbg syntax check', () => {
  it('passes a well formed file', () => {
    expect(checkDbgSyntax(GOOD)).toEqual([]);
  });

  it('flags attributes out of order', () => {
    const bad = GOOD.replace('id=0,name="main.o",file=0', 'name="main.o",id=0,file=0');
    expect(checkDbgSyntax(bad).length).toBeGreaterThan(0);
  });

  it('flags records out of order', () => {
    const lines = GOOD.split('\n');
    const swapped = [lines[0], lines[3], lines[1], ...lines.slice(2, 3), ...lines.slice(4)];
    expect(checkDbgSyntax(swapped.join('\n')).join()).toMatch(/out of order/);
  });

  it('flags number formats', () => {
    expect(checkDbgSyntax(GOOD.replace('start=0x008000', 'start=0x8000'))).not.toEqual([]);
    expect(checkDbgSyntax(GOOD.replace('val=0x8000', 'val=0x08000'))).not.toEqual([]);
    expect(checkDbgSyntax(GOOD.replace('val=0x8000', 'val=0x8abc'))).not.toEqual([]);
    expect(checkDbgSyntax(GOOD.replace('mtime=0x6C1A2B3C', 'mtime=0x1'))).not.toEqual([]);
    expect(checkDbgSyntax(GOOD.replace('size=0x0003', 'size=3'))).not.toEqual([]);
  });

  it('flags a defaulted attribute that was written', () => {
    expect(checkDbgSyntax(GOOD.replace('line=1,span=0', 'line=1,type=0,span=0'))).not.toEqual([]);
  });

  it('flags CR characters', () => {
    expect(checkDbgSyntax(GOOD.replace(/\n/g, '\r\n')).join()).toMatch(/CR/);
  });
});

describe('dbg normalizer', () => {
  it('is stable and free of ids and mtime', () => {
    const text = normalizeDbg(parseDbg(GOOD));
    expect(normalizeDbg(parseDbg(GOOD))).toBe(text);
    expect(text).not.toMatch(/mtime|id=/);
    expect(text).toContain('sym\tmain.o|::main');
    expect(text).toContain('sym\tmain.o|main::@loop'.replace('main::@loop', '::main/::@loop'));
  });

  it('ignores id order', () => {
    const swapped = GOOD
        .replace('id=0,name="main.s"', 'id=X,name="main.s"')
        .replace('id=1,name="a.inc"', 'id=0,name="a.inc"')
        .replace('id=X,name="main.s"', 'id=1,name="main.s"')
        .replace('line	id=0,file=0', 'line	id=0,file=1')
        .replace('line	id=1,file=0', 'line	id=1,file=1')
        .replace('line	id=2,file=1', 'line	id=2,file=0')
        .replace('id=0,name="main.o",file=0', 'id=0,name="main.o",file=1');
    expect(normalizeDbg(parseDbg(swapped))).toBe(normalizeDbg(parseDbg(GOOD)));
  });

  it('drops placement unless asked to keep it', () => {
    const moved = GOOD.replace('start=0x008000', 'start=0x00C000')
                      .replace('val=0x8000', 'val=0xC000');
    const a = parseDbg(GOOD), b = parseDbg(moved);
    expect(normalizeDbg(b)).toBe(normalizeDbg(a));
    expect(normalizeDbg(b, {placement: true}))
        .not.toBe(normalizeDbg(a, {placement: true}));
  });
});

describe('module debug tables', () => {
  function build(code: string, debug = true) {
    const r = assemble([{type: 'source', code, name: 'a.s'}],
                       {generateDebugInfo: debug});
    expect(r.messages.filter(m => m.level === 'error')).toEqual([]);
    return r.modules[0];
  }
  const lineOf = (m: Module, id: number) => m.debug!.lines[id];
  const symNamed = (m: Module, name: string) =>
      m.debug!.syms.find(s => s.name === name)!;

  it('is absent without debug info', () => {
    const m = build('nop\n', false);
    expect(m.debug).toBeUndefined();
    expect(m.chunks![0].debugRuns).toBeUndefined();
  });

  it('describes scopes, procs and cheap locals', () => {
    const m = build([
      '.segment "CODE"',
      '.scope outer',
      '.proc inner',
      '  lda #1',
      '@loop: dex',
      '  bne @loop',
      '  rts',
      '.endproc',
      '.endscope',
    ].join('\n'));
    const d = m.debug!;
    expect(d.scopes.map(s => [s.name, s.type, s.parent, s.size])).toEqual([
      ['', undefined, undefined, 6],
      ['outer', 'scope', 0, 6],
      ['inner', 'scope', 1, 6],
    ]);
    expect(d.scopes[2].label).toBe(d.syms.indexOf(symNamed(m, 'inner')));
    expect(symNamed(m, 'inner')).toMatchObject({scope: 1, size: 6, kind: 'lab'});
    const loop = symNamed(m, '@loop');
    expect(loop.scope).toBeUndefined();
    expect(loop.parent).toBe(d.syms.indexOf(symNamed(m, 'inner')));
  });

  it('gives struct and enum scopes a type and no bytes', () => {
    const m = build([
      '.struct S', '  fld .byte', '.endstruct',
      '.enum E', '  first', '  second', '.endenum',
    ].join('\n'));
    const d = m.debug!;
    expect(d.scopes.map(s => [s.name, s.type, s.size, s.runs.length])).toEqual([
      ['', undefined, 0, 0],
      ['S', 'struct', 1, 0],
      ['E', 'enum', 0, 0],
    ]);
    expect(symNamed(m, 'fld')).toMatchObject({scope: 1, kind: 'equ', addrsize: 'zeropage', size: 1});
  });

  it('names unnamed scopes like ca65', () => {
    const m = build('.scope\nnop\n.endscope\n.scope\nnop\n.endscope\n');
    expect(m.debug!.scopes.map(s => s.name))
        .toEqual(['', '$anon-SCOPE-0001', '$anon-SCOPE-0002']);
  });

  it('types data directive spans and leaves others untyped', () => {
    const m = build([
      '.segment "CODE"',
      '  .byte 1,2,3', '  .word 1,2', '  .dbyt 3', '  .faraddr 4',
      '  .dword 5', '  .res 2', '  nop',
    ].join('\n'));
    const d = m.debug!;
    const runs = m.chunks![0].debugRuns!;
    expect(runs.map(r => [r[1], r[2], r[3] < 0 ? '' : d.types[r[3]]])).toEqual([
      [0, 3, '800320'], [3, 4, '800221'], [7, 2, '800151'],
      [9, 3, '80014200'], [12, 4, ''], [16, 2, ''], [18, 1, ''],
    ]);
  });

  it('encodes a large array count little endian', () => {
    const m = build('.segment "CODE"\n.byte ' + Array(300).fill('0').join(',') + '\n');
    expect(m.debug!.types).toEqual(['812C0120']);
  });

  it('puts a macro body line at depth 1 beside the call line', () => {
    const m = build([
      '.segment "CODE"',
      '.macro m',
      '  nop',
      '.endmacro',
      'm',
    ].join('\n'));
    const d = m.debug!;
    const run = m.chunks![0].debugRuns![0];
    const set = d.lineSets[run[0]].map(id => lineOf(m, id));
    expect(set).toContainEqual({file: 0, line: 3, type: 2, count: 1});
    expect(set).toContainEqual({file: 0, line: 5, type: 0, count: 0});
    expect(set.length).toBe(2);
  });

  it('counts nested macro depth', () => {
    const m = build([
      '.segment "CODE"',
      '.macro inner', '  nop', '.endmacro',
      '.macro outer', '  inner', '.endmacro',
      'outer',
    ].join('\n'));
    const set = m.debug!.lineSets[m.chunks![0].debugRuns![0][0]]
        .map(id => lineOf(m, id))
        .sort((a, b) => a.count - b.count);
    expect(set.map(l => [l.line, l.type, l.count])).toEqual([[8, 0, 0], [6, 2, 1], [3, 2, 2]]);
  });

  it('counts .repeat depth beside the .endrepeat line', () => {
    const m = build('.segment "CODE"\n.repeat 2\n  nop\n.endrepeat\n');
    const set = m.debug!.lineSets[m.chunks![0].debugRuns![0][0]];
    expect(set.map(id => lineOf(m, id))).toEqual([
      {file: 0, line: 3, type: 0, count: 1}, {file: 0, line: 4, type: 0, count: 0},
    ]);
    expect(m.chunks![0].debugRuns!.map(r => r.slice(0, 3))).toEqual([[0, 0, 1], [0, 1, 1]]);
  });

  it('records imports, exports and def/ref lines', () => {
    const m = build([
      '.import ext', '.importzp zpext', '.export pub',
      '.segment "CODE"',
      'pub: jsr ext', '  lda zpext', 'CONST = 5',
    ].join('\n'));
    expect(symNamed(m, 'ext')).toMatchObject({kind: 'imp', addrsize: 'absolute'});
    expect(symNamed(m, 'zpext')).toMatchObject({kind: 'imp', addrsize: 'zeropage'});
    const pub = symNamed(m, 'pub');
    expect(pub).toMatchObject({kind: 'lab', export: true});
    expect(pub.defs!.map(id => lineOf(m, id).line)).toEqual([5]);
    expect(symNamed(m, 'CONST')).toMatchObject({kind: 'equ', addrsize: 'zeropage'});
    expect(symNamed(m, 'ext').refs!.map(id => lineOf(m, id).line)).toEqual([5]);
  });

  it('lists the main file first with its size', () => {
    const code = 'nop\n; é\n';
    const m = build(code);
    expect(m.debug!.files[0]).toMatchObject({name: 'a.s', size: 9});
  });

  it('survives an object file round trip', () => {
    const m = build('.segment "CODE"\n.proc p\n  nop\n.endproc\n');
    const back = deserializeObjectFile(serializeObjectFile(m));
    const bare = (d: Module['debug']) => ({...d, syms: d!.syms.map(({expr: _e, ...rest}) => rest)});
    expect(bare(back.debug)).toEqual(bare(JSON.parse(JSON.stringify(m.debug))));
    expect(back.debug!.syms.map(sym => sym.expr?.op))
        .toEqual(m.debug!.syms.map(sym => sym.expr?.op));
    expect(back.chunks![0].debugRuns).toEqual(m.chunks![0].debugRuns);
  });

  it('is dropped when the object file strips debug info', () => {
    const m = build('nop\n');
    const back = deserializeObjectFile(serializeObjectFile(m, false));
    expect(back.debug).toBeUndefined();
    expect(back.chunks![0].debugRuns).toBeUndefined();
  });
});

// Expected values were checked against ca65 -g and ld65 --dbgfile.
describe('dbg writer', () => {
  const A = [
    '.import ext', '.export main', '.segment "CODE"',
    '.proc main', '  lda #1', '@loop:', '  dex', '  bne @loop', '  jsr ext', '  rts', '.endproc',
    '.macro twice', '  nop', '  nop', '.endmacro', '  twice',
    '.segment "BSS"', 'buf: .res 4',
  ].join('\n') + '\n';
  const B = '.export ext\n.segment "CODE"\next:\n  rts\n';
  const CFG = `
    MEMORY { RAM: start=$0200, size=$100; ROM: start=$8000, size=$100, file=%O; }
    SEGMENTS { CODE: load=ROM, type=ro; BSS: load=RAM, type=bss; }`;

  function link() {
    const r = compile(
        [{type: 'source', code: A, name: 'a.s'}, {type: 'source', code: B, name: 'b.s'}],
        {generateDebugInfo: true, generateDbgFile: true, outputName: 'ld.bin',
         linkerConfig: CFG, lint: {enabled: false}});
    expect(r.messages.filter(m => m.level === 'error')).toEqual([]);
    const text = new TextDecoder().decode(findOutput(r, 'debug')!.data);
    expect(checkDbgSyntax(text)).toEqual([]);
    return parseDbg(text);
  }
  const m = link();
  const seg = (name: string) => m.segs.findIndex(s => s.name === name);
  const modOf = (s: DbgSym): number =>
      s.scope !== undefined ? m.scopes[s.scope].mod : modOf(m.syms[s.parent!]);
  const sym = (name: string, mod = 0) => m.syms.find(s => s.name === name && modOf(s) === mod)!;
  const lineAt = (line: number, type = 0) =>
      m.lines.find(l => l.file === 0 && l.line === line && l.type === type)!;
  const spansOf = (ids: number[]) => ids.map(id => {
    const s = m.spans[id];
    return [m.segs[s.seg].name, s.start, s.size];
  });

  it('writes the segments as ld65 does', () => {
    expect(m.segs.map(s => [s.name, s.start, s.size, s.type, s.oname, s.ooffs])).toEqual([
      ['CODE', 0x8000, 12, 'ro', 'ld.bin', 0],
      ['BSS', 0x200, 4, 'rw', undefined, undefined],
    ]);
  });

  it('describes a .proc', () => {
    const main = sym('main');
    const scope = m.scopes.find(s => s.name === 'main')!;
    expect(scope).toMatchObject({mod: 0, type: 'scope', size: 9, parent: 0, sym: main.id});
    expect(spansOf(scope.spans)).toEqual([['CODE', 0, 9]]);
    expect(main).toMatchObject({size: 9, scope: 0, val: 0x8000, seg: seg('CODE'), kind: 'lab'});
    expect(main.defs.map(id => m.lines[id].line)).toEqual([4]);
    expect(main.refs.map(id => m.lines[id].line)).toEqual([2]);
  });

  it('hangs a cheap local off its label', () => {
    const loop = sym('@loop');
    expect(loop).toMatchObject({parent: sym('main').id, val: 0x8002, seg: seg('CODE')});
    expect(loop.defs.map(id => m.lines[id].line)).toEqual([6]);
    expect(loop.refs.map(id => m.lines[id].line)).toEqual([8]);
  });

  it('gives a macro call and its body lines the same bytes', () => {
    expect(spansOf(lineAt(16).spans)).toEqual([['CODE', 9, 2]]);
    expect(lineAt(13, 2)).toMatchObject({count: 1});
    expect(spansOf(lineAt(13, 2).spans)).toEqual([['CODE', 9, 1]]);
    expect(spansOf(lineAt(14, 2).spans)).toEqual([['CODE', 10, 1]]);
  });

  it('points an import at the export', () => {
    const imp = sym('ext', 0);
    const exp = sym('ext', 1);
    expect(imp).toMatchObject({kind: 'imp', exp: exp.id});
    expect(imp.defs.map(id => m.lines[id].line)).toEqual([1]);
    expect(imp.refs.map(id => m.lines[id].line)).toEqual([9]);
    expect(exp).toMatchObject({kind: 'lab', val: 0x800B, seg: seg('CODE')});
    expect(exp.refs.map(id => m.lines[id].line)).toEqual([1]);
  });

  it('sizes .res data in its segment', () => {
    expect(sym('buf')).toMatchObject({size: 4, val: 0x200, seg: seg('BSS'), kind: 'lab'});
    expect(spansOf(lineAt(18).spans)).toEqual([['BSS', 0, 4]]);
    const root = m.scopes.find(s => s.mod === 0 && s.parent === undefined)!;
    expect(root.size).toBe(11);
    expect(spansOf(root.spans).sort()).toEqual([['BSS', 0, 4], ['CODE', 0, 11]]);
  });

  it('counts every record in info', () => {
    expect(Object.fromEntries(m.info)).toEqual({
      csym: 0, file: 2, lib: 0, line: 17, mod: 2, scope: 3, seg: 2, span: 12, sym: 5, type: 0,
    });
  });
});

// Expected values were checked against ca65 -g and ld65 --dbgfile.
describe('.dbg directives', () => {
  const H = [
    '.dbg file, "h.c", 100, 12345',
    '.import ext_var', '.importzp regbank', '.export _main',
    '.segment "BSS"', '_glob: .res 2', '.segment "CODE"',
    '.proc _main: near',
    '.dbg func, "main", "00", extern, "_main"',
    '.dbg sym, "a", "00", auto, 2',
    '.dbg sym, "z", "00", auto, 0',
    '.dbg sym, "g", "20", static, "_glob"',
    '.dbg sym, "x", "21", extern, "ext_var"',
    '.dbg sym, "r", "00", register, "regbank", 4',
    '.dbg line, "h.c", 3', '  lda #1', '  sta _glob',
    '.dbg line, "h.c", 4', '  lda ext_var', '@l: dex', '  bne @l',
    '.dbg line, "h.c", 5',
    '.dbg line, "h.c", 6', '  rts',
    '.dbg line', '.endproc',
  ].join('\n') + '\n';
  const X = [
    '.exportzp regbank', '.export ext_var', '.segment "ZEROPAGE"', 'regbank: .res 6',
    '.segment "CODE"', 'ext_var: .word 0',
  ].join('\n') + '\n';
  const N = '.export nf\n.segment "CODE"\nnf: lda #2\n  rts\n.debuginfo off\n';
  const CFG = `
    MEMORY { ZP: start=$0, size=$100; RAM: start=$0200, size=$100; ROM: start=$8000, size=$100, file=%O; }
    SEGMENTS { ZEROPAGE: load=ZP, type=zp; CODE: load=ROM, type=ro; BSS: load=RAM, type=bss; }`;

  function link() {
    const r = compile(
        [{type: 'source', code: H, name: 'h.s'}, {type: 'source', code: X, name: 'x.s'},
         {type: 'source', code: N, name: 'n.s'}],
        {generateDebugInfo: true, generateDbgFile: true, outputName: 'out.bin',
         linkerConfig: CFG, lint: {enabled: false}});
    expect(r.messages.filter(m => m.level === 'error')).toEqual([]);
    const text = new TextDecoder().decode(findOutput(r, 'debug')!.data);
    expect(checkDbgSyntax(text)).toEqual([]);
    return parseDbg(text);
  }
  const m = link();
  const fileNamed = (name: string) => m.files.findIndex(f => f.name === name);
  const symNamed = (name: string, mod = 0) => m.syms.find(s =>
      s.name === name && (s.scope === undefined || m.scopes[s.scope].mod === mod))!;
  const ext = (line: number) =>
      m.lines.find(l => l.file === fileNamed('h.c') && l.line === line);
  const spansOf = (ids: number[]) => ids.map(id => [m.spans[id].start, m.spans[id].size]);

  it('writes a csym per .dbg func and .dbg sym', () => {
    const proc = m.scopes.find(s => s.name === '_main')!.id;
    expect(m.csyms.map(c => [c.name, c.scope, m.types[c.type].val, c.sc, c.offs, c.sym]))
        .toEqual([
          ['main', proc, '00', 'ext', 0, symNamed('_main').id],
          ['a', proc, '00', 'auto', 2, undefined],
          ['z', proc, '00', 'auto', 0, undefined],
          ['g', proc, '20', 'static', 0, symNamed('_glob').id],
          ['x', proc, '21', 'ext', 0, symNamed('ext_var').id],
          ['r', proc, '00', 'reg', 4, undefined],
        ]);
  });

  it('keeps the size and mtime from .dbg file', () => {
    expect(m.files[fileNamed('h.c')]).toMatchObject({size: 100, mtime: 12345, mods: [0]});
  });

  it('joins an ext line across statements and drops an empty one', () => {
    expect(ext(3)).toMatchObject({type: 1, count: 0});
    expect(spansOf(ext(3)!.spans)).toEqual([[0, 5]]);
    expect(spansOf(ext(4)!.spans)).toEqual([[5, 6]]);
    expect(ext(5)).toBeUndefined();
    expect(spansOf(ext(6)!.spans)).toEqual([[11, 1]]);
  });

  it('adds the ext line to a label def but not to refs', () => {
    const l = symNamed('@l');
    expect(l.defs.map(id => [m.lines[id].file, m.lines[id].line]).sort())
        .toEqual([[fileNamed('h.c'), 4], [fileNamed('h.s'), 20]].sort());
    expect(l.refs.map(id => m.lines[id].line)).toEqual([21]);
  });

  it('keeps only spanless lines after .debuginfo off', () => {
    expect(m.scopes.some(s => s.mod === 2)).toBe(false);
    expect(m.syms.find(s => s.name === 'nf')).toBeUndefined();
    const lines = m.lines.filter(l => l.file === fileNamed('n.s'));
    expect(lines.map(l => l.line).sort()).toEqual([1, 3, 4]);
    expect(lines.every(l => !l.spans.length)).toBe(true);
  });
});

describe('.dbg directive errors', () => {
  const errors = (code: string) =>
      assemble([{type: 'source', code, name: 'a.s'}], {generateDebugInfo: true})
          .messages.filter(m => m.level === 'error').map(m => m.message);

  it('needs a .proc with the same name for func', () => {
    expect(errors('.dbg func, "f", "00", extern, "f"\n'))
        .toEqual(['Functions may not be used in the root scope']);
    expect(errors('.scope s\n.dbg func, "f", "00", extern, "s"\n.endscope\n'))
        .toEqual(['Functions can only be tagged to .PROC scopes']);
    expect(errors('.proc p\n.dbg func, "f", "00", extern, "q"\n.endproc\n'))
        .toEqual(['Scope label and asm name for function must match']);
    expect(errors('.proc p\n.dbg func, "f", "00", static, "p"\n' +
                  '.dbg func, "g", "00", static, "p"\n.endproc\n'))
        .toEqual(['Only one HLL symbol per asm symbol is allowed']);
  });

  it('checks types, storage classes and file names', () => {
    expect(errors('.dbg sym, "s", "0", auto, 0\n')).toEqual(['Type value has invalid length']);
    expect(errors('.dbg sym, "s", "0G", auto, 0\n'))
        .toEqual(['Type value contains invalid characters']);
    expect(errors('.dbg sym, "s", "00", global, "x"\n'))
        .toEqual(['Storage class specifier expected']);
    expect(errors('.dbg line, "nope.c", 1\n'))
        .toEqual(["File name 'nope.c' not found in file table"]);
  });

  it('resolves a static asm symbol at the end of the module', () => {
    expect(errors('.dbg sym, "s", "00", static, "later"\nlater: nop\n')).toEqual([]);
    expect(errors('.dbg sym, "s", "00", static, "missing"\n'))
        .toEqual(["Assembler symbol 'missing' not found"]);
  });

  it('accepts the ca65 boolean forms of .debuginfo', () => {
    for (const arg of ['', ' on', ' off', ' +', ' -']) {
      expect(errors(`.debuginfo${arg}\n`)).toEqual([]);
    }
    expect(errors('.debuginfo maybe\n')).toEqual(["'on' or 'off' expected"]);
  });
});
