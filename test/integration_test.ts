
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {compile, type AssemblyInput} from '../src/libassembler.ts';
import {SourceContents} from '../src/tokenstream.ts';

async function compileSource(source: string, filename: string = 'test.s'): Promise<Uint8Array> {
  const input: AssemblyInput = { type: 'source', code: source, name: filename };
  const result = await compile([input], { lineContinuations: true }, {}, 'binary');
  return result.data;
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
  const result = await compile([initsrc, input], { lineContinuations: true }, { baseRom }, 'binary');
  return result.data;
}

async function expectCompileError(source: string, errorMatch?: string | RegExp): Promise<Error> {
  const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
  const result = await compile([input], { lineContinuations: true }, {}, 'binary');

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

describe('End to end test cases', function() {
  describe('Forward defined labels from macros', function() {
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

      const result = await compile([mainModule, helperModule], { lineContinuations: true }, {}, 'binary');
      expect(result.data).toBeTruthy();

      // Main should have JSR to $8100
      expect(result.data[0]).toBe(0x20); // JSR
      expect(result.data[1]).toBe(0x00); // low byte of $8100
      expect(result.data[2]).toBe(0x81); // high byte of $8100
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

      const result = await compile([moduleA, moduleB], { lineContinuations: true }, {}, 'binary');
      expect(result.data).toBeTruthy();
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
      const result = await compile([input], { lineContinuations: true }, {}, 'ips');

      // IPS header is "PATCH"
      expect(result.data[0]).toBe(0x50); // 'P'
      expect(result.data[1]).toBe(0x41); // 'A'
      expect(result.data[2]).toBe(0x54); // 'T'
      expect(result.data[3]).toBe(0x43); // 'C'
      expect(result.data[4]).toBe(0x48); // 'H'
    });
  });

  describe('Debug info generation', function() {
    it('should generate debug info when requested', async function() {
      const sourceContents = new SourceContents();
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
        { lineContinuations: true, generateDebugInfo: true },
        { debugLevel: 0 },
        'binary',
        undefined,
        sourceContents
      );

      expect(result.debugInfo).toBeTruthy();
      expect(result.debugInfo).toContain('TestLabel');
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
      const result = await compile([input], { lineContinuations: true }, {}, 'binary');

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
      const result = await compile([input], { lineContinuations: true }, {}, 'binary');

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

      const result = await compile([file1, file2], { lineContinuations: true }, {}, 'binary');

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

      const result = await compile([module1], { lineContinuations: true }, {}, 'binary');

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
        { lineContinuations: true, generateDebugInfo: true },
        {},
        'binary'
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
        { lineContinuations: true, generateDebugInfo: true },
        {},
        'binary'
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
      const result = await compile([input], { lineContinuations: true }, {}, 'binary');

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
      const result = await compile([input], { lineContinuations: true }, {}, 'binary');

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});
