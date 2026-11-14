import {expect, it} from 'bun:test';
import {Nmos6502} from '../src/sim/cpu.ts';
import fixtures from './fixtures/sim-conformance.json';

it('matches licensed SingleStepTests register, memory, and cycle fixtures', () => {
  const failures: string[] = [];
  for (const fixture of fixtures) {
    const cpu = new Nmos6502();
    const initial = fixture.initial, final = fixture.final;
    cpu.r = {pc: initial.pc, a: initial.a, x: initial.x, y: initial.y,
      sp: initial.s, p: initial.p, cycles: 0};
    for (const [address, value] of initial.ram) cpu.memory[address] = value;
    try { cpu.step(); } catch (error) { failures.push(`${fixture.name}: ${error}`); continue; }
    const expected = {pc: final.pc, a: final.a, x: final.x, y: final.y,
      sp: final.s, p: final.p, cycles: fixture.cycles.length};
    if (JSON.stringify(cpu.r) !== JSON.stringify(expected) ||
        final.ram.some(([address, value]) => cpu.memory[address] !== value)) {
      failures.push(`${fixture.name}: ${JSON.stringify(cpu.r)} expected ${JSON.stringify(expected)}`);
    }
  }
  expect(failures.slice(0, 20)).toEqual([]);
  expect(failures).toHaveLength(0);
});
