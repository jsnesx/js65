/*
 * Benchmark js65 "native JS" CLI frontends against each other.
 *
 * Compares wall-clock time (incl. process startup) and binary size across the
 * compiled frontends that are present in ./build. Add new frontends to the
 * FRONTENDS list below; any whose binary is missing is skipped automatically.
 *
 * Run:  bun run bench
 *   optionally restrict to some frontends:  bun run bench -- bun quickjs
 *   tune workload via env vars:
 *     BENCH_RUNS (default 5)      timed runs per (scenario, frontend)
 *     BENCH_WARMUP (default 1)    untimed warmup runs
 *     BENCH_LARGE (default 10000) instructions in the "large" scenario
 *     BENCH_MACROS (default 5000) macro invocations
 *     BENCH_PATCHES (default 500) .org/.reloc pairs (-> 2x link chunks)
 *
 * Prereqs (build whichever you want to compare):
 *   bun run exe          -> build/js65(.exe)
 *   bun run quickjs-exe  -> build/js65-qjs(.exe)
 *   (perry, etc.)        -> build/js65-perry(.exe)
 */

import { mkdirSync, writeFileSync, statSync, existsSync } from 'fs';

const DIR = 'build/bench';
mkdirSync(DIR, { recursive: true });
const ext = process.platform === 'win32' ? '.exe' : '';

// --- frontends under test (extend this list) -----------------------------
const FRONTENDS: Array<{ label: string; path: string }> = [
  { label: 'bun', path: `build/js65${ext}` },
  { label: 'quickjs', path: `build/js65-qjs${ext}` },
  { label: 'perry', path: `build/js65-perry${ext}` },
];

