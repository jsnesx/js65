
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {describe, it, expect} from 'bun:test';
import {MesenLabelFormat} from '../src/linker.ts';
import {compile} from '../src/libassembler.ts';
import {SourceContents} from '../src/tokenstream.ts';

async function assembleAndGetDebugInfo(source: string, filename: string = 'test.s', debugLevel: number = 0): Promise<MesenLabelFormat[]> {
  const sourceContents = new SourceContents();
  const opts = {
    lineContinuations: true,
    generateDebugInfo: true
  };

  const initsrc = { type: 'source' as const, name: 'init.s', code: `
.macpack common
.segment "HEADER" :bank $00 :size $0010 :mem $0000 :off $00000
.segment "PRG"    :bank $00 :size $8000 :mem $8000 :off $00010
.segment "CHR"    :bank $00 :size $2000 :mem $0000 :off $08010
FREE "PRG" [$8000, $10000)
`};

  const modulesrc = { type: 'source' as const, name: filename, code: source };

  const linkerOpts = {
    debugLevel: debugLevel
  };
  const res = await compile([initsrc, modulesrc], opts, linkerOpts, 'binary', undefined, sourceContents);
  // console.log("debinfo\n", res.debugInfo);

  const mlb = parseMlb(res.debugInfo);
  // console.log("mlb ", mlb);
  return mlb;
}

function parseMlbLine(line: string): MesenLabelFormat | null {
  if (!line.trim()) return null;
  const parts = line.split(':');
  if (parts.length < 4) return null;
  return {
    type: parts[0] as MesenLabelFormat['type'],
    address: parts[1],
    label: parts[2],
    comment: parts.slice(3).join(':')
  };
}

function parseMlb(mlb: string): MesenLabelFormat[] {
  return mlb.split('\n')
    .map(parseMlbLine)
    .filter((e): e is MesenLabelFormat => e !== null);
}

