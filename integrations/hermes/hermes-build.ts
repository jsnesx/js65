/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Build the Static Hermes js65 frontend (build/js65, the default js65 binary). Four steps:
//   1. bun-bundle integrations/hermes/hermes.ts -> one inlined script
//   2. shermes -exported-unit js65 -c   -> the compiled unit object (no main)
//   3. clang++ the C++ host (integrations/hermes/hermes_host.cpp)
//   4. clang++ link unit + host + the static Hermes VM libs -> exe
//
// Runs on Windows, macOS and Linux. All machine-specific locations come from
// the environment. For local development put them in a git-ignored `.env.local`
// (bun loads it automatically). See `.env.example` for the full list. The CI
// workflow sets the same variables. To build this, run `bun run hermes-exe`

import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const exe = isWin ? '.exe' : '';
const env = (k: string, d: string) => process.env[k] ?? d;

// --- locations -----------------------------------------------------------
// HERMES_SRC defaults to a sibling checkout; everything else derives from it.
const HERMES_SRC = env('HERMES_SRC', '../hermes');
const HERMES_BUILD = env('HERMES_BUILD', `${HERMES_SRC}/build`);
// Multi-config generators (MSVC) nest outputs under a per-config dir; single
// config generators (Ninja/Make) don't. Defaults: Release on Windows, none
// elsewhere. Override with HERMES_CONFIG (set it empty for a Ninja build).
const CONFIG = env('HERMES_CONFIG', isWin ? 'Release' : '');
const cfg = (p: string) => (CONFIG ? `${p}/${CONFIG}` : p);

// Compilers: plain `clang`/`clang++` from PATH unless LLVM_BIN or CLANG/CLANGXX
// are given. shermes needs a GNU-style driver, so its CC is clang too.
const LLVM_BIN = env('LLVM_BIN', '');
const bin = (name: string) => (LLVM_BIN ? `${LLVM_BIN}/${name}${exe}` : name);
const CLANG = env('CLANG', bin('clang'));
const CLANGXX = env('CLANGXX', bin('clang++'));
const SHERMES = env('SHERMES', `${cfg(`${HERMES_BUILD}/bin`)}/shermes${exe}`);

const OUT = `build/js65${exe}`;

// Hermes doesn't have a deployment option right now, so the best we can do is
// just list out the locations for our include path from the source itself
const INC = [
  `${HERMES_BUILD}/lib/config`,
  `${HERMES_SRC}/include`,
  `${HERMES_SRC}/public`,
  `${HERMES_SRC}/API`,
  `${HERMES_SRC}/API/jsi`,
];

const LIBDIRS = [
  cfg(`${HERMES_BUILD}/lib`),
  cfg(`${HERMES_BUILD}/tools/shermes`),
  cfg(`${HERMES_BUILD}/jsi`),
  // Evaluate the fallback lazily so it only scans (and throws) when the env
  // override is absent.
  process.env.HERMES_BOOST_CONTEXT_DIR ?? findBoostContextDir(),
];


// List of platform libraries we need to include in the link for hermes
// just found through trial error.
const PLATFORM_LIBS = isWin
  ? ['winmm', 'icuuc', 'icuin']
  : isLinux
    ? ['dl', 'pthread', 'icui18n', 'icuuc', 'icudata']
    : [];
const LIBS = ['hermesvm_a', 'shermes_console_a', 'jsi', 'boost_context', ...PLATFORM_LIBS];

// On macOS, hermesvm uses CoreFoundation (CFLocale/CFString/CFDateFormatter)
// for Unicode instead of ICU, so link the framework. Frameworks aren't -l libs;
// they need their own -framework flag.
const MAC_FRAMEWORKS = isMac ? ['-framework', 'CoreFoundation'] : [];

// Match the CRT/STL the Hermes libs were built with. On Windows the prebuilt
// libs use the dynamic CRT (/MD); elsewhere the default STL already matches.
const CRT = isWin ? ['-fms-runtime-lib=dll'] : [];

// Build our own objects as LTO bitcode too, so the final link can optimize
// across them and the Hermes VM/JSI libraries. CMake's
// INTERPROCEDURAL_OPTIMIZATION emits ThinLTO for clang, so match that mode
// Mac's default linker already supports LTO so we don't need to specify lld
const LTO = ['-flto=thin'];
const LINKER = isMac ? [] : ['-fuse-ld=lld'];

