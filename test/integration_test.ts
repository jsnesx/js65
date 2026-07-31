
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {compile, compileRequest, deserializeObjectFile, type AssemblyInput, type FileCallbacks} from '../src/libassembler.ts';

async function compileSource(source: string, filename: string = 'test.s'): Promise<Uint8Array> {
  const input: AssemblyInput = { type: 'source', code: source, name: filename };
  const result = await compile([input], { lineContinuations: true });
  if (!result.success) {
    throw new Error(`Expected compile result but got ${JSON.stringify(result)}`);
  }
  return result.outputs[0].data;
}

async function compileWithBaseRom(source: string, baseRom: Uint8Array, filename: string = 'test.s'): Promise<Uint8Array> {
  const initsrc: AssemblyInput = { type: 'source', name: 'init.s', code: `
.macpack common
.segment "HEADER" :bank $00 :size $0010 :mem $0000 :off $00000
.segment "PRG"    :bank $00 :size $8000 :mem $8000 :off $00010
.segment "CHR"    :bank $00 :size $2000 :mem $0000 :off $08010
FREE "PRG" [$8000, $10000)
`};
  const input: AssemblyInput = { type: 'source', code: source, name: filename };
  const result = await compile([initsrc, input], { lineContinuations: true }, undefined, baseRom);
  return result.outputs[0].data;
}

async function expectCompileError(source: string, errorMatch?: string | RegExp): Promise<Error> {
  const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
  const result = await compile([input], { lineContinuations: true });

  if (result.success) {
    throw new Error('Expected compilation to fail but it succeeded');
  }

  // Get error messages for matching
  const errorMessages = result.messages
    .filter(m => m.level === 'error')
    .map(m => m.message)
    .join('\n');

  if (errorMatch) {
    if (typeof errorMatch === 'string') {
      expect(errorMessages).toContain(errorMatch);
    } else {
      expect(errorMessages).toMatch(errorMatch);
    }
  }

  return new Error(errorMessages);
}

// Simple mock filesystem for testing path resolution
// Stands in for the host's path resolution. Both separators are accepted, the way
// std::filesystem (hermes), node's path (bun) and .NET all behave on Windows, and a
// leading separator stays put so absolute paths don't silently become relative ones.
function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split(/[\\/]/)) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return (/^[\\/]/.test(p) ? '/' : '') + out.join('/');
}
function resolve(base: string, rel: string): string {
  // An absolute include path ignores the base it was joined onto, as path joins do.
  if (/^[\\/]/.test(rel)) return normalize(rel);
  return normalize(base ? `${base}/${rel}` : rel);
}

function makeFs(text: Record<string, string>, bin: Record<string, number[]> = {}): FileCallbacks {
  return {
    readText: async (base, rel) => {
      const key = resolve(base, rel);
      if (!(key in text)) throw new Error(`ENOENT ${key}`);
      return text[key];
    },
    readBinary: async (base, rel) => {
      const key = resolve(base, rel);
      if (!(key in bin)) throw new Error(`ENOENT ${key}`);
      return new Uint8Array(bin[key]);
    },
  };
}

async function asmObject(input: AssemblyInput, opts: Parameters<typeof compile>[1], fs: FileCallbacks) {
  return compile([input], {...opts, outputFormat: 'object'}, fs);
}

