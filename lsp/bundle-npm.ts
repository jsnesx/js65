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
        return { path: distSpecifier(file), external: true };
      });
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