// --- tunables ------------------------------------------------------------
const envInt = (name: string, dflt: number) => {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const RUNS = envInt('BENCH_RUNS', 5);
const WARMUP = envInt('BENCH_WARMUP', 1);
const LARGE = envInt('BENCH_LARGE', 10000);
const MACROS = envInt('BENCH_MACROS', 5000);
const PATCH_PAIRS = envInt('BENCH_PATCHES', 500);

// --- workload generators -------------------------------------------------
const hex = (n: number) => (n & 0xff).toString(16).padStart(2, '0');

function genLarge(count: number): string {
  const lines = ['.segment "CODE" :bank $00 :size $ff00 :mem $0100 :off $0000', '.segment "CODE"', '.org $0100'];
  for (let i = 0; i < count; i++) lines.push(`  lda #$${hex(i)}`);
  return lines.join('\n') + '\n';
}

function genMacros(count: number): string {
  const lines = [
    '.macro DOIT val', '  lda #val', '  sta $00', '  clc', '  adc #$01', '.endmacro',
    '.segment "CODE" :bank $00 :size $ff00 :mem $0100 :off $0000', '.segment "CODE"', '.org $0100',
  ];
  for (let i = 0; i < count; i++) lines.push(`  DOIT $${hex(i)}`);
  return lines.join('\n') + '\n';
}

function genPatches(pairs: number): string {
  const lines = [
    '.macpack common',
    '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000',
    'FREE "CODE" [$8000, $10000)',
    '.segment "CODE"',
  ];
  let addr = 0x8000;
  for (let i = 0; i < pairs; i++) {
    lines.push(`.org $${addr.toString(16)}`, `F${i}:`, `  lda #$${hex(i)}`);
    addr += 8;
    lines.push('.reloc', `R${i}:`, `  lda #$${hex(i)}`);
  }
  return lines.join('\n') + '\n';
}

const genTiny = () => '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.segment "CODE"\n.org $8000\n  rts\n';

interface Scenario { name: string; desc: string; source: string; }
const scenarios: Scenario[] = [
  { name: 'startup', desc: 'trivial (startup overhead)', source: genTiny() },
  { name: 'large', desc: `${LARGE} instructions`, source: genLarge(LARGE) },
  { name: 'macros', desc: `${MACROS} macro invocations`, source: genMacros(MACROS) },
  { name: 'patches', desc: `${2 * PATCH_PAIRS} link chunks (.org/.reloc)`, source: genPatches(PATCH_PAIRS) },
];
for (const s of scenarios) writeFileSync(`${DIR}/${s.name}.s`, s.source);

// --- stats helpers -------------------------------------------------------
interface Stats { min: number; max: number; avg: number; runs: number }
function summarize(xs: number[]): Stats {
  const sum = xs.reduce((a, b) => a + b, 0);
  return { min: Math.min(...xs), max: Math.max(...xs), avg: sum / xs.length, runs: xs.length };
}
const ms = (n: number) => `${n.toFixed(1)} ms`;
// unbuffered write so progress shows live even when stdout is piped
const say = (line = '') => process.stderr.write(line + '\n');

// --- select frontends ----------------------------------------------------
interface Frontend { label: string; path: string; size: number }
const filter = Bun.argv.slice(2);
const frontends: Frontend[] = [];
for (const f of FRONTENDS) {
  if (filter.length > 0 && !filter.includes(f.label)) continue;
  if (!existsSync(f.path)) { say(`(skipping ${f.label}: ${f.path} not found)`); continue; }
  frontends.push({ ...f, size: statSync(f.path).size });
}
if (frontends.length === 0) { say('No frontend binaries found in ./build — build them first.'); process.exit(1); }

function timeRun(bin: string, args: string[]): number {
  const t0 = performance.now();
  const p = Bun.spawnSync({ cmd: [bin, ...args], stdout: 'ignore', stderr: 'pipe' });
  const t1 = performance.now();
  if (p.exitCode !== 0) {
    say(`\nFAILED: ${bin} ${args.join(' ')} (exit ${p.exitCode})`);
    say(new TextDecoder().decode(p.stderr).slice(0, 800));
    throw new Error('benchmark command failed');
  }
  return t1 - t0;
}

// --- run -----------------------------------------------------------------
say(`\njs65 frontend benchmark  (${RUNS} runs each, +${WARMUP} warmup; lower is better)`);
say(`frontends: ${frontends.map((f) => f.label).join(', ')}\n`);

const results: Record<string, Record<string, Stats>> = {};
for (const s of scenarios) {
  results[s.name] = {};
  say(`• ${s.name} — ${s.desc}`);
  const args = (label: string) => [`${DIR}/${s.name}.s`, '-o', `${DIR}/out-${s.name}-${label}.nes`];
  for (const f of frontends) {
    for (let i = 0; i < WARMUP; i++) timeRun(f.path, args(f.label));
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      times.push(timeRun(f.path, args(f.label)));
      const st = summarize(times);
      // live, in-place-ish progress line
      process.stderr.write(`\r    ${f.label.padEnd(10)} [${i + 1}/${RUNS}] min ${ms(st.min)}  max ${ms(st.max)}  avg ${ms(st.avg)}        `);
    }
    results[s.name][f.label] = summarize(times);
    say('');
  }
  say('');
}

// --- final comparison table ----------------------------------------------
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmtRow = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|-' + widths.map((w) => '-'.repeat(w)).join('-|-') + '-|';
  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join('\n');
}

const labels = frontends.map((f) => f.label);
const fastest = (name: string) => labels.reduce((a, b) => (results[name][a].avg <= results[name][b].avg ? a : b));

const timeRows = scenarios.map((s) => [
  s.name,
  ...labels.map((l) => {
    const cell = results[s.name][l].avg.toFixed(1);
    return l === fastest(s.name) ? `*${cell}` : cell;
  }),
]);
const sizeRow = ['size (MB)', ...frontends.map((f) => (f.size / 1024 / 1024).toFixed(2))];

const out = table(['scenario', ...labels], [...timeRows, sizeRow]);
// Live progress goes to stderr; the final table goes to stdout only, so it
// prints once on a terminal and `bun run bench > results.txt` captures the table.
console.log('\nAverage wall-clock per scenario in ms (* = fastest)\n');
console.log(out);
