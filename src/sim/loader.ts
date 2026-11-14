import type {ListingIndex} from '../listing.ts';

export interface MachineImage {
  memory: Uint8Array;
  entry: number;
  completion: number;
}

export const simulatorCompileTarget = 'js65-sim';

export function loadSimulator(index: ListingIndex): MachineImage {
  if (!index.linked || index.version !== 1) throw new Error('A linked listing is required.');
  const memory = new Uint8Array(65536), authored = new Uint8Array(65536);
  const payload: number[] = [];
  for (const row of index.rows) {
    if (!row.authored || !row.size) continue;
    if (row.address == null || row.relative || row.bank != null && row.bank !== 0) {
      throw new Error('Simulator requires resolved, unbanked bytes.');
    }
    if (row.address < 0 || row.address + row.size > 65536 || row.bytes.length !== row.size) {
      throw new Error('Payload wraps the 64 KiB address space.');
    }
    if (row.address < 0xfffa && row.address + row.size > 0xfff8) {
      throw new Error('Payload collides with reserved handlers at $fff8-$fff9.');
    }
    if (row.kind === 'reservation' && row.bytes.every(b => b == null)) continue;
    if (row.bytes.some(b => b == null)) throw new Error('Simulator requires resolved bytes.');
    for (let i = 0; i < row.size; i++) {
      const address = row.address + i;
      if (authored[address]) throw new Error('Overlapping authored payload ranges.');
      memory[address] = row.bytes[i]!;
      authored[address] = 1;
      if (address < 0xfffa) payload.push(address);
    }
  }
  const vectors = [0xfffa, 0xfffc, 0xfffe];
  for (const address of vectors) {
    if (authored[address] !== authored[address + 1]) throw new Error(`Partial vector word at $${address.toString(16)}.`);
  }
  if (!payload.length) throw new Error('No payload entry: empty or vector-only input cannot run.');
  const completion = payload[payload.length - 1] + 1;
  if (completion > 65535) throw new Error('Completion boundary wraps the address space.');
  if (authored[completion]) throw new Error('Completion boundary is occupied by another authored range.');
  const defaults = [0xfff8, payload[0], 0xfff9];
  vectors.forEach((address, i) => {
    if (!authored[address]) {
      memory[address] = defaults[i] & 255;
      memory[address + 1] = defaults[i] >> 8;
    }
  });
  memory[0xfff8] = memory[0xfff9] = 0x40;
  return {memory, entry: memory[0xfffc] | memory[0xfffd] << 8, completion};
}
