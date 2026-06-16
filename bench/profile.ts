/*
 * Phase-level profiler for the js65 assembler pipeline.
 *
 * Runs the same instruction workload as the bench "small/large/xlarge"
 * scenarios but in-process, timing the tokenize+assemble phase and the link
 * phase separately at several input sizes. This isolates *which* phase scales
 * super-linearly so we know where to look for TS-level optimizations.
 *
 * Run:  bun run bench/profile.ts
 *   sizes via args:  bun run bench/profile.ts 1000 2000 4000 8000 16000
 */

import { assemble, link } from '../src/libassembler.ts';

const hex = (n: number) => (n & 0xff).toString(16).padStart(2, '0');

function genLarge(count: number): string {
  const lines = ['.segment "CODE" :bank $00 :size $ff00 :mem $0100 :off $0000', '.segment "CODE"', '.org $0100'];
  for (let i = 0; i < count; i++) lines.push(`  lda #$${hex(i)}`);
  return lines.join('\n') + '\n';
}

const noCallbacks = {
  readText: async () => '',
  readBinary: async () => new Uint8Array(0),
};

const sizes = (Bun.argv.slice(2).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0));
const SIZES = sizes.length ? sizes : [1000, 2000, 4000, 8000, 16000];

interface Row { n: number; asm: number; link: number; total: number }
const rows: Row[] = [];

for (const n of SIZES) {
  const code = genLarge(n);
  const inputs = [{ type: 'source' as const, code, name: 'bench.s' }];

  // warm up once (jit, etc.) then take a fresh timed run
  await assemble(inputs, undefined, noCallbacks);

  const t0 = performance.now();
  const res = await assemble(inputs, undefined, noCallbacks);
  const t1 = performance.now();
  if (!res.success) { console.error('assemble failed:', res.messages.slice(0, 3)); process.exit(1); }
  link(res.modules);
  const t2 = performance.now();

  rows.push({ n, asm: t1 - t0, link: t2 - t1, total: t2 - t0 });
}

const f = (x: number) => x.toFixed(1).padStart(9);
const ratio = (x: number, prev: number | undefined) => prev ? (x / prev).toFixed(2).padStart(6) : '   -  ';

console.log('\nPhase timings (ms) by input size; ratio = vs previous (smaller) size');
console.log('   n |   assemble (x) |       link (x) |      total (x)');
console.log('-----+----------------+----------------+----------------');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i], p = rows[i - 1];
  console.log(
    `${String(r.n).padStart(5)}|${f(r.asm)} ${ratio(r.asm, p?.asm)}|${f(r.link)} ${ratio(r.link, p?.link)}|${f(r.total)} ${ratio(r.total, p?.total)}`,
  );
}
console.log('\n(For O(n): doubling n -> ratio ~2.0.  For O(n^2): ratio ~4.0.)');
