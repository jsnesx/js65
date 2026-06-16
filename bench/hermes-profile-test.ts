/*
 * Phase profiler that runs UNDER Hermes (bundle this, then run with hermes.exe
 * or compile with shermes). Times tokenize+assemble and link separately at
 * doubling input sizes so we can see which phase performs poorly.
 * 
 * This was mostly used to find general stats about assembling vs linking,
 * and can be used as a reference if we need it in the future.
 */

import { assemble, link } from '../src/libassembler.ts';
import { SourceContents } from '../src/tokenstream.ts';
import { Linker } from '../src/linker.ts';

declare const print: (s: string) => void;

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

async function main() {
  const sizes = [1000, 2000, 4000, 8000];
  // Match the CLI defaults: debug info ON + sourceContents + getDebugInfo.
  print('   n | assemble(x) |   link(x) |  debug(x) |  total(x)');
  let pa = 0, pl = 0, pd = 0, pt = 0;
  const rx = (x: number, p: number) => (p ? (x / p).toFixed(2) : '-').padStart(5);
  for (const n of sizes) {
    const sources = new SourceContents();
    const inputs = [{ type: 'source' as const, code: genLarge(n), name: 'bench.s' }];
    const asmOpts = { generateDebugInfo: true };

    const t0 = Date.now();
    const res = await assemble(inputs, asmOpts, noCallbacks, sources);
    const t1 = Date.now();
    if (!res.success) { print('assemble failed'); return; }

    const linker = new Linker({});
    for (const m of res.modules) linker.read(m);
    const out = linker.link();
    out.apply(new Uint8Array(out.length));
    const t2 = Date.now();

    linker.getDebugInfo(sources, 0);
    const t3 = Date.now();

    const a = t1 - t0, l = t2 - t1, d = t3 - t2, tot = t3 - t0;
    print(String(n).padStart(5) + ' | ' + String(a).padStart(5) + 'ms ' + rx(a, pa) +
          ' | ' + String(l).padStart(4) + 'ms ' + rx(l, pl) +
          ' | ' + String(d).padStart(4) + 'ms ' + rx(d, pd) +
          ' | ' + String(tot).padStart(4) + 'ms ' + rx(tot, pt));
    pa = a; pl = l; pd = d; pt = tot;
  }
}

main();
