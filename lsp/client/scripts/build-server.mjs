// SPDX-License-Identifier: MPL-2.0

/**
 * Build the js65 language server and copy the bundle into this extension.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(process.env.JS65_REPO ?? join(extensionRoot, '..', '..'));
const bundleName = 'js65-lsp.cjs';

if (!existsSync(join(repo, 'package.json'))) {
	console.error(`js65 repo not found at ${repo}.`);
	console.error('Set JS65_REPO to your js65 checkout, e.g. JS65_REPO=~/src/js65 npm run build:server');
	process.exit(1);
}

console.log(`Building the language server in ${repo}...`);
const build = spawnSync('bun', ['run', 'lsp'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.error || build.status !== 0) {
	console.error('`bun run lsp` failed. Is bun installed and on PATH?');
	process.exit(build.status ?? 1);
}

const built = join(repo, 'build', bundleName);
if (!existsSync(built)) {
	console.error(`Build reported success but ${built} is missing.`);
	process.exit(1);
}

const outDir = join(extensionRoot, 'server');
mkdirSync(outDir, { recursive: true });
copyFileSync(built, join(outDir, bundleName));
console.log(`Copied ${built} -> ${join(outDir, bundleName)}`);