describe('MLB Debug Info Generation', function() {

  describe('Label Generation', function() {
    it('should generate labels for code at fixed addresses', async function() {
      const source = `
.segment "PRG"
.org $8000

MainLoop:
  lda #$00
  sta $2000
  jmp MainLoop
`;

      const entries = await assembleAndGetDebugInfo(source);
      expect(entries).toBeTruthy();

      // Find the MainLoop label
      const mainLoop = entries.find(e => e.label === 'MainLoop');
      expect(mainLoop).toBeTruthy();
      expect(mainLoop?.type).toBe("NesPrgRom");
      expect(mainLoop?.address).toBe('0');
    });

    it('should generate labels for multiple code locations', async function() {
      const source = `
.segment "PRG"
.org $8000

Start:
  lda #$01

SubRoutine:
  sta $00
  rts

End:
  jmp Start
`;

      const entries = await assembleAndGetDebugInfo(source);

      const start = entries.find(e => e.label === 'Start');
      const subRoutine = entries.find(e => e.label === 'SubRoutine');
      const end = entries.find(e => e.label === 'End');

      expect(start).toBeTruthy();
      expect(subRoutine).toBeTruthy();
      expect(end).toBeTruthy();

      // Labels should be in order
      expect(start?.type).toBe("NesPrgRom");
      expect(subRoutine?.type).toBe("NesPrgRom");
      expect(end?.type).toBe("NesPrgRom");
    });

    it('should not duplicate labels for the same address', async function() {
      const source = `
.segment "PRG"
.org $8000

Label1:
  nop
  nop
Label2:
  nop
`;

      const entries = await assembleAndGetDebugInfo(source);

      // First label should appear, second at same offset should be empty
      const label1 = entries.find(e => e.label === 'Label1');
      expect(label1).toBeTruthy();

      // Check that we don't have duplicate labels at the same position
      const labels = entries.filter(e => e.label && e.label !== '');
      const addresses = labels.map(e => e.address);
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(labels.length);
    });
  });

  describe('Source Code Comments', function() {
    it('should include source lines as comments on -g1', async function() {
      const source = `
.segment "PRG"
.org $8000

Start:
  lda #$42
  sta $2000
`;

      const entries = await assembleAndGetDebugInfo(source, 'test.s', 1);

      // Find entries with the source code in comments
      const ldaEntry = entries.find(e => e.comment.includes('lda #$42'));
      const staEntry = entries.find(e => e.comment.includes('sta $2000'));

      expect(ldaEntry).toBeTruthy();
      expect(staEntry).toBeTruthy();
    });

    it('should include label definitions in comments', async function() {
      const source = `
.segment "PRG"
.org $8000

; Testing a comment before the label
MainRoutine:
  lda #$00
  rts
`;

      const entries = await assembleAndGetDebugInfo(source);

      // The label line should be in the comment
      const labelEntry = entries.find(e => e.comment.includes('Testing'));
      expect(labelEntry).toBeTruthy();
    });

    it('should handle multi-line context in comments', async function() {
      const source = `
.segment "PRG"
.org $8000

; This is a comment
; Multiple lines
Start:
  lda #$01
  sta $00
`;

      const entries = await assembleAndGetDebugInfo(source);

      // Comments should include context
      const hasContext = entries.some(e =>
        e.comment.includes('Multiple lines') ||
        e.comment.includes('lda #$01')
      );
      expect(hasContext).toBeTruthy();
    });
  });

  describe('Memory Space Classification', function() {
    it('should classify RAM variables (< $2000) as "NesInternalRam" type', async function() {
      const source = `
.segment "PRG"
.org $8000

PlayerHP = $00
EnemyHP = $01

Start:
  lda PlayerHP
  sta EnemyHP
`;

      const entries = await assembleAndGetDebugInfo(source);

      // Find the RAM variable entries
      const ramEntries = entries.filter(e => e.type === "NesInternalRam");

      // Should have RAM labels
      expect(ramEntries.length).toBeGreaterThan(0);

      // Check that RAM addresses are < 0x2000
      for (const entry of ramEntries) {
        const addr = parseInt(entry.address, 16);
        expect(addr).toBeLessThan(0x2000);
      }
    });

    it('should classify hardware registers ($2000-$6000) as G type', async function() {
      const source = `
.segment "PRG"
.org $8000

PPU_CTRL = $2000
PPU_MASK = $2001

Start:
  lda #$00
  sta PPU_CTRL
  sta PPU_MASK
`;

      const entries = await assembleAndGetDebugInfo(source);

      // Find hardware register entries
      const hwEntries = entries.filter(e => e.type === "NesMemory");

      // Should have hardware register labels
      expect(hwEntries.length).toBeGreaterThan(0);

      // Check that addresses are in $2000-$6000 range
      for (const entry of hwEntries) {
        const addr = parseInt(entry.address, 16);
        expect(addr).toBeGreaterThanOrEqual(0x2000);
        expect(addr).toBeLessThan(0x6000);
      }
    });

    it('should classify SRAM ($6000-$8000) as S type', async function() {
      const source = `
.segment "PRG"
.org $8000

SaveData = $6000
GameFlags = $6100

Start:
  lda SaveData
  sta GameFlags
`;

      const entries = await assembleAndGetDebugInfo(source);

      // Find SRAM entries
      const sramEntries = entries.filter(e => e.type === "NesSaveRam");

      // Should have SRAM labels
      expect(sramEntries.length).toBeGreaterThan(0);

      // Check that addresses are in $0000-$2000 range (from the start of the segment)
      for (const entry of sramEntries) {
        const addr = parseInt(entry.address, 16);
        expect(addr).toBeGreaterThanOrEqual(0x0000);
        expect(addr).toBeLessThan(0x2000);
      }
    });

    it('should classify ROM code (>= $8000) as P type', async function() {
      const source = `
.segment "PRG"
.org $8000

CodeLabel = $8000
AnotherLabel = $C000

Start:
  jmp CodeLabel
`;

      const entries = await assembleAndGetDebugInfo(source);

      // Find PRG ROM entries
      const prgEntries = entries.filter(e => e.type === "NesPrgRom");

      // Should have PRG labels
      expect(prgEntries.length).toBeGreaterThan(0);
    });
  });

  describe('Address Calculation', function() {
    it('should handle offsets from the PRG base address', async function() {
      const source = `
.segment "PRG"
; use an offset from the base PRG address of $8000
.org $8123

Start:
  nop
`;

      const entries = await assembleAndGetDebugInfo(source);

      const start = entries.find(e => e.label === 'Start');
      expect(start).toBeTruthy();

      expect(start?.address).toBe('123');
    });

    it('should handle addresses at different ROM locations', async function() {
      const source = `
.segment "PRG"
.org $C000

FixedBank:
  lda #$00

.org $E000

ResetVector:
  jmp FixedBank
`;

      const entries = await assembleAndGetDebugInfo(source);

      const fixedBank = entries.find(e => e.label === 'FixedBank');
      const resetVector = entries.find(e => e.label === 'ResetVector');

      expect(fixedBank).toBeTruthy();
      expect(resetVector).toBeTruthy();

      // Verify offset calculation
      expect(fixedBank?.address).toBe('4000');
      expect(resetVector?.address).toBe('6000');
    });
  });

  describe('Complex Scenarios', function() {
    it('should handle mixed code with variables and labels', async function() {
      const source = `
.segment "PRG"
.org $8000

; RAM variables
PlayerX = $00
PlayerY = $01

; Hardware registers
PPU_DATA = $2007

; Code
Init:
  lda #$10
  sta PlayerX
  sta PlayerY

WriteToVRAM:
  lda PlayerX
  sta PPU_DATA
  rts

NMI:
  jmp WriteToVRAM
`;

      const entries = await assembleAndGetDebugInfo(source);

      // Should have all types
      const hasR = entries.some(e => e.type === "NesInternalRam");
      const hasG = entries.some(e => e.type === "NesMemory");
      const hasP = entries.some(e => e.type === "NesPrgRom");

      expect(hasR).toBeTruthy();
      expect(hasG).toBeTruthy();
      expect(hasP).toBeTruthy();

      // Should have code labels
      const init = entries.find(e => e.label === 'Init');
      const writeToVRAM = entries.find(e => e.label === 'WriteToVRAM');
      const nmi = entries.find(e => e.label === 'NMI');

      expect(init).toBeTruthy();
      expect(writeToVRAM).toBeTruthy();
      expect(nmi).toBeTruthy();
    });

    it('should handle relocatable code sections', async function() {
      const source = `
.segment "PRG"
.org $8000

Fixed:
  jsr Relocatable

.reloc
Relocatable:
  lda #$42
  rts
`;

      const entries = await assembleAndGetDebugInfo(source);

      const fixed = entries.find(e => e.label === 'Fixed');
      const relocatable = entries.find(e => e.label === 'Relocatable');

      expect(fixed).toBeTruthy();
      expect(relocatable).toBeTruthy();
    });

    it('should include all instructions with source annotations on g1', async function() {
      const source = `
.segment "PRG"
.org $8000

Start:
  lda #$00
  ldx #$01
  ldy #$02
  sta $2000
  stx $2001
  sty $2002
  rts
`;

      const entries = await assembleAndGetDebugInfo(source, 'test.s', 1);

      // Each instruction should have an entry with source
      const instructions = ['lda #$00', 'ldx #$01', 'ldy #$02',
                           'sta $2000', 'stx $2001', 'sty $2002', 'rts'];

      for (const instr of instructions) {
        const found = entries.some(e => e.comment.includes(instr));
        expect(found).toBeTruthy();
      }
    });
  });

  describe('Edge Cases', function() {
    it('should handle empty source gracefully', async function() {
      const source = '';
      const mlb = await assembleAndGetDebugInfo(source);

      expect(mlb).toBeEmpty();
    });

    it('should handle source with only comments', async function() {
      const source = `
; Just a comment
; Another comment
`;
      const mlb = await assembleAndGetDebugInfo(source);

      expect(mlb).toBeEmpty();
    });

    it('should handle very long label names', async function() {
      const source = `
.segment "PRG"
.org $8000

VeryLongLabelNameThatGoesOnAndOnAndOn:
  nop
`;

      const entries = await assembleAndGetDebugInfo(source);

      const longLabel = entries.find(e =>
        e.label.includes('VeryLongLabelNameThatGoesOnAndOnAndOn')
      );
      expect(longLabel).toBeTruthy();
    });

    it('should handle symbols with special characters in values', async function() {
      const source = `
.segment "PRG"
.org $8000

Value = $FF

Start:
  lda #Value
`;

      const mlb = await assembleAndGetDebugInfo(source);

      expect(mlb).toBeTruthy();
    });
    it('should add comments on the right of the asm', async function() {
      const source = `
.segment "PRG"
.org $8000

OAM = $200
.define SPRITE_X 3

Main:                ; Test comment on label
  lda #$03           ; Set the player X position to 3
  sta OAM + SPRITE_X ; OAM offset
  jmp Main           ; loop forever
`;

      const mlb = await assembleAndGetDebugInfo(source);
      // TODO actually check the results to see that comments are in the correct line
      expect(mlb).toBeTruthy();
    });

    it('should handle symbols with special characters in values', async function() {
      const source = `
.segment "PRG"
.org $8000

Value = $FF

Start:
  lda #Value
`;

      const mlb = await assembleAndGetDebugInfo(source);

      expect(mlb).toBeTruthy();
    });
  });
});
