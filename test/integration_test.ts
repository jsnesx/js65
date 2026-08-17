
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {compile, compileRequest, deserializeObjectFile, type AssemblyInput, type FileCallbacks} from '../src/libassembler.ts';

function compileSource(source: string, filename: string = 'test.s'): Uint8Array {
  const input: AssemblyInput = { type: 'source', code: source, name: filename };
  const result = compile([input], { lineContinuations: true });
  if (!result.success) {
    throw new Error(`Expected compile result but got ${JSON.stringify(result)}`);
  }
  return result.outputs[0].data;
}

function compileWithBaseRom(source: string, baseRom: Uint8Array, filename: string = 'test.s'): Uint8Array {
  const initsrc: AssemblyInput = { type: 'source', name: 'init.s', code: `
.macpack common
.segment "HEADER" :bank $00 :size $0010 :mem $0000 :off $00000
.segment "PRG"    :bank $00 :size $8000 :mem $8000 :off $00010
.segment "CHR"    :bank $00 :size $2000 :mem $0000 :off $08010
FREE "PRG" [$8000, $10000)
`};
  const input: AssemblyInput = { type: 'source', code: source, name: filename };
  const result = compile([initsrc, input], { lineContinuations: true }, undefined, baseRom);
  return result.outputs[0].data;
}

function expectCompileError(source: string, errorMatch?: string | RegExp): Error {
  const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
  const result = compile([input], { lineContinuations: true });

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
    readText: (base, rel) => {
      const key = resolve(base, rel);
      if (!(key in text)) throw new Error(`ENOENT ${key}`);
      return text[key];
    },
    readBinary: (base, rel) => {
      const key = resolve(base, rel);
      if (!(key in bin)) throw new Error(`ENOENT ${key}`);
      return new Uint8Array(bin[key]);
    },
  };
}

function asmObject(input: AssemblyInput, opts: Parameters<typeof compile>[1], fs: FileCallbacks) {
  return compile([input], {...opts, outputFormat: 'object'}, fs);
}