describe('End to end test cases', function() {
  describe('compileRequest data handling', function() {
    it('returns a failure result (not a throw) for malformed JSON', async function() {
      const result = await compileRequest('{ not valid json');
      expect(result.success).toBe(false);
      expect(result.outputs).toEqual([]);
      expect(result.messages.some(m => m.level === 'error')).toBe(true);
    });

    it('returns a failure result (not a throw) for an invalid request shape', async function() {
      const result = await compileRequest(JSON.stringify({ inputs: 'not-an-array' }));
      expect(result.success).toBe(false);
      expect(result.messages.some(m => m.level === 'error' && /Invalid compile request/.test(m.message))).toBe(true);
    });

    it('compiles well-formed data', async function() {
      const req = JSON.stringify({
        inputs: [{ type: 'source', name: 'test.s', code: '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\nlda #$42\n' }],
        options: { lineContinuations: true },
      });
      const result = await compileRequest(req);
      expect(result.success).toBe(true);
      expect(result.outputs.find(o => o.type === 'binary')).toBeTruthy();
    });
  });

  describe('cancellation', function() {
    it('returns a cancelled failure result (not a throw) when the signal is already aborted', async function() {
      const input: AssemblyInput = { type: 'source', name: 'test.s', code: '.org $8000\nlda #$42\n' };
      const result = await compile([input], { lineContinuations: true }, undefined, undefined, { aborted: true });
      expect(result.success).toBe(false);
      expect(result.outputs).toEqual([]);
      expect(result.messages.some(m => m.level === 'error' && /cancelled/i.test(m.message))).toBe(true);
    });

    it('cancels mid-assembly at the per-line boundary', async function() {
      // Stay un-aborted long enough to clear compile()'s top check and assemble()'s per-input
      // check, then trip inside the per-line tokens() loop.
      let polls = 0;
      const signal = { get aborted() { return polls++ > 1; } };
      const input: AssemblyInput = { type: 'source', name: 'test.s', code: 'lda #$01\nlda #$02\nlda #$03\nlda #$04\n' };
      const result = await compile([input], { lineContinuations: true }, undefined, undefined, signal);
      expect(result.success).toBe(false);
      expect(result.messages.some(m => /cancelled/i.test(m.message))).toBe(true);
    });

    it('compileRequest forwards the cancel signal', async function() {
      const req = JSON.stringify({
        inputs: [{ type: 'source', name: 'test.s', code: '.org $8000\nlda #$42\n' }],
        options: { lineContinuations: true },
      });
      const result = await compileRequest(req, undefined, undefined, { aborted: true });
      expect(result.success).toBe(false);
      expect(result.messages.some(m => /cancelled/i.test(m.message))).toBe(true);
    });
  });

  describe('Real world tests', function() {
    it('should not cause an infinite loop in symbol resolution', async function() {
      const source = `
.macpack common
.macro SET_RES_BASE addr
    RES_BASE .set addr
    RES_OFFSET .set 0
.endmacro
.macro RESV name, size
    .ident(.string(name)) = RES_BASE + RES_OFFSET
    .ifnblank size
        RES_OFFSET .set RES_OFFSET + size
    .else
        RES_OFFSET .set RES_OFFSET + 1
    .endif
.endmacro

StatTrackingBase = $6383
SET_RES_BASE StatTrackingBase

StatTimeAtLocation = StatTimeInEncounters
RESV StatTimeInEncounters, 3

.segment "CODE" :bank $00 :size $4000 :mem $8000 :off $0000
FREE "CODE" [$8000, $10000)
.segment "CODE"
@IncrementTimer:
  inc StatTimeAtLocation+0,x
`;
      const result = await compileSource(source);
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });

  });

  describe('Segment handling', function() {
    it('should handle multiple segments', async function() {
      const source = `
.segment "CODE" :bank $00 :size $4000 :mem $8000 :off $0000
.segment "DATA" :bank $00 :size $4000 :mem $C000 :off $4000

.segment "CODE"
.org $8000
CodeStart:
  lda DataValue
  rts

.segment "DATA"
.org $C000
DataValue:
  .byte $42
`;
      const result = await compileSource(source);
      expect(result).toBeTruthy();
    });

    it('should handle .reloc for relocatable code', async function() {
      const source = `
.macpack common
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
FREE "CODE" [$8000, $10000)

.segment "CODE"
.org $8000
Fixed:
  jsr Relocatable

.reloc
Relocatable:
  lda #$42
  rts
`;
      const result = await compileSource(source);
      expect(result).toBeTruthy();
    });
  });

  describe('ROM patching with base ROM', function() {
    it('should patch specific locations in base ROM', async function() {
      // Create a base ROM filled with $FF
      const baseRom = new Uint8Array(0x8010).fill(0xFF);

      const source = `
.segment "PRG"
.org $8000
  lda #$42
`;
      const result = await compileWithBaseRom(source, baseRom);

      // Check that the patch was applied at offset $10 (after header)
      expect(result[0x10]).toBe(0xA9); // lda immediate
      expect(result[0x11]).toBe(0x42);
      // Rest should still be $FF
      expect(result[0x13]).toBe(0xFF);
    });

    it('should handle multiple patches to base ROM', async function() {
      const baseRom = new Uint8Array(0x8010).fill(0x00);

      const source = `
.segment "PRG"
.org $8000
  .byte $AA

.org $8100
  .byte $BB

.org $C000
  .byte $CC
`;
      const result = await compileWithBaseRom(source, baseRom);

      expect(result[0x10]).toBe(0xAA);      // $8000 -> offset $10
      expect(result[0x110]).toBe(0xBB);     // $8100 -> offset $110
      expect(result[0x4010]).toBe(0xCC);    // $C000 -> offset $4010
    });
  });

  describe('Error handling', function() {
    it('should report undefined symbol errors', async function() {
      const source = `
.segment "PRG"
.org $8000
  lda UndefinedSymbol
`;
      await expectCompileError(source, 'UndefinedSymbol');
    });

    it('should report branch out of range errors', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  beq FarLabel
.org $8200
FarLabel:
  rts
`;
      await expectCompileError(source, /branch|range/i);
    });

    it('should report duplicate label errors', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
DuplicateLabel:
  nop
DuplicateLabel:
  rts
`;
      await expectCompileError(source, /duplicate|redefin/i);
    });
  });

  describe('Multi-module linking', function() {
    it('should link multiple modules with imports/exports', async function() {
      const mainModule: AssemblyInput = {
        type: 'source',
        name: 'main.s',
        code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.import HelperRoutine
.org $8000

Main:
  jsr HelperRoutine
  rts
`
      };

      const helperModule: AssemblyInput = {
        type: 'source',
        name: 'helper.s',
        code: `
.segment "CODE"
.export HelperRoutine
.org $8100

HelperRoutine:
  lda #$42
  rts
`
      };

      const result = await compile([mainModule, helperModule], { lineContinuations: true });
      const data = result.outputs[0].data;
      expect(data).toBeTruthy();

      // Main should have JSR to $8100
      expect(data[0]).toBe(0x20); // JSR
      expect(data[1]).toBe(0x00); // low byte of $8100
      expect(data[2]).toBe(0x81); // high byte of $8100
    });

    it('should handle circular imports between modules', async function() {
      const moduleA: AssemblyInput = {
        type: 'source',
        name: 'moduleA.s',
        code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.import FuncB
.export FuncA
.org $8000

FuncA:
  jmp FuncB
`
      };

      const moduleB: AssemblyInput = {
        type: 'source',
        name: 'moduleB.s',
        code: `
.segment "CODE"
.import FuncA
.export FuncB
.org $8100

FuncB:
  jmp FuncA
`
      };

      const result = await compile([moduleA, moduleB], { lineContinuations: true });
      expect(result.outputs[0].data).toBeTruthy();
    });
  });

  describe('IPS patch generation', function() {
    it('should generate valid IPS patch format', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  lda #$42
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile([input], { lineContinuations: true, outputFormat: 'ips' });
      const data = result.outputs[0].data;

      // IPS header is "PATCH"
      expect(data[0]).toBe(0x50); // 'P'
      expect(data[1]).toBe(0x41); // 'A'
      expect(data[2]).toBe(0x54); // 'T'
      expect(data[3]).toBe(0x43); // 'C'
      expect(data[4]).toBe(0x48); // 'H'
    });
  });

  describe('Debug info generation', function() {
    it('should generate debug info when requested', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000

TestLabel:
  lda #$42
  rts
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile(
        [input],
        { lineContinuations: true, generateDebugInfo: true, debugLevel: 0 }
      );

      const debug = result.outputs.find(o => o.type === 'debug');
      expect(debug).toBeTruthy();
      const debugText = new TextDecoder().decode(debug!.data);
      expect(debugText).toBeTruthy();
      expect(debugText).toContain('TestLabel');
    });
  });

  describe('.include resolution', function() {
    // Only 'inc/' has the file; 'missing/' is searched first so the loop has to fall through.
    const callbacks = {
      readText: async (base: string, file: string) => {
        if (base !== 'inc') throw new Error(`ENOENT ${base}/${file}`);
        return '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n';
      },
      readBinary: async () => { throw new Error('no binaries in this test'); },
    };

    it('reports a missing include as an error rather than succeeding silently', async function() {
      const input: AssemblyInput = { type: 'source', code: '.include "nope.s"\n  nop\n', name: 'test.s' };
      // generateDebugInfo is what makes the tokenizer stamp source info onto tokens, so it
      // has to be on for the diagnostic to carry a location (the CLI turns it on by default).
      const result = await compile([input],
                                   { includePaths: ['missing'], generateDebugInfo: true },
                                   callbacks);

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('Could not find file nope.s');
      // The diagnostic points at the .include line, not at the assembler as a whole.
      expect(errors[0].source?.file).toBe('test.s');
      expect(errors[0].source?.line).toBe(1);
    });

    it('falls through to later include directories', async function() {
      const input: AssemblyInput = { type: 'source', code: '.include "found.s"\n  nop\n', name: 'test.s' };
      const result = await compile([input], { includePaths: ['missing', 'inc'] }, callbacks);

      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('keeps diagnostics collected before the failure', async function() {
      const source = '.warning "earlier warning"\n.include "nope.s"\n';
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile([input], { includePaths: ['missing'] }, callbacks);

      expect(result.success).toBe(false);
      expect(result.messages.filter(m => m.level === 'warning').map(m => m.message))
          .toEqual(['earlier warning']);
    });
    it('resolves nested .include relative to the including file', async () => {
      const fs = makeFs({
        'prg/sub/inner.inc': '.include "leaf.inc"\n',
        'prg/sub/leaf.inc': 'lda #1\n',
      });
      const result = await asmObject(
        {type: 'source', code: '.include "sub/inner.inc"\n', name: 'prg/stub.s'},
        {}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('falls through every -I directory, not just the first', async () => {
      const fs = makeFs({ 'inc2/common.inc': 'lda #2\n' });
      const result = await asmObject(
        {type: 'source', code: '.include "common.inc"\n', name: 'main.s'},
        {includePaths: ['inc1', 'inc2']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('uses --bin-include-dir (binIncludePaths) for .incbin', async () => {
      const fs = makeFs(
        {},
        { 'art/data.bin': [0xAA, 0xBB, 0xCC] });
      const result = await asmObject(
        {type: 'source', code: '.incbin "data.bin"\n', name: 'main.s'},
        {binIncludePaths: ['art']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
      const mod = deserializeObjectFile(result.outputs[0].data);
      // The three bytes should land in one of the module's chunks.
      const found = (mod.chunks ?? []).some(c =>
        Array.from(c.data).join() === [0xAA, 0xBB, 0xCC].join());
      expect(found).toBe(true);
    });

    it('resolves a top-level file\'s includes against that file\'s directory', async () => {
      // `js65 bhop/bhop.s` run from the parent of bhop/: `.include "bhop/commands.asm"`
      // has to land on bhop/bhop/commands.asm, not on the cwd-relative bhop/commands.asm.
      const fs = makeFs({
        'bhop/bhop/commands.asm': 'lda #1\n',
        'bhop/bhop/util.asm': '.include "helpers.inc"\n',
        'bhop/bhop/helpers.inc': 'lda #2\n',
      });
      const result = await asmObject(
        {type: 'source',
         code: '.include "bhop/commands.asm"\n.include "bhop/util.asm"\n',
         name: 'bhop/bhop.s'},
        {}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('accepts backslash separators in the source name and in -I directories', async () => {
      const fs = makeFs({
        'prg/sub/inner.inc': '.include "leaf.inc"\n',
        'prg/sub/leaf.inc': 'lda #1\n',
        'vendor/inc/common.inc': 'lda #2\n',
      });
      const result = await asmObject(
        {type: 'source',
         code: '.include "sub/inner.inc"\n.include "common.inc"\n',
         name: 'prg\\stub.s'},
        {includePaths: ['vendor\\inc']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('resolves an include relative to an -I directory it was found in', async () => {
      // common.inc is only reachable via -I; its own `.include` is relative to itself,
      // so the search has to remember which base the file actually came from.
      const fs = makeFs({
        'vendor/common.inc': '.include "detail/impl.inc"\n',
        'vendor/detail/impl.inc': '.include "leaf.inc"\n',
        'vendor/detail/leaf.inc': 'lda #3\n',
      });
      const result = await asmObject(
        {type: 'source', code: '.include "common.inc"\n', name: 'main.s'},
        {includePaths: ['vendor']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('keeps absolute -I directories absolute when resolving nested includes', async () => {
      const fs = makeFs({
        '/opt/inc/common.inc': '.include "leaf.inc"\n',
        '/opt/inc/leaf.inc': 'lda #4\n',
      });
      const result = await asmObject(
        {type: 'source', code: '.include "common.inc"\n', name: 'main.s'},
        {includePaths: ['/opt/inc']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('lists each include directory once in the diagnostic', async () => {
      const fs = makeFs({});
      const result = await asmObject(
        {type: 'source', code: '.include "nope.inc"\n', name: 'inc/main.s'},
        {includePaths: ['inc', 'inc', 'other']}, fs);
      expect(result.success).toBe(false);
      const msg = result.messages.find(m => /Could not find file nope\.inc/.test(m.message));
      expect(msg?.message).toContain('inc,other');
    });

    it('reports the search list when a file is genuinely missing', async () => {
      const fs = makeFs({});
      const result = await asmObject(
        {type: 'source', code: '.include "nope.inc"\n', name: 'main.s'},
        {includePaths: ['a', 'b']}, fs);
      expect(result.success).toBe(false);
      expect(result.messages.some(m => /Could not find file nope\.inc/.test(m.message))).toBe(true);
    });
  });

  describe('Multi-error collection', function() {
    it('should collect multiple assembly errors from different lines', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  lda UndefinedSymbol1
  sta UndefinedSymbol2
  jsr UndefinedSymbol3
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(3);
      expect(errors.some(e => e.message.includes('UndefinedSymbol1'))).toBe(true);
      expect(errors.some(e => e.message.includes('UndefinedSymbol2'))).toBe(true);
      expect(errors.some(e => e.message.includes('UndefinedSymbol3'))).toBe(true);
    });

    it('should collect multiple duplicate label errors', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
MyLabel:
  nop
MyLabel:
  nop
AnotherLabel:
  nop
AnotherLabel:
  rts
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.some(e => e.message.includes('MyLabel'))).toBe(true);
      expect(errors.some(e => e.message.includes('AnotherLabel'))).toBe(true);
    });

    it('should collect errors from multiple input files', async function() {
      const file1: AssemblyInput = {
        type: 'source',
        name: 'file1.s',
        code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  lda MissingFromFile1
`
      };

      const file2: AssemblyInput = {
        type: 'source',
        name: 'file2.s',
        code: `
.segment "CODE"
.org $8100
  sta MissingFromFile2
`
      };

      const result = await compile([file1, file2], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.some(e => e.message.includes('MissingFromFile1'))).toBe(true);
      expect(errors.some(e => e.message.includes('MissingFromFile2'))).toBe(true);
    });

    it('should collect multiple unresolved import errors during linking', async function() {
      const module1: AssemblyInput = {
        type: 'source',
        name: 'main.s',
        code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.import MissingFunc1
.import MissingFunc2
.import MissingFunc3
.org $8000
  jsr MissingFunc1
  jsr MissingFunc2
  jsr MissingFunc3
`
      };

      const result = await compile([module1], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      // Should have at least one error about missing imports
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it('should include source location in error messages', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  nop
  nop
  lda UndefinedHere
  nop
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'location_test.s' };
      const result = await compile(
        [input],
        { lineContinuations: true, generateDebugInfo: true }
      );

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThan(0);

      // At least one error should have source info
      const errorWithSource = errors.find(e => e.source !== undefined);
      expect(errorWithSource).toBeDefined();
      if (errorWithSource?.source) {
        expect(errorWithSource.source.file).toBe('location_test.s');
        expect(errorWithSource.source.line).toBeGreaterThan(0);
      }
    });

    it('should continue after unbalanced brace errors', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.define MACRO1 { nop
.define MACRO2 { nop }
  lda UndefinedAfterBrace
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile(
        [input],
        { lineContinuations: true, generateDebugInfo: true }
      );

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      // Should have error for unclosed brace AND error for undefined symbol
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.some(e => e.message.toLowerCase().includes('curly'))).toBe(true);
      expect(errors.some(e => e.message.includes('UndefinedAfterBrace'))).toBe(true);
    });

    it('should handle mix of errors and successful compilation of valid parts', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
ValidLabel:
  lda #$42
  sta InvalidDestination
  lda #$43
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('InvalidDestination'))).toBe(true);
    });

    it('should collect errors from bad directives', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.notarealdirective
.alsonotreal
  nop
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = await compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Data & storage directives', function() {
    it('.charmap remaps .byte-emitted string characters', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap $41, $01
  .byte "A"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x01]);
    });

    it('.asciiz emits the bytes then a terminating NUL', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .asciiz "hi"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x68, 0x69, 0x00]);
    });

    it('.align pads an absolute chunk up to the boundary', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .byte $01, $02, $03
  .align $10
  .byte $ff
`;
      const result = await compileSource(source);
      expect(Array.from(result.slice(0, 3))).toEqual([0x01, 0x02, 0x03]);
      expect(Array.from(result.slice(3, 16))).toEqual(new Array(13).fill(0));
      expect(result[16]).toBe(0xff);
    });

    it('.struct members yield byte offsets and .sizeof reports the total', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.struct Player
  xpos .byte
  ypos .byte
  hp   .word
.endstruct
  .byte Player::xpos, Player::ypos, Player::hp, .sizeof(Player)
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0, 1, 2, 4]);
    });

    it('.enum members auto-increment from zero', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.enum
  CMD_NOP
  CMD_MOVE
  CMD_JUMP
.endenum
  .byte CMD_NOP, CMD_MOVE, CMD_JUMP
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0, 1, 2]);
    });
  });

  describe('ca65 syntax compatibility', function() {
    it(':= assigns a constant like =', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
FOO := 5
  .byte FOO
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([5]);
    });

    it('accepts zeropage as an alias for the zp segment attribute', async function() {
      const source = `
.segment "ZP" :bank $00 :size $0100 :mem $0000 :off $0000 : zeropage
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0100
.org $8000
  .byte $42
`;
      const result = await compileSource(source);
      expect(result[0x100]).toBe(0x42);
    });

    it('rejects an unknown segment attribute', async function() {
      await expectCompileError(`
.segment "ZP" :bank $00 :size $0100 :mem $0000 :off $0000 : nonsense
`, 'Unknown segment attr');
    });
  });

  describe('Directive recognition', function() {
    it('.code / .rodata / .bss switch to the named segment', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.segment "RODATA" :bank $00 :size $0100 :mem $9000 :off $1000
.code
.org $8000
  .byte $11
.rodata
.org $9000
  .byte $22
`;
      const result = await compileSource(source);
      expect(result[0]).toBe(0x11);
      expect(result[0x1000]).toBe(0x22);
    });

    it('.export inside a .scope binds to that scope', async function() {
      const lib: AssemblyInput = {
        type: 'source',
        name: 'lib.s',
        code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8100
.scope BHOP
.export play
.proc play
  rts
.endproc
.endscope
`
      };
      const main: AssemblyInput = {
        type: 'source',
        name: 'main.s',
        code: `
.segment "CODE"
.import play
.org $8000
  jsr play
`
      };
      const result = await compile([main, lib], { lineContinuations: true });
      expect(result.success).toBe(true);
      const data = result.outputs[0].data;
      expect(data[0]).toBe(0x20); // JSR resolved, no "undefined symbol"
    });

    it('.importzp sizes references to one byte', async function() {
      const zp: AssemblyInput = {
        type: 'source',
        name: 'zp.s',
        code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.exportzp Var
Var = $10
`
      };
      const main: AssemblyInput = {
        type: 'source',
        name: 'main.s',
        code: `
.segment "CODE"
.importzp Var
.org $8000
  lda Var
`
      };
      const result = await compile([main, zp], { lineContinuations: true });
      expect(result.success).toBe(true);
      expect(Array.from(result.outputs[0].data.slice(0, 2))).toEqual([0xa5, 0x10]);
    });

    it('.global becomes an export when defined and an import when not', async function() {
      const lib: AssemblyInput = {
        type: 'source',
        name: 'lib.s',
        code: `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.global Helper
.org $8100
Helper:
  rts
`
      };
      const main: AssemblyInput = {
        type: 'source',
        name: 'main.s',
        code: `
.segment "CODE"
.global Helper
.org $8000
  jsr Helper
`
      };
      const result = await compile([main, lib], { lineContinuations: true });
      expect(result.success).toBe(true);
      const data = result.outputs[0].data;
      expect(Array.from(data.slice(0, 3))).toEqual([0x20, 0x00, 0x81]);
    });
  });

  describe('.strmap encoding', function() {
    it('maps a single-character key to a single byte', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "A", $42
  .byte "A"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x42]);
    });

    it('maps a multi-character key to a bracketed multi-byte sequence', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "the", [1, 2, 3]
  .byte "the"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it('maps a single character key to a single character output', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "t", "w"
  .byte "the"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([...'whe'].map(c => c.charCodeAt(0)));
    });

    it('maps a multi-character key to a multi character output', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "the", "what"
  .byte "the"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([...'what'].map(c => c.charCodeAt(0)));
    });

    it('matches the longest registered key, falling back to .charmap/identity for the rest', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "the", [1, 2, 3]
.strmap "cat", $09
  .byte "the cat"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([1, 2, 3, 0x20, 9]);
    });

    it('accepts a non-ASCII Unicode code point as a key', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "é", $ff
  .byte "café"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x63, 0x61, 0x66, 0xff]);
    });

    it('accepts any constant expression as a byte value, not just a literal', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
CONST_A = $10
CONST_B = CONST_A + 1
.org $8000
.strmap "x", [CONST_A, CONST_B]
  .byte "x"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x10, 0x11]);
    });

    it('.pushcharmap/.popcharmap save and restore .strmap together with .charmap', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "AB", $01
.pushcharmap
.strmap "AB", $02
.popcharmap
  .byte "AB"
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x01]);
    });

    it('rejects an empty key', async function() {
      await expectCompileError(`
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "", $01
`, '.strmap key must not be empty');
    });

    it('rejects an unterminated bracketed value list', async function() {
      await expectCompileError(`
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "x", [1, 2
`, '.strmap value list must end with ]');
    });
  });

  // Test for ca65 compatible character literal shenanigans
  describe('character literals', function() {
    it('encodes a character literal through the charmap in a later .charmap', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap 'a', $20
.charmap 'b', 'a'
  .byte "aabbcc"
`;
      // 'a' is already $20 when .charmap 'b', 'a' runs, so b maps to $20 too.
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0x20, 0x20, 0x20, 0x63, 0x63]);
    });

    it('is a number usable in arithmetic and in .word', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap 'a', $20
  .byte 'a'
  .byte 'a'+1
  .word 'a'
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0x21, 0x20, 0x00]);
    });

    it('is encoded when assigned to a symbol and when tested in .if', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap 'a', $20
FOO = 'a'
  .byte FOO
.if 'a' = $20
  .byte $ee
.else
  .byte $dd
.endif
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0xee]);
    });

    it('falls back to the raw code point when unmapped', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .byte 'a'
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x61]);
    });

    it('keeps double-quoted strings distinct from character literals', async function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap 'a', $20
  .byte "a"
  .byte 'a'
`;
      const result = await compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0x20]);
    });

    it('rejects a multi-character single-quoted literal in an expression', async function() {
      await expectCompileError(`
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .word 'ab'+1
`, 'Character literal must be one character');
    });
  });
});
