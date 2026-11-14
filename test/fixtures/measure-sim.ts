import {Simulator} from '../../src/sim/machine.ts';

const memory = new Uint8Array(65536);
memory.set([0xee, 0, 2, 0x4c, 0, 6], 0x600);
memory[0xfffd] = 6;
Bun.gc(true);
const baseline = process.memoryUsage().heapUsed;
const machine = new Simulator({memory, entry: 0x600, completion: 0x606});
const start = performance.now();
machine.run(200000);
const elapsed = performance.now() - start;
Bun.gc(true);
const retained = process.memoryUsage().heapUsed - baseline;
const rewindStart = performance.now();
for (let i = 0; i < 4096; i++) machine.back();
const rewind = performance.now() - rewindStart;
const replayStart = performance.now();
machine.run(4096);
console.log(JSON.stringify({instructions: 200000, elapsedMs: elapsed, retainedBytes: retained,
  history: machine.historyAvailable, rewindMs: rewind, replayMs: performance.now() - replayStart}));
