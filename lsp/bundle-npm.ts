// SPDX-License-Identifier: MPL-2.0

// Rebundle the lsp server so npm installed js65 doesn't bring in the lsp
// If you still want the lsp, it's in the dist folder not in the regular bundle.

import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const serverSrc = join(repo, 'lsp', 'server');
const outDir = join(repo, 'dist', 'lsp', 'server');
const shared = [join(serverSrc, 'earlyworker.ts')];

function isInlined(file: string): boolean {
  return file.startsWith(serverSrc + sep) && !shared.includes(file);
}

// Point a shared source file at its tsc-emitted twin in dist.
function distSpecifier(file: string): string {
  const emitted = join(repo, 'dist', relative(repo, file)).replace(/\.ts$/, '.js');
  const spec = relative(outDir, emitted).split(sep).join('/');
  return spec.startsWith('.') ? spec : `./${spec}`;
}

for (const name of readdirSync(outDir)) {
  if (!name.startsWith('earlyworker.')) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

// Original specifier -> dist specifier. Bun ignores the `path` an onResolve
// returns for an external and emits the original specifier, so the specifiers
// are rewritten in the output instead.
const rewrites = new Map<string, string>();

const result = await Bun.build({
  entrypoints: [join(serverSrc, 'entry.ts')],
  outdir: outDir,
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
  plugins: [{
    name: 'keep-shared-external',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.importer.includes(`${sep}node_modules${sep}`)) return undefined;
        const file = resolve(dirname(args.importer), args.path);
        if (isInlined(file)) return undefined;
        const spec = distSpecifier(file);
        const prev = rewrites.get(args.path);
        // The output loses the importer, so one specifier must mean one file.
        if (prev != null && prev !== spec) {
          throw new Error(`${args.path} resolves to both ${prev} and ${spec}`);
        }
        rewrites.set(args.path, spec);
        return { path: spec, external: true };
      });
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const out of result.outputs) {
  if (out.kind !== 'entry-point' && out.kind !== 'chunk') continue;
  let code = await Bun.file(out.path).text();
  for (const [from, to] of rewrites) {
    const re = new RegExp(`(\\b(?:from|import)\\s*\\(?\\s*)(["'])${escape(from)}\\2`, 'g');
    code = code.replace(re, `$1$2${to}$2`);
  }
  await Bun.write(out.path, code);
}
