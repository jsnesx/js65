import {describe, expect, it} from 'bun:test';
import {compile, findOutput} from '../src/libassembler.ts';
import type {ListingIndex} from '../src/listing.ts';
import {Nmos6502} from '../src/sim/cpu.ts';
import {loadSimulator, simulatorCompileTarget} from '../src/sim/loader.ts';
import {Simulator} from '../src/sim/machine.ts';
import {fileCallbacksFor} from '../src/worker/filecache.ts';

function image(code: string, files = new Map<string, string>()) {
  const result = compile([{type: 'source', name: 'main.s', code}], {
    target: simulatorCompileTarget, generateListingFile: true, generateListingIndex: true,
  }, fileCallbacksFor(files));
  expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
  expect(result.success).toBe(true);
  return loadSimulator(JSON.parse(new TextDecoder().decode(findOutput(result, 'listing-index')!.data)) as ListingIndex);
}

describe('simulator loader', () => {
  it('defaults origin, vectors, and ordered completion', () => {
    const loaded = image('lda #7\nsta $200\n');
    expect(loaded.entry).toBe(0x600);
    expect(loaded.completion).toBe(0x605);
    expect([...loaded.memory.slice(0xfff8)]).toEqual([0x40, 0x40, 0xf8, 0xff, 0, 6, 0xf9, 0xff]);
  });
  it('preserves six explicit vector bytes and leading data', () => {
    const loaded = image('.org $700\n.byte $ea\n.org $600\nnop\n.org $fffa\n.word $1234,$700,$5678\n');
    expect(loaded.entry).toBe(0x700);
    expect(loaded.completion).toBe(0x601);
    expect([...loaded.memory.slice(0xfffa)]).toEqual([0x34, 0x12, 0, 7, 0x78, 0x56]);
  });
  it('rejects partial vectors, reserved bytes, and ambiguous completion', () => {
    for (const address of [0xfffa, 0xfffc, 0xfffe]) {
      expect(() => image(`nop\n.org $${address.toString(16)}\n.byte 0\n`)).toThrow('Partial vector');
    }
    expect(() => image('nop\n.org $fff8\n.byte 1\n')).toThrow('reserved handlers');
    expect(() => image('.org $601\nnop\n.org $600\nnop\n')).toThrow('Completion boundary');
    expect(() => image('')).toThrow('No payload');
    expect(() => image('.org $fffa\n.word 0,0,0\n')).toThrow('No payload');
  });
  it('retains include/macro emission order and rejects wrapping bytes', () => {
    const loaded = image('.include "part.inc"\n.org $600\nnop\n.org $fffa\n.word $700,$600,$700\n',
      new Map([['part.inc', '.macro emit\n.org $700\nnop\n.endmacro\nemit\n']]));
    expect(loaded.entry).toBe(0x600);
    expect(loaded.memory[0x700]).toBe(0xea);
    expect(loaded.completion).toBe(0x601);
    const index: ListingIndex = {version: 1, linked: true, artifact: 'fixture', rows: [{
      row: 1, kind: 'data', expansion: [], synthetic: false, authored: true,
      address: 0xffff, size: 2, bytes: [0, 0],
    }]};
    expect(() => loadSimulator(index)).toThrow('wraps');
    index.rows[0] = {...index.rows[0], kind: 'reservation', address: 0xfff8, size: 1, bytes: [null]};
    expect(() => loadSimulator(index)).toThrow('reserved handlers');
    index.rows[0] = {...index.rows[0], address: 0x700};
    index.rows.push({...index.rows[0], row: 2, kind: 'instruction', address: 0x600, bytes: [0xea]});
    expect(loadSimulator(index).entry).toBe(0x600);
  });
});