describe('End to end test cases', function() {
  describe('compileRequest data handling', function() {
    it('returns a failure result (not a throw) for malformed JSON', function() {
      const result = compileRequest('{ not valid json');
      expect(result.success).toBe(false);
      expect(result.outputs).toEqual([]);
      expect(result.messages.some(m => m.level === 'error')).toBe(true);
    });

    it('returns a failure result (not a throw) for an invalid request shape', function() {
      const result = compileRequest(JSON.stringify({ inputs: 'not-an-array' }));
      expect(result.success).toBe(false);
      expect(result.messages.some(m => m.level === 'error' && /Invalid compile request/.test(m.message))).toBe(true);
    });

    it('compiles well-formed data', function() {
      const req = JSON.stringify({
        inputs: [{ type: 'source', name: 'test.s', code: '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\nlda #$42\n' }],
        options: { lineContinuations: true },
      });
      const result = compileRequest(req);
      expect(result.success).toBe(true);
      expect(result.outputs.find(o => o.type === 'binary')).toBeTruthy();
    });
  });

  describe('cancellation', function() {
    it('returns a cancelled failure result (not a throw) when the signal is already aborted', function() {
      const input: AssemblyInput = { type: 'source', name: 'test.s', code: '.org $8000\nlda #$42\n' };
      const result = compile([input], { lineContinuations: true }, undefined, undefined, { aborted: true });
      expect(result.success).toBe(false);
      expect(result.outputs).toEqual([]);
      expect(result.messages.some(m => m.level === 'error' && /cancelled/i.test(m.message))).toBe(true);
    });

    it('cancels mid-assembly at the per-line boundary', function() {
      // Stay un-aborted long enough to clear compile()'s top check and assemble()'s per-input
      // check, then trip inside the per-line tokens() loop.
      let polls = 0;
      const signal = { get aborted() { return polls++ > 1; } };
      const input: AssemblyInput = { type: 'source', name: 'test.s', code: 'lda #$01\nlda #$02\nlda #$03\nlda #$04\n' };
      const result = compile([input], { lineContinuations: true }, undefined, undefined, signal);
      expect(result.success).toBe(false);
      expect(result.messages.some(m => /cancelled/i.test(m.message))).toBe(true);
    });

    it('compileRequest forwards the cancel signal', function() {
      const req = JSON.stringify({
        inputs: [{ type: 'source', name: 'test.s', code: '.org $8000\nlda #$42\n' }],
        options: { lineContinuations: true },
      });
      const result = compileRequest(req, undefined, undefined, { aborted: true });
      expect(result.success).toBe(false);
      expect(result.messages.some(m => /cancelled/i.test(m.message))).toBe(true);
    });
  });

  describe('Real world tests', function() {
    it('should not cause an infinite loop in symbol resolution', function() {
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
      const result = compileSource(source);
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });

  });

  describe('.macpack common', function() {
    const SEG = '.segment "CODE" :bank $00 :size $0010 :mem $8000 :off $0000\n';

    it('should accept a FALLTHROUGH into the next address', function() {
      const result = compileSource(
          `.macpack common\n${SEG}.org $8000\n` +
          '  lda #1\n  FALLTHROUGH next\nnext:\n  rts\n');
      expect(Array.from(result.subarray(0, 3))).toEqual([0xa9, 0x01, 0x60]);
    });

    it('should reject a FALLTHROUGH that is not the next address',
       function() {
      // A forward target defers to the linker, which only keeps the expression
      // and so reports the generic text rather than the macro's message.
      expectCompileError(
          `.macpack common\n${SEG}.org $8000\n` +
          '  lda #1\n  FALLTHROUGH next\n  nop\nnext:\n  rts\n',
          'Assertion failed');
    });

    it('should report the FALLTHROUGH message for a backward target',
       function() {
      expectCompileError(
          `.macpack common\n${SEG}.org $8000\nprev:\n  rts\n` +
          '  FALLTHROUGH prev\n',
          'FALLTHROUGH target is not the next address');
    });
  });

  describe('Segment handling', function() {
    it('should handle multiple segments', function() {
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
      const result = compileSource(source);
      expect(result).toBeTruthy();
    });

    it('should handle .reloc for relocatable code', function() {
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
      const result = compileSource(source);
      expect(result).toBeTruthy();
    });

    it('should place anonymous segments sequentially', function() {
      const source = `
.segment $8000 :size $4000
Bank0Start:
  lda #$42
  rts

.segment $C000 :size $4000
  jsr Bank0Start
  rts
`;
      const result = compileSource(source);
      // Bank 0 goes to file offset 0, the fixed bank to $4000.
      expect([...result.slice(0, 3)]).toEqual([0xa9, 0x42, 0x60]);
      expect([...result.slice(0x4000, 0x4004)])
          .toEqual([0x20, 0x00, 0x80, 0x60]);
    });

    it('should resolve a label defined after .popseg in the popped segment',
       function() {
      // `.popseg` rewinds to a chunk that is no longer the newest one, so the
      // labels after it belong to that older chunk, not the pushed segment's.
      const source = `
.segment "A" :size $10 :mem $8000 :off $00 :fill $00
.segment "B" :size $10 :mem $9000 :off $10 :fill $00

.segment "A"
  .byte $01
.pushseg "B"
  .byte $02
.popseg
Label:
  .byte $03
  .word Label
`;
      const result = compileSource(source);
      expect([...result.slice(0, 4)]).toEqual([0x01, 0x03, 0x01, 0x80]);
      expect(result[0x10]).toBe(0x02);
    });

    it('should branch within the popped segment after .popseg',
       function() {
      const source = `
.segment "A" :size $10 :mem $8000 :off $00 :fill $00
.segment "B" :size $10 :mem $9000 :off $10 :fill $00

.segment "A"
Loop:
  nop
.pushseg "B"
  .byte $02
.popseg
  bne Loop
`;
      const result = compileSource(source);
      // The branch is relative to the next instruction in segment A.
      expect([...result.slice(0, 3)]).toEqual([0xea, 0xd0, 0xfd]);
    });

    it('should place two modules of anonymous segments in link order',
       function() {
      const first: AssemblyInput = {type: 'source', name: 'first.s', code: `
.segment $8000 :size $10
Exported:
  .byte $11
.export Exported
`};
      const second: AssemblyInput = {type: 'source', name: 'second.s', code: `
.segment $9000 :size $10
  .byte $22
  .word Exported
.import Exported
`};
      const result = compile([first, second], {lineContinuations: true});
      if (!result.success) {
        throw new Error(JSON.stringify(result.messages));
      }
      const data = result.outputs[0].data;
      expect(data[0]).toBe(0x11);
      // Second module's segment starts at file offset $10, and the cross-module
      // reference still resolves to the first module's CPU address.
      expect([...data.slice(0x10, 0x13)]).toEqual([0x22, 0x00, 0x80]);
    });

    it('should leave base ROM bytes alone without :fill', function() {
      const baseRom = new Uint8Array(0x20).fill(0xff);
      const input: AssemblyInput = {type: 'source', name: 'test.s', code: `
.segment $8000 :size $20
.org $8004
  .byte $11, $22
`};
      const result = compile([input], {lineContinuations: true},
                                   undefined, baseRom);
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      const data = result.outputs[0].data;
      expect([...data.slice(0x02, 0x08)])
          .toEqual([0xff, 0xff, 0x11, 0x22, 0xff, 0xff]);
    });

    it('should blank the whole bank with :fill', function() {
      // The documented way to add a new, empty bank when expanding a ROM.
      const baseRom = new Uint8Array(0x20).fill(0xff);
      const input: AssemblyInput = {type: 'source', name: 'test.s', code: `
.segment $8000 :size $20 :fill $00
.org $8004
  .byte $11, $22
`};
      const result = compile([input], {lineContinuations: true},
                                   undefined, baseRom);
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      const data = result.outputs[0].data;
      expect([...data.slice(0x02, 0x08)])
          .toEqual([0x00, 0x00, 0x11, 0x22, 0x00, 0x00]);
      expect(data.length).toBe(0x20);
    });

    it('should pack a later chunk into a .free range', function() {
      const source = `
.segment $8000 :size $20
  .byte $01, $02, $03, $04
.free $10

.reloc
Packed:
  .byte $aa, $bb
`;
      const result = compileSource(source);
      expect([...result.slice(0, 6)])
          .toEqual([0x01, 0x02, 0x03, 0x04, 0xaa, 0xbb]);
    });

    it('should report anonymous segments in the map file', function() {
      const input: AssemblyInput = {type: 'source', name: 'test.s', code: `
.segment $8000 :size $10
  .byte $01
.segment $8000 :size $10
  .byte $02
`};
      const result = compile(
          [input], {lineContinuations: true, generateMapFile: true,
                    generateDebugInfo: true});
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      const map = result.outputs.find(o => o.type === 'map');
      expect(map).toBeTruthy();
      const text = new TextDecoder().decode(map!.data);
      // Two banks at the same address, told apart by the line they were
      // declared on, with sequential file offsets.
      expect(text).toMatch(/@test\.s:2 \$8000\s+008000\s+00800F\s+000010\s+\S+\s+\S+\s+000000/);
      expect(text).toMatch(/@test\.s:4 \$8000\s+008000\s+00800F\s+000010\s+\S+\s+\S+\s+000010/);
    });
  });

  describe('mirror segments (&)', function() {
    it('should mirror a trampoline and vectors into every bank of a ' +
       'no-fixed-bank game', function() {
      const bankCount = 8;
      const declarations = Array.from({length: bankCount}, (_, i) =>
        `.segment "PRG${i}" :bank ${i} :size $8000 :mem $8000 :off ${
            '$' + (i * 0x8000).toString(16).padStart(5, '0')} :fill $00`);
      const mirrorList = Array.from({length: bankCount}, (_, i) => `"PRG${i}"`)
                         .join(' & ');
      const source = `
${declarations.join('\n')}
.segment ${mirrorList}
.reloc
Reset:
  lda #$42
  ldx #$43
Forever:
  jmp Forever
Nmi:
  pha
  sta $2000
  pla
  rti
Irq:
  lda #$99
  ldx #$77
  rti

.org $fffa
  .word Reset, Nmi, Irq

.segment "PRG0"
.org $8000
Test:
  lda #^Reset
  ldx #.bank(Reset)
  rts
`;
      const input: AssemblyInput = {type: 'source', code: source, name: 'game.s'};
      const result = compile([input], {lineContinuations: true});
      if (!result.success) {
        throw new Error(JSON.stringify(result.messages));
      }
      const data = result.outputs[0].data;
      expect(data.length).toBe(bankCount * 0x8000);
      // The mirrored code lands at org $8005 in every bank (PRG0's own $8000
      // probe takes the first 5 bytes), and the vectors at $fffa point at the
      // shared orgs of Reset ($8005), Nmi ($800c) and Irq ($8012).
      const mirrored = [
        0xa9, 0x42, 0xa2, 0x43,        // Reset:   lda #$42 / ldx #$43
        0x4c, 0x09, 0x80,              // Forever: jmp Forever
        0x48, 0x8d, 0x00, 0x20, 0x68, 0x40,  // Nmi: pha/sta $2000/pla/rti
        0xa9, 0x99, 0xa2, 0x77, 0x40,  // Irq:     lda #$99 / ldx #$77 / rti
      ];
      const vectors = [0x05, 0x80, 0x0c, 0x80, 0x12, 0x80];
      for (let bank = 0; bank < bankCount; bank++) {
        const base = bank * 0x8000;
        const tbase = base + 5;
        expect([...data.slice(tbase, tbase + mirrored.length)])
            .toEqual(mirrored);
        expect([...data.slice(base + 0x7ffa, base + 0x8000)]).toEqual(vectors);
      }
      // The bank probe lives in PRG0 only, at its own .org $8000: ^ and .bank
      // of a mirror label are 0, each with its own warning.
      expect([...data.slice(0, 5)]).toEqual([0xa9, 0x00, 0xa2, 0x00, 0x60]);
      // The other banks have nothing before the mirrored block.
      for (let bank = 1; bank < bankCount; bank++) {
        expect([...data.slice(bank * 0x8000, bank * 0x8000 + 5)])
            .toEqual([0, 0, 0, 0, 0]);
      }
      const warnings = result.messages.filter(m => m.level === 'warning');
      expect(warnings.length).toBe(2);
      expect(warnings.every(m => /bank/i.test(m.message))).toBe(true);
    });

    // The point of a named `:mirror`: a library module writes `.segment
    // "COMMON"` without knowing the bank names, and only the linker - which
    // sees every module - can expand the name into them.
    it('should mirror through a :mirror declared in another module', function() {
      const banks: AssemblyInput = {type: 'source', name: 'banks.s', code: `
.segment "PRG0" :bank 0 :size $10 :mem $8000 :off $00 :fill $00
.segment "PRG1" :bank 1 :size $10 :mem $8000 :off $10 :fill $00
.segment "COMMON" :mirror {"PRG0", "PRG1"}
`};
      const lib: AssemblyInput = {type: 'source', name: 'lib.s', code: `
.segment "COMMON"
.reloc
Trampoline:
  lda #$42
  rts
`};
      const result = compile([lib, banks], {lineContinuations: true});
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      const data = result.outputs[0].data;
      expect(data.length).toBe(0x20);
      const code = [0xa9, 0x42, 0x60];
      expect([...data.slice(0x00, 0x03)]).toEqual(code);
      expect([...data.slice(0x10, 0x13)]).toEqual(code);
    });
  });

  describe('pool segments (:pool)', function() {
    const banks = [
      '.segment "PRG0" :bank 0 :size 8 :mem $8000 :off $00 :fill $00',
      '.segment "PRG1" :bank 1 :size 8 :mem $8000 :off $08 :fill $00',
    ].join('\n');
    const body = (seg: string) => [
      `.segment ${seg}`, '  .byte 1,1,1,1',
      `.segment ${seg}`, '  .byte 2,2,2',
      `.segment ${seg}`, '  .byte 3,3,3',
    ].join('\n');
    const build = (code: string) => {
      const input: AssemblyInput = {type: 'source', code, name: 'pool.s'};
      const result = compile([input], {lineContinuations: true});
      if (!result.success) throw new Error(JSON.stringify(result.messages));
      return [...result.outputs[0].data];
    };

    // `:pool` names a list; it must not become a second placement engine.
    it('should place a :pool list the same as the equivalent comma list',
       function() {
      const pool = build(
          `${banks}\n.segment "MUSIC" :pool {"PRG0", "PRG1"}\n${body('"MUSIC"')}`);
      expect(pool).toEqual(build(`${banks}\n${body('"PRG0", "PRG1"')}`));
      // Two overlapping banks packed as one pool: 4+3 fill PRG0, and the
      // last 3 spill into PRG1 rather than opening a hole in PRG0.
      expect(pool).toEqual([1, 1, 1, 1, 2, 2, 2, 0, 3, 3, 3, 0, 0, 0, 0, 0]);
    });

    it('should place a :pool the same however its members are ordered',
       function() {
      const forward = build(
          `${banks}\n.segment "MUSIC" :pool {"PRG0", "PRG1"}\n${body('"MUSIC"')}`);
      const reversed = build(
          `${banks}\n.segment "MUSIC" :pool {"PRG1", "PRG0"}\n${body('"MUSIC"')}`);
      expect(reversed).toEqual(forward);
    });
  });

  describe('ROM patching with base ROM', function() {
    it('should patch specific locations in base ROM', function() {
      // Create a base ROM filled with $FF
      const baseRom = new Uint8Array(0x8010).fill(0xFF);

      const source = `
.segment "PRG"
.org $8000
  lda #$42
`;
      const result = compileWithBaseRom(source, baseRom);

      // Check that the patch was applied at offset $10 (after header)
      expect(result[0x10]).toBe(0xA9); // lda immediate
      expect(result[0x11]).toBe(0x42);
      // Rest should still be $FF
      expect(result[0x13]).toBe(0xFF);
    });

    it('should handle multiple patches to base ROM', function() {
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
      const result = compileWithBaseRom(source, baseRom);

      expect(result[0x10]).toBe(0xAA);      // $8000 -> offset $10
      expect(result[0x110]).toBe(0xBB);     // $8100 -> offset $110
      expect(result[0x4010]).toBe(0xCC);    // $C000 -> offset $4010
    });
  });

  describe('Error handling', function() {
    it('should report undefined symbol errors', function() {
      const source = `
.segment "PRG"
.org $8000
  lda UndefinedSymbol
`;
      expectCompileError(source, 'UndefinedSymbol');
    });

    it('should report branch out of range errors', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  beq FarLabel
.org $8200
FarLabel:
  rts
`;
      expectCompileError(source, /branch|range/i);
    });

    it('should report duplicate label errors', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
DuplicateLabel:
  nop
DuplicateLabel:
  rts
`;
      expectCompileError(source, /duplicate|redefin/i);
    });
  });

  describe('Multi-module linking', function() {
    it('should link multiple modules with imports/exports', function() {
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

      const result = compile([mainModule, helperModule], { lineContinuations: true });
      const data = result.outputs[0].data;
      expect(data).toBeTruthy();

      // Main should have JSR to $8100
      expect(data[0]).toBe(0x20); // JSR
      expect(data[1]).toBe(0x00); // low byte of $8100
      expect(data[2]).toBe(0x81); // high byte of $8100
    });

    it('should handle circular imports between modules', function() {
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

      const result = compile([moduleA, moduleB], { lineContinuations: true });
      expect(result.outputs[0].data).toBeTruthy();
    });
  });

  describe('IPS patch generation', function() {
    it('should generate valid IPS patch format', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  lda #$42
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true, outputFormat: 'ips' });
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
    it('should generate debug info when requested', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000

TestLabel:
  lda #$42
  rts
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile(
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
      readText: (base: string, file: string) => {
        if (base !== 'inc') throw new Error(`ENOENT ${base}/${file}`);
        return '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n';
      },
      readBinary: (): never => { throw new Error('no binaries in this test'); },
    };

    it('reports a missing include as an error rather than succeeding silently', function() {
      const input: AssemblyInput = { type: 'source', code: '.include "nope.s"\n  nop\n', name: 'test.s' };
      const result = compile([input], { includePaths: ['missing'] }, callbacks);

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('Could not find file nope.s');
      // The diagnostic points at the .include line, not at the assembler as a whole.
      expect(errors[0].source?.file).toBe('test.s');
      expect(errors[0].source?.line).toBe(1);
    });

    it('falls through to later include directories', function() {
      const input: AssemblyInput = { type: 'source', code: '.include "found.s"\n  nop\n', name: 'test.s' };
      const result = compile([input], { includePaths: ['missing', 'inc'] }, callbacks);

      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('keeps diagnostics collected before the failure', function() {
      const source = '.warning "earlier warning"\n.include "nope.s"\n';
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { includePaths: ['missing'] }, callbacks);

      expect(result.success).toBe(false);
      expect(result.messages.filter(m => m.level === 'warning').map(m => m.message))
          .toEqual(['earlier warning']);
    });
    it('resolves nested .include relative to the including file', () => {
      const fs = makeFs({
        'prg/sub/inner.inc': '.include "leaf.inc"\n',
        'prg/sub/leaf.inc': 'lda #1\n',
      });
      const result = asmObject(
        {type: 'source', code: '.include "sub/inner.inc"\n', name: 'prg/stub.s'},
        {}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('falls through every -I directory, not just the first', () => {
      const fs = makeFs({ 'inc2/common.inc': 'lda #2\n' });
      const result = asmObject(
        {type: 'source', code: '.include "common.inc"\n', name: 'main.s'},
        {includePaths: ['inc1', 'inc2']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('uses --bin-include-dir (binIncludePaths) for .incbin', () => {
      const fs = makeFs(
        {},
        { 'art/data.bin': [0xAA, 0xBB, 0xCC] });
      const result = asmObject(
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

    it('resolves a top-level file\'s includes against that file\'s directory', () => {
      // `js65 bhop/bhop.s` run from the parent of bhop/: `.include "bhop/commands.asm"`
      // has to land on bhop/bhop/commands.asm, not on the cwd-relative bhop/commands.asm.
      const fs = makeFs({
        'bhop/bhop/commands.asm': 'lda #1\n',
        'bhop/bhop/util.asm': '.include "helpers.inc"\n',
        'bhop/bhop/helpers.inc': 'lda #2\n',
      });
      const result = asmObject(
        {type: 'source',
         code: '.include "bhop/commands.asm"\n.include "bhop/util.asm"\n',
         name: 'bhop/bhop.s'},
        {}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('accepts backslash separators in the source name and in -I directories', () => {
      const fs = makeFs({
        'prg/sub/inner.inc': '.include "leaf.inc"\n',
        'prg/sub/leaf.inc': 'lda #1\n',
        'vendor/inc/common.inc': 'lda #2\n',
      });
      const result = asmObject(
        {type: 'source',
         code: '.include "sub/inner.inc"\n.include "common.inc"\n',
         name: 'prg\\stub.s'},
        {includePaths: ['vendor\\inc']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('resolves an include relative to an -I directory it was found in', () => {
      // common.inc is only reachable via -I; its own `.include` is relative to itself,
      // so the search has to remember which base the file actually came from.
      const fs = makeFs({
        'vendor/common.inc': '.include "detail/impl.inc"\n',
        'vendor/detail/impl.inc': '.include "leaf.inc"\n',
        'vendor/detail/leaf.inc': 'lda #3\n',
      });
      const result = asmObject(
        {type: 'source', code: '.include "common.inc"\n', name: 'main.s'},
        {includePaths: ['vendor']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('keeps absolute -I directories absolute when resolving nested includes', () => {
      const fs = makeFs({
        '/opt/inc/common.inc': '.include "leaf.inc"\n',
        '/opt/inc/leaf.inc': 'lda #4\n',
      });
      const result = asmObject(
        {type: 'source', code: '.include "common.inc"\n', name: 'main.s'},
        {includePaths: ['/opt/inc']}, fs);
      expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('lists each include directory once in the diagnostic', () => {
      const fs = makeFs({});
      const result = asmObject(
        {type: 'source', code: '.include "nope.inc"\n', name: 'inc/main.s'},
        {includePaths: ['inc', 'inc', 'other']}, fs);
      expect(result.success).toBe(false);
      const msg = result.messages.find(m => /Could not find file nope\.inc/.test(m.message));
      expect(msg?.message).toContain('inc,other');
    });

    it('reports the search list when a file is genuinely missing', () => {
      const fs = makeFs({});
      const result = asmObject(
        {type: 'source', code: '.include "nope.inc"\n', name: 'main.s'},
        {includePaths: ['a', 'b']}, fs);
      expect(result.success).toBe(false);
      expect(result.messages.some(m => /Could not find file nope\.inc/.test(m.message))).toBe(true);
    });
  });

  describe('Multi-error collection', function() {
    it('should collect multiple assembly errors from different lines', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  lda UndefinedSymbol1
  sta UndefinedSymbol2
  jsr UndefinedSymbol3
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(3);
      expect(errors.some(e => e.message.includes('UndefinedSymbol1'))).toBe(true);
      expect(errors.some(e => e.message.includes('UndefinedSymbol2'))).toBe(true);
      expect(errors.some(e => e.message.includes('UndefinedSymbol3'))).toBe(true);
    });

    it('should collect multiple duplicate label errors', function() {
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
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.some(e => e.message.includes('MyLabel'))).toBe(true);
      expect(errors.some(e => e.message.includes('AnotherLabel'))).toBe(true);
    });

    it('should collect errors from multiple input files', function() {
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

      const result = compile([file1, file2], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.some(e => e.message.includes('MissingFromFile1'))).toBe(true);
      expect(errors.some(e => e.message.includes('MissingFromFile2'))).toBe(true);
    });

    it('should collect multiple unresolved import errors during linking', function() {
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

      const result = compile(
        [module1], { lineContinuations: true, generateDebugInfo: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(3);
      // Every missing import is named, each exactly once, and points at the
      // line that used it.
      for (const name of ['MissingFunc1', 'MissingFunc2', 'MissingFunc3']) {
        const matches = errors.filter(e => e.message.includes(name));
        expect(matches.length).toBe(1);
        expect(matches[0].message).toBe(`Symbol never exported ${name}`);
        expect(matches[0].source?.file).toBe('main.s');
      }
    });

    it('should collect multiple unplaceable chunks', function() {
      const source = `
.segment "CODE" :bank $00 :size $30 :mem $8000 :off $0000 :fill
.segment "CODE"
.reloc
one:
  .res 40
.reloc
two:
  .res 40
.reloc
three:
  .res 40
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile(
        [input], { lineContinuations: true, generateDebugInfo: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(
        m => m.level === 'error' && m.message.includes('Could not find space'));
      // The first chunk fits; the other two are both reported.
      expect(errors.length).toBe(2);
      expect(errors.every(e => e.source?.line != null)).toBe(true);
    });

    it('should collect multiple failing link-time asserts', function() {
      const source = `
.segment "CODE" :bank $00 :size $100 :mem $8000 :off $0000 :fill
.segment "CODE"
.reloc
lbl1:
  rts
.reloc
lbl2:
  rts
.assert lbl1 > $9000, error, "lbl1 too low"
.assert lbl2 > $9000, error, "lbl2 too low"
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile(
        [input], { lineContinuations: true, generateDebugInfo: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(
        m => m.level === 'error' && m.message.includes('Assertion failed'));
      expect(errors.length).toBe(2);
      expect(errors.map(e => e.source?.line)).toEqual([10, 11]);
    });

    it('should collect every parse error in a file', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .segment 12345
  .byte 1,,2
  lda #(1+
  nop nop
  rts
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile(
        [input], { lineContinuations: true, generateDebugInfo: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.map(e => e.message)).toEqual([
        // A numeric `.segment` is the anonymous form, so this is now the
        // missing-`:size` error rather than "expected a string".
        'An anonymous .segment requires :size',
        'Missing term',
        'No close paren: (',
        'Bad address mode add for nop',
      ]);
      // One error per source line, in order.
      expect(errors.map(e => e.source?.line)).toEqual([4, 5, 6, 7]);
    });

    it('should locate errors identically with and without debug info',
       function() {
      // `generateDebugInfo` controls what gets written out, not whether source
      // locations are tracked so diagnostics have to point at a line either way.
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .byte 1,,2
  lda #(1+
  nop nop
  rts
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const locations = (generateDebugInfo: boolean) => {
        const result = compile(
          [input], { lineContinuations: true, generateDebugInfo });
        expect(result.success).toBe(false);
        return result.messages.filter(m => m.level === 'error')
            .map(m => `${m.message} @ ${m.source?.file}:${m.source?.line}`);
      };

      expect(locations(false)).toEqual([
        'Missing term @ test.s:4',
        'No close paren: ( @ test.s:5',
        'Bad address mode add for nop @ test.s:6',
      ]);
      expect(locations(false)).toEqual(locations(true));
    });

    it('should collect expression evaluation errors and keep going', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .byte 1/0
  .byte .strat("a", 9)
  lda StillAssembled
  rts
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile(
        [input], { lineContinuations: true, generateDebugInfo: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      const divide = errors.find(e => e.message === 'Division by zero');
      expect(divide?.source?.line).toBe(4);
      const strat = errors.find(e => e.message === '.strat index out of range');
      expect(strat?.source?.line).toBe(5);
      // The lines after the failures were still assembled.
      expect(errors.some(e => e.message.includes('StillAssembled'))).toBe(true);
    });

    it('should stop after too many errors', function() {
      const lines = [
        '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000',
        '.org $8000',
      ];
      for (let i = 0; i < 40; i++) lines.push(`  lda Undefined${i}`);

      const input: AssemblyInput = {
        type: 'source', code: lines.join('\n'), name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBe(31);
      expect(errors[30].message).toBe('too many errors (30); stopping');
      expect(errors.slice(0, 30).every(e => /^Symbol 'Undefined\d+' undefined$/
                                                .test(e.message))).toBe(true);
    });

    it('should include source location in error messages', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  nop
  nop
  lda UndefinedHere
  nop
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'location_test.s' };
      const result = compile(
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

    it('should continue after unbalanced brace errors', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.define MACRO1 { nop
.define MACRO2 { nop }
  lda UndefinedAfterBrace
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile(
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

    it('should handle mix of errors and successful compilation of valid parts', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
ValidLabel:
  lda #$42
  sta InvalidDestination
  lda #$43
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('InvalidDestination'))).toBe(true);
    });

    it('should collect errors from bad directives', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.notarealdirective
.alsonotreal
  nop
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });

    it('should keep going after an unknown mnemonic', function() {
      // An unknown mnemonic used to surface as a plain Error, which the
      // assembler treats as an internal fault and rethrows, so the first typo
      // in a file hid every error after it.
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  lda #$01
  bogusinstr
  otherbogus
  lda Undefined
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.map(e => `${e.message} @ ${e.source?.line}`)).toEqual([
        'Bad mnemonic: bogusinstr @ 5',
        'Bad mnemonic: otherbogus @ 6',
        `Symbol 'Undefined' undefined @ 7`,
      ]);
    });

    it('should keep going after a tokenizer error', function() {
      // A character the tokenizer can't read threw out of the preprocessor and
      // abandoned the whole assemble. It should cost the offending line only.
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  \` stray
  lda #$01
  bogusinstr
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.map(e => `${e.message} @ ${e.source?.line}`)).toEqual([
        `Syntax error: unexpected '\`' @ 4`,
        'Bad mnemonic: bogusinstr @ 6',
      ]);
    });

    it('should resync past constructs that span physical lines', function() {
      // A source line is not a physical line. Resyncing on the next newline
      // would restart inside the block comment and inside the continuation,
      // tokenizing prose as code; only the two real errors should survive.
      const source = `
.segment "CODE" :bank $00 :off $0000 :size $8000 :mem $8000
.org $8000
  \` /* not: code
  still not code */
  \` lda \\
     #$01
  bogusinstr
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile(
          [input], { lineContinuations: true, cComments: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.map(e => `${e.message} @ ${e.source?.line}`)).toEqual([
        `Syntax error: unexpected '\`' @ 4`,
        `Syntax error: unexpected '\`' @ 6`,
        'Bad mnemonic: bogusinstr @ 8',
      ]);
    });

    it('should keep going after a preprocessor error', function() {
      // `.ifdef` with no argument fails in the preprocessor, which used to
      // propagate out of the assemble and drop the rest of the file.
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .ifdef
  .endif
  bogusinstr
  lda Undefined
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.some(e => /Expected expression/.test(e.message))).toBe(true);
      expect(errors.some(e => e.message === 'Bad mnemonic: bogusinstr')).toBe(true);
      expect(errors.some(e => e.message.includes('Undefined'))).toBe(true);
    });

    it('should treat a broken .if condition as false and keep the block intact',
       function() {
      // ca65 reports the error and yields 0 in this case, so the block
      // still nests. Evaluating the condition before consuming the block turned
      // one typo into four errors: the bad condition, a dangling `.else` and
      // `.endif`, and whatever the leaked-through body referenced.
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.if UndefinedCondition
  lda NeverAssembled
.else
  lda #1
.endif
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.map(e => `${e.message} @ ${e.source?.line}`)).toEqual([
        'Expected a constant: symbol UndefinedCondition @ 4',
      ]);
    });

    it('should keep assembling after a broken conditional block',
       function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.if BadOne
  nop
.endif
.if BadTwo
  nop
.endif
  bogusinstr
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      expect(errors.map(e => `${e.message} @ ${e.source?.line}`)).toEqual([
        'Expected a constant: symbol BadOne @ 4',
        'Expected a constant: symbol BadTwo @ 7',
        'Bad mnemonic: bogusinstr @ 10',
      ]);
    });

    it('should locate an unterminated conditional at its opening directive',
       function() {
      // Unlocated messages get dropped by hosts that bucket diagnostics per
      // file, so this has to point at the `.if` that was never closed.
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .if 1
  nop
`;
      const input: AssemblyInput = { type: 'source', code: source, name: 'test.s' };
      const result = compile([input], { lineContinuations: true });

      expect(result.success).toBe(false);
      const errors = result.messages.filter(m => m.level === 'error');
      const eof = errors.find(e => /EOF looking for \.endif/.test(e.message));
      expect(eof?.source).toMatchObject({file: 'test.s', line: 4});
    });
  });

  // A constant assigned from a label that hasn't been reached yet holds a
  // reference to the label's symbol table slot. Once the label lands the slot
  // has a value, and a difference of two such constants is a constant again.
  describe('Forward-referenced labels in a constant expression', function() {
    it('should fold a difference of constants built from a forward-referenced label',
       function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
low = base + 1
high = base + 3
base:
.if high - low > 0
  .byte $ee
.else
  .byte $dd
.endif
`;
      expect(Array.from(compileSource(source))).toEqual([0xee]);
    });

    it('should fold the same difference the other way round', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
low = base + 3
high = base + 1
base:
.if high - low > 0
  .byte $ee
.else
  .byte $dd
.endif
`;
      expect(Array.from(compileSource(source))).toEqual([0xdd]);
    });

    it('should fold a difference of two forward-referenced labels', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
first:
  .byte $01, $02
second:
.if second - first = 2
  .byte $ee
.else
  .byte $dd
.endif
`;
      expect(Array.from(compileSource(source))).toEqual([0x01, 0x02, 0xee]);
    });

    it('should still reject a difference whose label is never defined',
       function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
low = missing + 1
high = missing + 3
.if high - low > 0
  .byte $ee
.endif
`;
      expectCompileError(source, /Expected a constant/);
    });
  });

  describe('Data & storage directives', function() {
    it('.charmap remaps .byte-emitted string characters', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap $41, $01
  .byte "A"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x01]);
    });

    it('.asciiz emits the bytes then a terminating NUL', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .asciiz "hi"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x68, 0x69, 0x00]);
    });

    it('.align pads an absolute chunk up to the boundary', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .byte $01, $02, $03
  .align $10
  .byte $ff
`;
      const result = compileSource(source);
      expect(Array.from(result.slice(0, 3))).toEqual([0x01, 0x02, 0x03]);
      expect(Array.from(result.slice(3, 16))).toEqual(new Array(13).fill(0));
      expect(result[16]).toBe(0xff);
    });

    it('.align constrains where the linker puts a relocatable chunk', function() {
      const source = `
.segment "CODE" :bank $00 :size $40 :mem $8000 :off $0000 :fill $ff
.reloc
  .byte $01, $01, $01
.reloc
  .align $10
  .byte $02, $02
.reloc
  .byte $03, $03, $03, $03, $03, $03, $03, $03
`;
      const result = compileSource(source);
      // Biggest chunk first, then the 3-byte one, and the aligned chunk skips
      // to $8010 - leaving the bytes in between to the segment's fill.
      expect(Array.from(result.slice(0, 18))).toEqual([
        3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 2, 2,
      ]);
    });

    it('.struct members yield byte offsets and .sizeof reports the total', function() {
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
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0, 1, 2, 4]);
    });

    it('.enum members auto-increment from zero', function() {
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
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0, 1, 2]);
    });

    it('.enum members continue counting from an explicit value', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.enum
  CMD_NOP
  CMD_MOVE = 10
  CMD_JUMP
.endenum
  .byte CMD_NOP, CMD_MOVE, CMD_JUMP
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0, 10, 11]);
    });

    it('.enum counts up from a negative start and allows aliases', function() {
      // The example straight out of the ca65 manual.
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.enum
  EUNKNOWN = -1
  EOK
  EFILE
  EBUSY
  EAGAIN
  EWOULDBLOCK = EAGAIN
.endenum
  .byte <EUNKNOWN, EOK, EFILE, EBUSY, EAGAIN, EWOULDBLOCK
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0xff, 0, 1, 2, 3, 3]);
    });

    it('a named .enum takes explicit values through its scope', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.enum T
  A
  B = 5
  C
  D = T::C
.endenum
  .byte T::A, T::B, T::C, T::D, .sizeof(T)
`;
      const result = compileSource(source);
      // Four members declared, so `.sizeof` stays the member count even though
      // the values jump around.
      expect(Array.from(result)).toEqual([0, 5, 6, 6, 4]);
    });

    it('.enum takes an explicit value from an expression', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
BASE = 20
.enum
  A = BASE * 2
  B
.endenum
  .byte A, B
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([40, 41]);
    });

    it('an .enum value that is not yet constant is an error', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.enum
  A = LATER
.endenum
LATER = 3
  .byte A
`;
      expectCompileError(source, `needs a constant value`);
    });
  });

  describe('ca65 syntax compatibility', function() {
    it(':= assigns a constant like =', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
FOO := 5
  .byte FOO
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([5]);
    });

    it('builds a scope chain out of `::` a segment at a time', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.scope L1
  .scope L2
    .scope L3
      Val = $61
    .endscope
  .endscope
.endscope
.define Head L1
.define Mid L2
.define Tail L3
.define Path L1::L2
  .byte L1::L2::L3::Val
  .byte ::L1::L2::L3::Val
  .byte Head::Mid::Tail::Val
  .byte Path::L3::Val
  .byte L1::.ident("L2")::L3::Val
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x61, 0x61, 0x61, 0x61, 0x61]);
    });

    it('reads `::` after an opcode as the global scope, not a chain',
       function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
Target = $42
  lda #::Target
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0xa9, 0x42]);
    });

    it('accepts zeropage as an alias for the zp segment attribute', function() {
      const source = `
.segment "ZP" :bank $00 :size $0100 :mem $0000 :off $0000 : zeropage
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0100
.org $8000
  .byte $42
`;
      const result = compileSource(source);
      expect(result[0x100]).toBe(0x42);
    });

    it('rejects an unknown segment attribute', function() {
      expectCompileError(`
.segment "ZP" :bank $00 :size $0100 :mem $0000 :off $0000 : nonsense
`, 'Unknown segment attr');
    });
  });
  describe('leading_dot_in_identifiers', function() {
    it('defines and calls a macro whose name starts with a dot',
        function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.feature leading_dot_in_identifiers
.macro .t This
.addr This-1
.endmacro
.macro .b InpA, InpB
.byt ( InpA<<4 ) | InpB
.endmacro
Target = $8123
.t Target
.B 3, 7
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x22, 0x81, 0x37]);
    });

    it('takes a dotted name anywhere a symbol goes', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.feature leading_dot_in_identifiers
.foo = $11
.scope Sc
.bar = $22
.endscope
.define .baz $33
.proc .pr
.byte $44
.endproc
.byte .foo, Sc::.bar, .baz, .pr - $8000
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x44, 0x11, 0x22, 0x33, 0x00]);
    });

    it('keeps a dotted name distinct from the undotted one',
        function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.feature leading_dot_in_identifiers
.foo = $11
foo = $22
.byte .foo, foo
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x11, 0x22]);
    });

    it('never lets a dotted name shadow a control command', function() {
      expectCompileError(`
.feature leading_dot_in_identifiers
.macro .byt Value
.byte Value
.endmacro
`, 'Expected identifier');
    });
    it('keeps a dotted name distinct from the undotted one',
        function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.feature leading_dot_in_identifiers
.foo = $11
foo = $22
.byte .foo, foo
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x11, 0x22]);
    });

    it('never lets a dotted name shadow a control command', function() {
      expectCompileError(`
.feature leading_dot_in_identifiers
.macro .byt Value
.byte Value
.endmacro
`, 'Expected identifier');
    });

    it('reports an unknown dot word again once the feature is off',
        function() {
      expectCompileError(`
.feature leading_dot_in_identifiers
.feature leading_dot_in_identifiers off
.test $1234
`, 'Unknown directive: .test');
    });
  });
  describe('Directive recognition', function() {
    it('.code / .rodata / .bss switch to the named segment', function() {
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
      const result = compileSource(source);
      expect(result[0]).toBe(0x11);
      expect(result[0x1000]).toBe(0x22);
    });

    it('.export inside a .scope binds to that scope', function() {
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
      const result = compile([main, lib], { lineContinuations: true });
      expect(result.success).toBe(true);
      const data = result.outputs[0].data;
      expect(data[0]).toBe(0x20); // JSR resolved, no "undefined symbol"
    });

    it('.importzp sizes references to one byte', function() {
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
      const result = compile([main, zp], { lineContinuations: true });
      expect(result.success).toBe(true);
      expect(Array.from(result.outputs[0].data.slice(0, 2))).toEqual([0xa5, 0x10]);
    });

    it('.global becomes an export when defined and an import when not', function() {
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
      const result = compile([main, lib], { lineContinuations: true });
      expect(result.success).toBe(true);
      const data = result.outputs[0].data;
      expect(Array.from(data.slice(0, 3))).toEqual([0x20, 0x00, 0x81]);
    });
  });

  describe('.strmap encoding', function() {
    it('maps a single-character key to a single byte', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "A", $42
  .byte "A"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x42]);
    });

    it('maps a multi-character key to a bracketed multi-byte sequence', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "the", [1, 2, 3]
  .byte "the"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it('maps a single character key to a single character output', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "t", "w"
  .byte "the"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([...'whe'].map(c => c.charCodeAt(0)));
    });

    it('maps a multi-character key to a multi character output', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "the", "what"
  .byte "the"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([...'what'].map(c => c.charCodeAt(0)));
    });

    it('matches the longest registered key, falling back to .charmap/identity for the rest', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "the", [1, 2, 3]
.strmap "cat", $09
  .byte "the cat"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([1, 2, 3, 0x20, 9]);
    });

    it('accepts a non-ASCII Unicode code point as a key', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "é", $ff
  .byte "café"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x63, 0x61, 0x66, 0xff]);
    });

    it('accepts any constant expression as a byte value, not just a literal', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
CONST_A = $10
CONST_B = CONST_A + 1
.org $8000
.strmap "x", [CONST_A, CONST_B]
  .byte "x"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x10, 0x11]);
    });

    it('.pushcharmap/.popcharmap save and restore .strmap together with .charmap', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "AB", $01
.pushcharmap
.strmap "AB", $02
.popcharmap
  .byte "AB"
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x01]);
    });

    it('rejects an empty key', function() {
      expectCompileError(`
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "", $01
`, '.strmap key must not be empty');
    });

    it('rejects an unterminated bracketed value list', function() {
      expectCompileError(`
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.strmap "x", [1, 2
`, '.strmap value list must end with ]');
    });
  });

  // Test for ca65 compatible character literal shenanigans
  describe('character literals', function() {
    it('encodes a character literal through the charmap in a later .charmap', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap 'a', $20
.charmap 'b', 'a'
  .byte "aabbcc"
`;
      // 'a' is already $20 when .charmap 'b', 'a' runs, so b maps to $20 too.
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0x20, 0x20, 0x20, 0x63, 0x63]);
    });

    it('is a number usable in arithmetic and in .word', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap 'a', $20
  .byte 'a'
  .byte 'a'+1
  .word 'a'
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0x21, 0x20, 0x00]);
    });

    it('is encoded when assigned to a symbol and when tested in .if', function() {
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
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0xee]);
    });

    it('falls back to the raw code point when unmapped', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .byte 'a'
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x61]);
    });

    it('keeps double-quoted strings distinct from character literals', function() {
      const source = `
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
.charmap 'a', $20
  .byte "a"
  .byte 'a'
`;
      const result = compileSource(source);
      expect(Array.from(result)).toEqual([0x20, 0x20]);
    });

    it('rejects a multi-character single-quoted literal in an expression', function() {
      expectCompileError(`
.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000
.org $8000
  .word 'ab'+1
`, 'Character literal must be one character');
    });
  });
});
