
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {Assembler} from '../src/assembler.ts';
import {Cpu} from '../src/cpu.ts';
import {buildLinkTimeEnv, mergeModuleSegments, replayModules, type LinkTimeEnv} from '../src/latepass.ts';
import {assemble as libAssemble, type AssemblyInput} from '../src/libassembler.ts';
import {SymbolIndex} from '../src/lspindex.ts';
import type {Module, Segment, Symbol} from '../src/module.ts';

function chunk(segments: string[]) {
  return {segments, data: new Uint8Array(0)};
}

function exported(name: string, chunkIndex: number): Symbol {
  return {export: name, expr: {op: 'num', num: 0, meta: {chunk: chunkIndex}}};
}

function moduleWith(chunks: string[][], symbols: Symbol[]): Module {
  return {chunks: chunks.map(chunk), symbols};
}

describe('buildLinkTimeEnv', function() {
  it('resolves to zp when every candidate segment is zp', function() {
    const modules = [moduleWith([['ZP']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['ZP', {name: 'ZP', addressing: 1}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBe(1);
  });

  it('resolves to abs when a segment does not declare zp addressing', function() {
    const modules = [moduleWith([['CODE']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['CODE', {name: 'CODE'}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBe(2);
  });

  it('errors naming the segments when a pool/mirror chunk spans zp and non-zp', function() {
    const modules = [moduleWith([['ZP', 'CODE']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['ZP', {name: 'ZP', addressing: 1}],
      ['CODE', {name: 'CODE'}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(() => env.addrSize('foo')).toThrow(/ZP, CODE/);
  });

  it('returns undefined when the symbol is not exported by any module', function() {
    const modules = [moduleWith([['CODE']], [])];
    const segments = new Map<string, Segment>([['CODE', {name: 'CODE'}]]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBeUndefined();
  });

  it('returns undefined for an exported symbol that is not a chunk address', function() {
    const modules = [moduleWith([['CODE']],
        [{export: 'foo', expr: {op: 'num', num: 5}}])];
    const segments = new Map<string, Segment>([['CODE', {name: 'CODE'}]]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBeUndefined();
  });

  it('resolves bank when every candidate segment agrees', function() {
    const modules = [moduleWith([['BANK1']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['BANK1', {name: 'BANK1', bank: 3}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.bank('foo')).toBe(3);
  });

  it('errors naming the segments when candidate banks disagree', function() {
    const modules = [moduleWith([['BANK1', 'BANK2']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['BANK1', {name: 'BANK1', bank: 1}],
      ['BANK2', {name: 'BANK2', bank: 2}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(() => env.bank('foo')).toThrow(/BANK1, BANK2/);
  });

  it('ignores a candidate segment with no declared bank instead of erroring', function() {
    const modules = [moduleWith([['BANK1', 'UNBANKED']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>([
      ['BANK1', {name: 'BANK1', bank: 1}],
      ['UNBANKED', {name: 'UNBANKED'}],
    ]);
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.bank('foo')).toBe(1);
  });

  it('returns undefined when a candidate segment is not in the merged table', function() {
    const modules = [moduleWith([['GHOST']], [exported('foo', 0)])];
    const segments = new Map<string, Segment>();
    const env = buildLinkTimeEnv(modules, segments);
    expect(env.addrSize('foo')).toBeUndefined();
  });

  describe('segmentBank', function() {
    it('resolves bank when every candidate segment agrees', function() {
      const segments = new Map<string, Segment>([
        ['BANK1', {name: 'BANK1', bank: 3}],
      ]);
      const env = buildLinkTimeEnv([], segments);
      expect(env.segmentBank(['BANK1'])).toBe(3);
    });

    it('errors naming the segments when candidate banks disagree', function() {
      const segments = new Map<string, Segment>([
        ['BANK1', {name: 'BANK1', bank: 1}],
        ['BANK2', {name: 'BANK2', bank: 2}],
      ]);
      const env = buildLinkTimeEnv([], segments);
      expect(() => env.segmentBank(['BANK1', 'BANK2'])).toThrow(/BANK1, BANK2/);
    });

    it('returns undefined when a candidate segment name is absent from the merged table', function() {
      const segments = new Map<string, Segment>();
      const env = buildLinkTimeEnv([], segments);
      expect(env.segmentBank(['GHOST'])).toBeUndefined();
    });
  });
});

describe('replayModules error limit', function() {
  // Every `.if` body is deferred on pass 1, so its errors only land on replay.
  function assembleWithErrorsBehindIf(count: number) {
    const lines = ['.import cond', '.if cond'];
    for (let i = 0; i < count; i++) lines.push(`  .error "boom ${i}"`);
    lines.push('.endif');
    const result = libAssemble(
        [{type: 'source', code: lines.join('\n') + '\n', name: 'test.s'} as AssemblyInput],
        {});
    if (!result.success) throw new Error(JSON.stringify(result.messages));
    return result;
  }

  const env: LinkTimeEnv = {
    addrSize: () => 2,
    bank: () => undefined,
    segmentBank: () => undefined,
  };

  const errorsOf = (msgs: readonly {level: string, message: string}[]) =>
      msgs.filter(m => m.level === 'error' && m.message.startsWith('boom'));

  it('returns every message when the limit is raised past the error count', function() {
    const result = assembleWithErrorsBehindIf(40);
    const replayed = replayModules(
        result.modules, result.moduleMessages, env, undefined, {errorLimit: 1000});
    expect(replayed.success).toBe(false);
    expect(errorsOf(replayed.messages).length).toBe(40);
  });

  it('treats a limit of 0 as unlimited', function() {
    const result = assembleWithErrorsBehindIf(40);
    const replayed = replayModules(
        result.modules, result.moduleMessages, env, undefined, {errorLimit: 0});
    expect(errorsOf(replayed.messages).length).toBe(40);
  });

  it('still stops at the recorded limit when no override is given', function() {
    const result = assembleWithErrorsBehindIf(40);
    expect(() => replayModules(result.modules, result.moduleMessages, env))
        .toThrow(/too many errors/);
  });
});

describe('replayModules assertions', function() {
  const env: LinkTimeEnv = {
    addrSize: () => 2,
    bank: () => undefined,
    segmentBank: () => undefined,
  };

  it('reports a module-close assertion exactly once', function() {
    const code = '.segment "CODE" :bank $00 :size $10 :mem $8000 :off $0000\n' +
        '.org $8000\n  lda #1\n.assert 0, error, "boom"\n';
    const result = libAssemble(
        [{type: 'source', code, name: 'test.s'} as AssemblyInput], {});
    const replayed = replayModules(result.modules, result.moduleMessages, env);
    expect(replayed.messages.filter(m => m.message.startsWith('boom')).length)
        .toBe(1);
  });
});

describe('mergeModuleSegments', function() {
  function moduleSegs(...segments: Segment[]): Module {
    return {segments};
  }

  it('produces the segment table buildLinkTimeEnv reads', function() {
    const modules = [moduleWith([['ZP']], [exported('foo', 0)])];
    modules[0].segments = [{name: 'ZP', addressing: 1}];
    const env = buildLinkTimeEnv(modules, mergeModuleSegments(modules));
    expect(env.addrSize('foo')).toBe(1);
  });

  it('merges the same segment declared across two modules', function() {
    const segments = mergeModuleSegments([
      moduleSegs({name: 'CODE', bank: 2}),
      moduleSegs({name: 'CODE', addressing: 2, size: 0x2000}),
    ]);
    expect(segments.get('CODE')).toEqual(
        {name: 'CODE', bank: 2, addressing: 2, size: 0x2000});
  });

  it('takes the last declaration when two modules disagree on bank', function() {
    const segments = mergeModuleSegments([
      moduleSegs({name: 'CODE', bank: 1}),
      moduleSegs({name: 'CODE', bank: 2}),
    ]);
    expect(segments.get('CODE')!.bank).toBe(2);
  });

  it('concatenates free lists rather than replacing them', function() {
    const segments = mergeModuleSegments([
      moduleSegs({name: 'CODE', free: [[0, 0x10]]}),
      moduleSegs({name: 'CODE', free: [[0x20, 0x30]]}),
    ]);
    expect(segments.get('CODE')!.free).toEqual([[0, 0x10], [0x20, 0x30]]);
  });

  it('drops composite segments', function() {
    const segments = mergeModuleSegments([
      moduleSegs({name: 'FIXED', bank: 1},
                 {name: 'MIRRORED', mirror: ['FIXED']},
                 {name: 'POOLED', pool: ['FIXED']}),
    ]);
    expect(segments.has('MIRRORED')).toBe(false);
    expect(segments.has('POOLED')).toBe(false);
    expect(segments.get('FIXED')!.bank).toBe(1);
  });

  it('seeds segments from a linker config with no modules', function() {
    const segments = mergeModuleSegments([], {linkerConfig: `
      MEMORY { ZP: start = $0, size = $100, type = rw;
               PRG: start = $8000, size = $8000, file = %O; }
      SEGMENTS { ZP: load = ZP, type = zp;
                 CODE: load = PRG, type = ro; }
    `});
    expect(segments.get('ZP')!.addressing).toBe(1);
    expect(segments.get('PRG')!.memory).toBe(0x8000);
    // A SEGMENTS entry with no same-named area only records where it loads.
    expect(segments.get('CODE')!.load).toBe('PRG');
  });

  it('lets a module .segment attr override the config', function() {
    const segments = mergeModuleSegments(
        [moduleSegs({name: 'CODE', bank: 7})],
        {linkerConfig: `
          MEMORY { CODE: start = $8000, size = $8000, bank = $1, file = %O; }
          SEGMENTS { CODE: load = CODE; }
        `});
    expect(segments.get('CODE')!.bank).toBe(7);
    expect(segments.get('CODE')!.memory).toBe(0x8000);
  });

  it('ignores a malformed linker config', function() {
    const segments = mergeModuleSegments(
        [moduleSegs({name: 'CODE', bank: 1})],
        {linkerConfig: 'MEMORY { this is not a config'});
    expect(segments.get('CODE')!.bank).toBe(1);
  });

  it('seeds segments from a built-in target', function() {
    const segments = mergeModuleSegments([], {target: 'nes-nrom'});
    expect(segments.get('ZEROPAGE')!.addressing).toBe(1);
    expect(segments.get('CODE')!.memory).toBe(0x8000);
  });

  it('ignores an unknown target', function() {
    const segments = mergeModuleSegments([moduleSegs({name: 'CODE'})],
                                         {target: 'not-a-target'});
    expect([...segments.keys()]).toEqual(['CODE']);
  });
});

describe('replay symbolIndex override', function() {
  // `inner` sits behind a `.bank` comparison, which only a linkEnv can settle,
  // so pass 1 skips the whole body and never indexes it.
  const main: AssemblyInput = {type: 'source', name: 'main.s', code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.import Target
.scope outer
always:
  nop
.if .bank(Target) <> .bank(*)
inner:
  nop
.endif
.endscope
`};
  const other: AssemblyInput = {type: 'source', name: 'other.s', code: `
.segment "BANK1" :bank $01 :size $2000 :mem $9000 :off $8000
.export Target
Target:
  rts
`};

  function assembleWithIndex() {
    const symbolIndex = new SymbolIndex();
    const result = libAssemble([main, other],
                               {symbolIndex, lineContinuations: true});
    if (!result.success) throw new Error(JSON.stringify(result.messages));
    const env = buildLinkTimeEnv(result.modules,
                                 mergeModuleSegments(result.modules));
    return {result, symbolIndex, env};
  }

  const outerOf = (index: SymbolIndex) =>
      index.root.children.filter(c => c.name === 'outer');

  it('does not index the .if body without a replay', function() {
    const {symbolIndex} = assembleWithIndex();
    const [outer] = outerOf(symbolIndex);
    expect(outer.symbols.has('always')).toBe(true);
    expect(outer.symbols.has('inner')).toBe(false);
  });

  it('collects a symbol defined inside an .if body into the fresh index', function() {
    const {result, env} = assembleWithIndex();
    const replayIndex = new SymbolIndex();
    replayModules(result.modules, result.moduleMessages, env, undefined,
                  {symbolIndex: replayIndex});
    const [outer] = outerOf(replayIndex);
    expect(outer.symbols.has('inner')).toBe(true);
  });

  it('leaves the pass-1 index untouched when replay gets its own', function() {
    const {result, symbolIndex, env} = assembleWithIndex();
    const before = symbolIndex.root.children.length;
    replayModules(result.modules, result.moduleMessages, env, undefined,
                  {symbolIndex: new SymbolIndex()});
    expect(symbolIndex.root.children.length).toBe(before);
    expect(outerOf(symbolIndex)[0].symbols.has('inner')).toBe(false);
  });

  it('records each scope once even though replay rescans', function() {
    const {result, env} = assembleWithIndex();
    const replayIndex = new SymbolIndex();
    replayModules(result.modules, result.moduleMessages, env, undefined,
                  {symbolIndex: replayIndex});
    expect(outerOf(replayIndex).length).toBe(1);
  });

  it('replays byte-identical modules with no override', function() {
    const {result, env} = assembleWithIndex();
    const withIndex = replayModules(result.modules, result.moduleMessages, env,
                                    undefined, {symbolIndex: new SymbolIndex()});
    const plain = assembleWithIndex();
    const without = replayModules(plain.result.modules, plain.result.moduleMessages,
                                  plain.env);
    expect(without.success).toBe(withIndex.success);
    expect(without.messages).toEqual(withIndex.messages);
  });
});

describe('forward-declared scopes in a link-time .if', function() {
  const SEGMENTS = `
.segment "CODE" :bank $00 :size $2000 :mem $8000 :off $0000
.segment "BANK1" :bank $01 :size $2000 :mem $a000 :off $2000
`;

  function assembleSource(code: string) {
    const result = libAssemble([{type: 'source', name: 'main.s', code}],
                               {lineContinuations: true});
    const env = buildLinkTimeEnv(result.modules,
                                 mergeModuleSegments(result.modules));
    return {result, env};
  }

  const messages = (msgs: readonly {message: string}[]) => msgs.map(m => m.message);

  it('assembles a qualified name whose scope comes later in the file', function() {
    const {result} = assembleSource(SEGMENTS + `
.segment "CODE"
start:
  nop
.if .bank(Far::Target) <> .bank(*)
  nop
.endif
.segment "BANK1"
.scope Far
Target:
  rts
.endscope
`);
    expect(messages(result.messages)).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('replays without failing on the not-yet-declared scope', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "CODE"
start:
  nop
.if .bank(Far::Target) <> .bank(*)
  nop
.endif
.segment "BANK1"
.scope Far
Target:
  rts
.endscope
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(messages(replay.messages)).not.toContain('Could not resolve scope Far');
  });

  it('resolves a forward-scoped operand reference', function() {
    const {result} = assembleSource(SEGMENTS + `
.segment "CODE"
start:
  jmp Far::Target
.segment "BANK1"
.scope Far
Target:
  rts
.endscope
`);
    expect(messages(result.messages)).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('still reports a scope that is never declared', function() {
    const {result} = assembleSource(SEGMENTS + `
.segment "CODE"
start:
  lda #Nope::Value
  rts
`);
    expect(result.success).toBe(false);
  });

  it('still rejects re-entering a scope that was really declared', function() {
    const {result} = assembleSource(SEGMENTS + `
.scope foo
.endscope
.scope foo
.endscope
`);
    expect(messages(result.messages)).toContain('Cannot re-enter scope foo');
  });
});

describe('qualified names in a link-time .if', function() {
  const SEGMENTS = `
.segment "CODE" :bank $00 :size $2000 :mem $8000 :off $0000
.segment "BANK1" :bank $01 :size $2000 :mem $a000 :off $2000
`;

  function assembleSource(code: string) {
    const result = libAssemble([{type: 'source', name: 'main.s', code}],
                               {lineContinuations: true});
    const env = buildLinkTimeEnv(result.modules,
                                 mergeModuleSegments(result.modules));
    return {result, env};
  }

  const messages = (msgs: readonly {message: string}[]) => msgs.map(m => m.message);

  it('settles a qualified forward ref in the same scope', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "CODE"
.scope Far
start:
  nop
.if .bank(Far::Target) <> .bank(*)
  nop
.endif
Target:
  rts
.endscope
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(messages(replay.messages)).toEqual([]);
    expect(replay.success).toBe(true);
  });

  it('still settles an unqualified forward ref in the same scope', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "CODE"
.scope Far
start:
  nop
.if .bank(Target) <> .bank(*)
  nop
.endif
Target:
  rts
.endscope
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(messages(replay.messages)).toEqual([]);
    expect(replay.success).toBe(true);
  });

  it('keys collected segments by qualified name', function() {
    const asm = new Assembler(Cpu.P02);
    asm.segment('CODE');
    asm.scope('One');
    asm.label('Target');
    asm.byte(0);
    asm.endScope();
    asm.scope('Two');
    asm.label('Target');
    asm.byte(0);
    asm.endScope();
    expect([...asm.collectLocalSegments().keys()])
        .toEqual(['One::Target', 'Two::Target']);
  });

  it('skips anonymous scopes when qualifying a key', function() {
    const asm = new Assembler(Cpu.P02);
    asm.segment('CODE');
    asm.scope(undefined);
    asm.scope('Far');
    asm.label('Target');
    asm.byte(0);
    asm.endScope();
    asm.endScope();
    expect([...asm.collectLocalSegments().keys()]).toEqual(['Far::Target']);
  });

  it('does not collide same-named labels in sibling scopes', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "CODE"
.scope One
  .if .bank(Two::Target) <> .bank(*)
  nop
  .endif
Target:
  rts
.endscope
.segment "BANK1"
.scope Two
Target:
  rts
.endscope
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    // Both labels used to share the bare key `Target`, so one shadowed the other.
    expect(messages(replay.messages).some(m => /lands in a different segment/.test(m)))
        .toBe(false);
  });
});

describe('.bank(*) before the chunk is started', function() {
  const SEGMENTS = `
.segment "CODE" :bank $00 :size $2000 :mem $8000 :off $0000
.segment "BANK1" :bank $01 :size $2000 :mem $a000 :off $2000
`;

  function assembleSource(code: string) {
    const result = libAssemble([{type: 'source', name: 'main.s', code}],
                               {lineContinuations: true});
    const env = buildLinkTimeEnv(result.modules,
                                 mergeModuleSegments(result.modules));
    return {result, env};
  }

  const messages = (msgs: readonly {message: string}[]) => msgs.map(m => m.message);

  it('settles a backward ref compared against .bank(*)', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "BANK1"
Target:
  rts
.segment "CODE"
.if .bank(Target) <> .bank(*)
  nop
.endif
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(messages(replay.messages)).toEqual([]);
    expect(replay.success).toBe(true);
  });

  it('settles a scoped backward ref compared against .bank(*)', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "BANK1"
.scope Far
Target:
  rts
.endscope
.segment "CODE"
.if .bank(Far::Target) <> .bank(*)
  nop
.endif
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(messages(replay.messages)).toEqual([]);
    expect(replay.success).toBe(true);
  });

  it('takes the branch when the banks really differ', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "BANK1"
Target:
  rts
.segment "CODE"
.if .bank(Target) <> .bank(*)
  nop
.endif
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    const chunks = replay.modules[0].chunks ?? [];
    const code = chunks.find(c => c.segments.includes('CODE'));
    expect(code?.data.length).toBe(1);
  });

  it('skips the branch when the banks match', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "BANK1"
Target:
  rts
.segment "BANK1"
.if .bank(Target) <> .bank(*)
  nop
.endif
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(replay.success).toBe(true);
    const total = (replay.modules[0].chunks ?? [])
        .reduce((sum, c) => sum + c.data.length, 0);
    expect(total).toBe(1); // just the `rts`
  });

  it('does not materialize a chunk for an empty branch', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "BANK1"
Target:
  rts
.segment "CODE"
.if .bank(Target) <> .bank(*)
.endif
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(replay.success).toBe(true);
    expect(replay.modules[0].chunks?.length).toBe(1);
  });

  it('reports segments that disagree on a bank', function() {
    const {result, env} = assembleSource(SEGMENTS + `
.segment "BANK1"
Target:
  rts
.segment "CODE", "BANK1"
.if .bank(Target) <> .bank(*)
  nop
.endif
`);
    const replay = replayModules(result.modules, result.moduleMessages, env);
    expect(messages(replay.messages).join(' '))
        .toMatch(/disagreement across segments/);
  });
});
