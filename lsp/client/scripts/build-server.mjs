// SPDX-License-Identifier: MPL-2.0

/**
 * Build the js65 language server and copy it into this extension.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(process.env.JS65_REPO ?? join(extensionRoot, '..', '..'));

/** Everything `dist` imports since node_modules isn't shipped */
const directDeps = [
	'pako',
	'sha1-uint8array',
	'vscode-languageserver',
	'vscode-languageserver-protocol',
	'vscode-languageserver-textdocument',
	'vscode-uri',
];

/** Walk through all deps to pull in transitive deps */
function allDependencies(names) {
	const found = new Map();
	const queue = names.map((name) => ({ name, from: join(repo, 'package.json') }));
	while (queue.length) {
		const { name, from } = queue.shift();
		if (found.has(name)) continue;
		let manifest;
		try {
			manifest = createRequire(from).resolve(`${name}/package.json`);
		} catch {
			console.error(`Cannot resolve ${name} from ${from}. Run \`bun install\` in ${repo} first.`);
			process.exit(1);
		}
		found.set(name, dirname(manifest));
		const deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {};
		queue.push(...Object.keys(deps).map((dep) => ({ name: dep, from: manifest })));
	}
	return found;
}

if (!existsSync(join(repo, 'package.json'))) {
	console.error(`js65 repo not found at ${repo}.`);
	console.error('Set JS65_REPO to your js65 checkout, e.g. JS65_REPO=~/src/js65 bun run build:server');
	process.exit(1);
}

console.log(`Building the language server in ${repo}...`);
const build = spawnSync('bun', ['run', 'build:npm'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.error || build.status !== 0) {
	console.error('`bun run build:npm` failed. Is bun installed and on PATH?');
	process.exit(build.status ?? 1);
}

const outDir = join(extensionRoot, 'server');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Source maps and declarations are for people debugging the assembler, not for
// the copy an editor spawns.
const skip = (src) => !src.endsWith('.map') && !src.endsWith('.d.ts');

cpSync(join(repo, 'dist'), join(outDir, 'dist'), { recursive: true, filter: skip });
cpSync(join(repo, 'integrations', 'npm'), join(outDir, 'integrations', 'npm'), { recursive: true });

for (const [dep, src] of allDependencies(directDeps)) {
	// A package manager may link these out of a content store, and a symlink cannot
	// be copied as a directory.
	cpSync(realpathSync(src), join(outDir, 'node_modules', dep), { recursive: true, filter: skip });
}

const esmMarker = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;
writeFileSync(join(outDir, 'dist', 'package.json'), esmMarker);
writeFileSync(join(outDir, 'integrations', 'package.json'), esmMarker);

console.log(`Copied the js65 package tree -> ${outDir}`);