describe('simulator execution', () => {
  it('completes before fetch and keeps loops bounded', () => {
    const machine = new Simulator(image('lda #7\nsta $200\n'));
    expect(machine.run(100)).toBe(2);
    expect(machine.reason).toBe('completed');
    expect(machine.cpu.r.cycles).toBe(6);
    expect(machine.cpu.memory[0x200]).toBe(7);
    const loop = new Simulator(image('loop: jmp loop\n'));
    expect(loop.run(50)).toBe(50);
    expect(loop.reason).toBe('budget');
  });
  it('restores memory, random, input, cycles, and completion', () => {
    const machine = new Simulator(image('lda $fe\nsta $200\nlda $ff\nsta $200\n'));
    machine.input(65);
    machine.run(4);
    const final = machine.snapshot();
    for (let i = 0; i < 4; i++) machine.back();
    expect(machine.cpu.memory[0x200]).toBe(0);
    machine.run(4);
    expect(machine.snapshot()).toEqual(final);
    machine.back(); machine.back(); machine.input(66); machine.run(2);
    expect(machine.cpu.memory[0x200]).toBe(66);
  });
  it('evicts history and stops before breakpoints', () => {
    const machine = new Simulator(image('loop: inc $200\njmp loop\n'), 3);
    machine.breakpoints.add(0x600);
    expect(machine.run(10)).toBe(0);
    expect(machine.reason).toBe('breakpoint');
    machine.run(10, true);
    expect(machine.cpu.memory[0x200]).toBe(1);
    machine.breakpoints.clear(); machine.run(10);
    expect(machine.historyAvailable).toBe(3);
    for (let i = 0; i < 5; i++) machine.back();
    expect(machine.historyAvailable).toBe(0);
    const inputs = new Simulator(image('loop: lda $ff\njmp loop\n'), 3);
    for (let i = 0; i < 30; i++) { inputs.input(i); inputs.step(); }
    const final = inputs.snapshot();
    inputs.back(); inputs.back(); inputs.back(); inputs.run(3);
    expect(inputs.snapshot()).toEqual({...final, reason: 'budget'});
  });
  it('uses BRK/RTI and latched NMI with seven-cycle interrupt entry', () => {
    const machine = new Simulator(image('brk\nnop\nnop\n'));
    machine.step();
    expect(machine.cpu.r.pc).toBe(0xfff9);
    expect(machine.cpu.r.cycles).toBe(7);
    expect(machine.cpu.memory[0x1fb] & 0x30).toBe(0x30);
    machine.step(); expect(machine.cpu.r.pc).toBe(0x602);
    machine.cpu.setNmi(true); machine.cpu.setNmi(false);
    const before = machine.cpu.state();
    const seed = machine.seed;
    machine.step(); expect(machine.cpu.r.pc).toBe(0xfff8);
    expect(machine.seed).toBe(seed);
    expect(machine.cpu.r.cycles).toBe(20);
    machine.back(); expect(machine.cpu.state()).toEqual(before);
    machine.step(); machine.step(); expect(machine.cpu.r.pc).toBe(0x602);
  });
  it('faults unsupported opcodes and resets the image and seed', () => {
    const machine = new Simulator(image('.byte 2\n'));
    machine.step(); expect(machine.reason).toBe('fault');
    machine.reset(); expect(machine.seed).toBe(1);
    expect(machine.cpu.r).toMatchObject({pc: 0x600, sp: 0xfa, p: 0x24, cycles: 7});
  });
  it('rewinds a taken branch and self-modifying instruction bytes', () => {
    const machine = new Simulator(image('lda #$ea\nsta patch\npatch: brk\nnop\n'));
    machine.run(4); expect(machine.reason).toBe('completed');
    expect(machine.cpu.memory[0x605]).toBe(0xea);
    machine.back(); machine.back(); machine.back();
    expect(machine.cpu.memory[0x605]).toBe(0);
    machine.run(3); expect(machine.reason).toBe('completed');
    const branch = new Simulator(image('loop: inx\nbne loop\n'));
    branch.step(); const before = branch.snapshot(); branch.step();
    expect(branch.cpu.r.pc).toBe(0x600);
    branch.back(); expect(branch.snapshot()).toEqual(before);
  });
  it('replays interrupt events after rewinding across their arrival', () => {
    for (const kind of ['irq', 'nmi'] as const) {
      const machine = new Simulator(image('cli\nnop\nnop\nnop\nnop\nnop\n'));
      machine.step(); machine.interrupt(kind); machine.run(4);
      const final = machine.snapshot();
      for (let i = 0; i < 5; i++) machine.back();
      machine.run(5);
      expect(machine.snapshot()).toEqual(final);
      for (let i = 0; i < 5; i++) machine.back();
      machine.input(65); machine.run(5);
      expect(machine.cpu.r.pc).toBe(0x605);
      expect(machine.cpu.memory[0xff]).toBe(65);
    }
  });
});

describe('NMOS arithmetic and addressing', () => {
  it('handles decimal flags and invalid BCD nibbles', () => {
    const cpu = new Nmos6502();
    cpu.memory.set([0x69, 0x50], 0x600);
    cpu.r = {pc: 0x600, a: 0x50, x: 0, y: 0, sp: 0xfd, p: 0x28, cycles: 0};
    cpu.step(); expect(cpu.r.a).toBe(0); expect(cpu.r.p & 0xc3).toBe(0xc1);
    cpu.memory[0x600] = 0xe9; cpu.memory[0x601] = 1;
    cpu.r.pc = 0x600; cpu.r.a = 0; cpu.r.p = 0x29;
    cpu.step(); expect(cpu.r.a).toBe(0x99); expect(cpu.r.p & 0xc3).toBe(0x80);
  });
  it('wraps indirect JMP and zero page pointers', () => {
    const cpu = new Nmos6502();
    cpu.memory.set([0x6c, 0xff, 0x12], 0x600);
    cpu.r.pc = 0x600; cpu.memory[0x12ff] = 0x34; cpu.memory[0x1200] = 0x56;
    cpu.step(); expect(cpu.r.pc).toBe(0x5634); expect(cpu.r.cycles).toBe(5);
    cpu.memory.set([0xb1, 0xff], 0x600); cpu.r.pc = 0x600;
    cpu.memory[0xff] = 0xff; cpu.memory[0] = 0x12; cpu.r.y = 1;
    cpu.memory[0x1300] = 42; cpu.step(); expect(cpu.r.a).toBe(42); expect(cpu.r.cycles).toBe(11);
  });
  it('delays IRQ masking changes and applies hardware reset', () => {
    const cpu = new Nmos6502(); cpu.memory.set([0x58, 0xea, 0xea], 0x600);
    cpu.r.pc = 0x600; cpu.irq = true; cpu.memory[0xffff] = 0x80;
    cpu.step(); cpu.step(); expect(cpu.r.pc).toBe(0x602);
    cpu.step(); expect(cpu.r.pc).toBe(0x8000); expect(cpu.r.cycles).toBe(11);
    cpu.memory[0xfffd] = 6; cpu.reset(); expect(cpu.r.pc).toBe(0x600);
    expect(cpu.r.sp).toBe(0xf7); expect(cpu.r.cycles).toBe(18);
  });
});
