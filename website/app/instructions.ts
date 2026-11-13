import {Cpu} from '../../src/cpu.ts';
import type {ListingRow} from '../../src/listing.ts';
import {instructionReference} from './instructions.generated.ts';

export function instructionHelp(row: ListingRow): string | undefined {
  if (row.kind !== 'instruction' || !row.instruction || row.continuation) return undefined;
  const {mnemonic, mode} = row.instruction;
  const name = mnemonic.toLowerCase();
  const opcode = Cpu.P02.op(name)?.[mode];
  const reference = instructionReference[name];
  if (opcode == null || opcode !== row.bytes[0] || !reference) return undefined;
  const encoding = reference.encodings.find(e => e.opcode === opcode &&
    (e.mode === mode || mode === 'imp' && e.mode === 'acc'));
  if (!encoding) return undefined;
  const flags = reference.flags.map(flag =>
    `${flag.name}: ${flag.value}${flag.notes ? ` (${flag.notes})` : ''}`).join('\n');
  return [
    `${mnemonic.toUpperCase()} - ${reference.name} (NESdev reference)`,
    reference.operation, reference.description,
    `Addressing mode: ${encoding.addressingMode}.`,
    `Flags: ${flags || 'none'}.`,
    `${encoding.bytes} bytes. ${encoding.cycles} cycles.`, encoding.notes,
    `Source: https://www.nesdev.org/wiki/Instruction_reference#${mnemonic.toUpperCase()}`,
  ].filter(Boolean).join('\n');
}