// The shared library link (-shared) needs position-independent code; the same PIC
// objects link fine into the executable, so build PIC once and reuse for both. On
// Windows PIC is the default / not a concept, so these are no-ops. Hidden visibility
// keeps everything but the JS65_EXPORT-marked C ABI out of the .so/.dylib symbol table.
const PIC = isWin ? [] : ['-fPIC'];
const VISIBILITY = isWin ? [] : ['-fvisibility=hidden'];

// boost_context lives under external/boost/<version>/libs/context; the version
// is pinned by the Hermes build, so locate it rather than hard-code it. Fail
// loudly if it can't be found so the error is actionable, instead of guessing a
// version that produces a confusing linker error later. Override with
// HERMES_BOOST_CONTEXT_DIR if the layout differs.
function findBoostContextDir(): string {
  const base = `${HERMES_BUILD}/external/boost`;
  try {
    for (const d of readdirSync(base)) {
      if (existsSync(`${base}/${d}/libs/context`)) return cfg(`${base}/${d}/libs/context`);
    }
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    `could not locate boost_context under ${base}. ` +
    `Build Static Hermes first, or set HERMES_BOOST_CONTEXT_DIR explicitly.`,
  );
}

// --- runner --------------------------------------------------------------
function run(label: string, cmd: string, args: string[], extraEnv: Record<string, string> = {}) {
  process.stderr.write(`  STAGE: ${label}\n`);
  const r = spawnSync(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...extraEnv },
  });
  if (r.error) {
    process.stderr.write(`\nFAILED (${label}): ${r.error.message}\n`);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.stderr.write(`\nFAILED (${label}): ${cmd} exited ${r.status}\n`);
    process.exit(1);
  }
}

// 1. bundle
run('bundle', 'bun', [
  'build', './integrations/hermes/hermes.ts',
  '--outfile', './build/hermes.bundle.js',
  '--format', 'esm', '--target', 'node',
]);

// 2. compile the JS unit to an object file (no main; main lives in the host)
run('shermes unit', SHERMES, [
  '-exported-unit', 'js65', '-c',
  `-Wc,-I${HERMES_BUILD}/lib/config`, `-Wc,-I${HERMES_SRC}/include`,
  ...LTO.map((f) => `-Wc,${f}`),
  ...PIC.map((f) => `-Wc,${f}`),
  '-o', 'build/hermes.unit.o', 'build/hermes.bundle.js',
], { CC: CLANG });

// 3. compile the C++ host sources. hermes_core.cpp is the shared runtime/bindings core;
// hermes_host.cpp is the CLI entry (main + stdin/stdout); hermes_lib.cpp is the shared
// library entry (the js65_compile C ABI). All share one set of flags.
const compile = (src: string, obj: string) =>
  run(`clang++ ${src}`, CLANGXX, [
    '-c', '-std=c++17', '-O2', ...CRT, ...LTO, ...PIC, ...VISIBILITY,
    ...INC.map((i) => `-I${i}`),
    `integrations/hermes/${src}`, '-o', `build/${obj}`,
  ]);
compile('hermes_core.cpp', 'hermes_core.o');
compile('hermes_host.cpp', 'hermes_host.o');
compile('hermes_lib.cpp', 'hermes_lib.o');

// 4. link the unit + core + an entry object against the static Hermes VM libs.
const link = (out: string, entryObj: string, extra: string[]) =>
  run(`link ${out}`, CLANGXX, [
    ...CRT, ...LTO, ...LINKER, ...extra,
    'build/hermes.unit.o', 'build/hermes_core.o', `build/${entryObj}`, '-o', out,
    ...LIBDIRS.map((d) => `-L${d}`),
    ...LIBS.map((l) => `-l${l}`),
    ...MAC_FRAMEWORKS,
  ]);

// The CLI executable...
link(OUT, 'hermes_host.o', []);
// ...and the shared library used by the in-process .NET js65.hermes engine.
const DLL = `build/${isWin ? 'js65.dll' : isMac ? 'libjs65.dylib' : 'libjs65.so'}`;
link(DLL, 'hermes_lib.o', ['-shared']);

process.stderr.write(`\nBuilt ${OUT}\nBuilt ${DLL}\n`);
