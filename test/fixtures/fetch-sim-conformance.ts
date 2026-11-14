import {Cpu} from '../../src/cpu.ts';
import {documentedMnemonics} from '../../src/sim/cpu.ts';

const base = 'https://raw.githubusercontent.com/SingleStepTests/65x02/main/';
const opcodes = [...new Set(Object.entries(Cpu.P02.table).filter(([name]) => documentedMnemonics.has(name))
  .flatMap(([, ops]) => Object.values(ops)))];
const fixtures: unknown[] = [];
for (let i = 0; i < opcodes.length; i += 8) {
  const batch = await Promise.all(opcodes.slice(i, i + 8).map(async opcode => {
    const name = opcode!.toString(16).padStart(2, '0');
    const response = await fetch(`${base}6502/v1/${name}.json`);
    if (!response.ok) throw new Error(`Fixture fetch failed: ${name}`);
    const tests = await response.json() as unknown[];
    return tests.slice(0, 64);
  }));
  fixtures.push(...batch.flat());
}
await Bun.write('test/fixtures/sim-conformance.json', '[\n' + fixtures.map(f => JSON.stringify(f)).join(',\n') + '\n]\n');
const license = await fetch(`${base}LICENSE`);
if (!license.ok) throw new Error('License fetch failed');
await Bun.write('test/fixtures/sim-conformance.LICENSE.txt', await license.text());
console.log(`Saved ${fixtures.length} SingleStepTests fixtures.`);
