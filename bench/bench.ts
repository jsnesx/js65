/*
 * Benchmark js65 "native JS" CLI frontends against each other.
 *
 * Compares wall-clock time (incl. process startup) and binary size across the
 * compiled frontends that are present in ./build. Add new frontends to the
 * FRONTENDS list below; any whose binary is missing is skipped automatically.
 *
 * Run:  bun run bench
 *   optionally restrict to some frontends and/or scenarios by naming them:
 *     bun run bench -- bun quickjs        (only these frontends)
 *     bun run bench -- patches-xlarge     (only this scenario)
 *     bun run bench -- hermes patches large
 *   quickjs and patches-xlarge are skipped by default (too slow); name one
 *   explicitly to include it:  bun run bench -- quickjs patches-xlarge
 *   tune workload via env vars:
 *     BENCH_RUNS (default 5)        timed runs per (scenario, frontend)
 *     BENCH_WARMUP (default 1)      untimed warmup runs
 *     BENCH_SMALL (default 1000)    instructions in the "small" scenario
 *     BENCH_LARGE (default 10000)   instructions in the "large" scenario
 *     BENCH_XLARGE (default 50000)  instructions in the "xlarge" scenario
 *     BENCH_MACROS (default 5000)   macro invocations
 *     BENCH_PATCHES (default 500)          .org/.reloc pairs (-> 2x link chunks)
 *     BENCH_PATCHES_MEDIUM (default 2000)  same, more chunks
 *     BENCH_PATCHES_LARGE (default 6000)   same, more chunks
 *     BENCH_PATCHES_XLARGE (default 20000) same, more chunks (skipped by default)
 *
 *   The small/large/xlarge scenarios share one workload generator at three
 *   input sizes so their timings form a scaling curve: comparing them shows
 *   how compile time grows with program size (ideally ~linear).  The four
 *   patches* scenarios do the same for the linker: they hold the per-chunk
 *   work constant and only scale the *number* of link chunks, so comparing
 *   them isolates how placement / free-space bookkeeping scales (again,
 *   ideally ~linear).
 *
 * Prereqs (build whichever you want to compare):
 *   bun run exe          -> build/js65-bun(.exe)
 *   bun run hermes-exe   -> build/js65(.exe)   (the default js65 binary)
 *   bun run quickjs-exe  -> build/js65-qjs(.exe)
 *   (perry, etc.)        -> build/js65-perry(.exe)
 */

import { mkdirSync, writeFileSync, statSync, existsSync } from 'fs';

const DIR = 'build/bench';
mkdirSync(DIR, { recursive: true });
const ext = process.platform === 'win32' ? '.exe' : '';

// `skipByDefault` frontends are only run when named explicitly on the command
// line (e.g. `bun run bench -- quickjs`). quickjs is slow enough that running
// it on every `bun run bench` is more annoying than useful.
const FRONTENDS: Array<{ label: string; path: string; skipByDefault?: boolean }> = [
  { label: 'bun', path: `build/js65-bun${ext}` },
  { label: 'quickjs', path: `build/js65-qjs${ext}`, skipByDefault: true },
  { label: 'hermes', path: `build/js65${ext}` },
];

