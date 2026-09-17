// SPDX-License-Identifier: MPL-2.0

/**
 * Build the js65 language server and copy it into this extension.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(process.env.JS65_REPO ?? join(extensionRoot, '..', '..'));

if (!existsSync(join(repo, 'package.json'))) {
	console.error(`js65 repo not found at ${repo}.`);
	console.error('Set JS65_REPO to your js65 checkout, e.g. JS65_REPO=~/src/js65 bun run build:server');
	process.exit(1);
}

console.log(`Building the language server in ${repo}...`);
const build = spawnSync('bun', ['run', 'node'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.error || build.status !== 0) {
	console.error('`bun run node` failed. Is bun installed and on PATH?');
	process.exit(build.status ?? 1);
}

const bundle = join(repo, 'build', 'js65-node.mjs');
if (!existsSync(bundle)) {
	console.error(`Expected a bundle at ${bundle} but the build produced none.`);
	process.exit(1);
}

const outDir = join(extensionRoot, 'server');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(bundle, join(outDir, 'js65.mjs'));

console.log(`Copied the js65 bundle -> ${join(outDir, 'js65.mjs')}`);