// Parameters pulled from the environment to tune the benchmarks
const envInt = (name: string, dflt: number) => {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const RUNS = envInt('BENCH_RUNS', 5);
const WARMUP = envInt('BENCH_WARMUP', 1);
const SMALL = envInt('BENCH_SMALL', 1000);
const LARGE = envInt('BENCH_LARGE', 10000);
const XLARGE = envInt('BENCH_XLARGE', 50000);
const MACROS = envInt('BENCH_MACROS', 5000);
const PATCH_PAIRS = envInt('BENCH_PATCHES', 500);
const PATCH_PAIRS_MEDIUM = envInt('BENCH_PATCHES_MEDIUM', 2000);
const PATCH_PAIRS_LARGE = envInt('BENCH_PATCHES_LARGE', 6000);
const PATCH_PAIRS_XLARGE = envInt('BENCH_PATCHES_XLARGE', 20000);

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

// Each pair emits one fixed (.org) chunk every PATCH_STRIDE bytes plus one
// floating (.reloc) chunk for the linker to place in the leftover free space.
// A bank's $8000-$10000 window therefore only holds so many pairs; anything
// beyond that spills into another bank so the pair count can scale freely.
const PATCH_STRIDE = 8;
const PATCH_PAIRS_PER_BANK = 0x8000 / PATCH_STRIDE;

function genPatches(pairs: number): string {
  const banks = Math.max(1, Math.ceil(pairs / PATCH_PAIRS_PER_BANK));
  const lines = ['.macpack common'];
  for (let b = 0; b < banks; b++) {
    lines.push(`.segment "P${b}" :bank $${hex(b)} :size $8000 :mem $8000 :off $${(b * 0x8000).toString(16)}`);
  }
  let i = 0;
  for (let b = 0; b < banks; b++) {
    lines.push(`FREE "P${b}" [$8000, $10000)`, `.segment "P${b}"`);
    let addr = 0x8000;
    for (let n = 0; n < PATCH_PAIRS_PER_BANK && i < pairs; n++, i++) {
      lines.push(`.org $${addr.toString(16)}`, `F${i}:`, `  lda #$${hex(i)}`);
      addr += PATCH_STRIDE;
      lines.push('.reloc', `R${i}:`, `  lda #$${hex(i)}`);
    }
  }
  return lines.join('\n') + '\n';
}

const genTiny = () => '.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.segment "CODE"\n.org $8000\n  rts\n';

// `gen` is deferred so we only pay to build the sources we actually run - the
// biggest patches source is megabytes of text.
interface Scenario { name: string; desc: string; gen: () => string; skipByDefault?: boolean }
const patches = (pairs: number) =>
  ({ desc: `${2 * pairs} link chunks (.org/.reloc)`, gen: () => genPatches(pairs) });
const ALL_SCENARIOS: Scenario[] = [
  { name: 'startup', desc: 'trivial (startup overhead)', gen: genTiny },
  // small/large/xlarge share genLarge so their times form a scaling curve.
  { name: 'small', desc: `${SMALL} instructions`, gen: () => genLarge(SMALL) },
  { name: 'large', desc: `${LARGE} instructions`, gen: () => genLarge(LARGE) },
  { name: 'xlarge', desc: `${XLARGE} instructions`, gen: () => genLarge(XLARGE) },
  { name: 'macros', desc: `${MACROS} macro invocations`, gen: () => genMacros(MACROS) },
  // patches* likewise form a scaling curve, but over link chunk count.
  { name: 'patches', ...patches(PATCH_PAIRS) },
  { name: 'patches-medium', ...patches(PATCH_PAIRS_MEDIUM) },
  { name: 'patches-large', ...patches(PATCH_PAIRS_LARGE) },
  // Minutes per frontend at the default size, so opt in by name.
  { name: 'patches-xlarge', ...patches(PATCH_PAIRS_XLARGE), skipByDefault: true },
];


interface Stats { min: number; max: number; avg: number; runs: number }
function summarize(xs: number[]): Stats {
  const sum = xs.reduce((a, b) => a + b, 0);
  return { min: Math.min(...xs), max: Math.max(...xs), avg: sum / xs.length, runs: xs.length };
}
const ms = (n: number) => `${n.toFixed(1)} ms`;
// unbuffered write so progress shows live even when stdout is piped
const say = (line = '') => process.stderr.write(line + '\n');

// Command line names frontends and/or scenarios, in any order and mixed
// freely; whichever kind goes unnamed keeps its default selection.
const args0 = Bun.argv.slice(2);
const frontendNames = new Set(FRONTENDS.map((f) => f.label));
const scenarioNames = new Set(ALL_SCENARIOS.map((s) => s.name));
const unknown = args0.filter((a) => !frontendNames.has(a) && !scenarioNames.has(a));
if (unknown.length > 0) {
  say(`unknown name(s): ${unknown.join(', ')}`);
  say(`frontends: ${[...frontendNames].join(', ')}`);
  say(`scenarios: ${[...scenarioNames].join(', ')}`);
  process.exit(1);
}
const filter = args0.filter((a) => frontendNames.has(a));
const scenarioFilter = args0.filter((a) => scenarioNames.has(a));

interface Frontend { label: string; path: string; size: number }
const frontends: Frontend[] = [];
for (const f of FRONTENDS) {
  if (filter.length > 0) {
    // Explicit list given: run exactly those, even skip-by-default ones.
    if (!filter.includes(f.label)) continue;
  } else if (f.skipByDefault) {
    say(`(skipping ${f.label} by default; run \`bun run bench -- ${f.label}\` to include it)`);
    continue;
  }
  if (!existsSync(f.path)) { say(`(skipping ${f.label}: ${f.path} not found)`); continue; }
  frontends.push({ ...f, size: statSync(f.path).size });
}
if (frontends.length === 0) { say('No frontend binaries found in ./build — build them first.'); process.exit(1); }

const scenarios: Scenario[] = [];
for (const s of ALL_SCENARIOS) {
  if (scenarioFilter.length > 0) {
    if (!scenarioFilter.includes(s.name)) continue;
  } else if (s.skipByDefault) {
    say(`(skipping ${s.name} by default; run \`bun run bench -- ${s.name}\` to include it)`);
    continue;
  }
  scenarios.push(s);
}
for (const s of scenarios) writeFileSync(`${DIR}/${s.name}.s`, s.gen());

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

say(`\njs65 frontend benchmark  (${RUNS} runs each, +${WARMUP} warmup; lower is better)`);
say(`frontends: ${frontends.map((f) => f.label).join(', ')}`);
say(`scenarios: ${scenarios.map((s) => s.name).join(', ')}\n`);

const results: Record<string, Record<string, Stats>> = {};
for (const s of scenarios) {
  results[s.name] = {};
  say(`* ${s.name} - ${s.desc}`);
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

// Prints the final comparison table
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
