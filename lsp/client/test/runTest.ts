// SPDX-License-Identifier: MPL-2.0

/**
 * Downloads a VS Code build and runs the end-to-end suite inside it.
 *
 * `testFixture/` is opened as the workspace folder so the extension activates
 * on a real `js65.json` project — project discovery is part of what these tests
 * are checking, and it doesn't happen without a folder open.
 */

import * as path from 'path';
import { pathToFileURL } from 'url';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
	try {
		// VS Code sets this in the environment of its own integrated terminal and
		// of anything an extension spawns. `runTests` passes our environment
		// through, and the downloaded build is an Electron binary: with this set
		// it starts as a plain Node process and rejects every VS Code flag with
		// `bad option: --extensionTestsPath=...`. Running the suite from inside
		// VS Code is the normal case, so clear it rather than document it.
		delete process.env.ELECTRON_RUN_AS_NODE;

		const extensionDevelopmentPath = path.resolve(__dirname, '../../');
		const extensionTestsPath = path.resolve(__dirname, './index');
		const workspace = path.resolve(extensionDevelopmentPath, 'testFixture');

		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				// `--folder-uri` rather than a bare path: a positional argument
				// alongside `--extensionTestsPath` is taken as a script to run.
				`--folder-uri=${pathToFileURL(workspace).toString()}`,
				// Other language extensions would fight over `.s` files and slow
				// the run down; nothing here needs them.
				'--disable-extensions',
			],
		});
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exit(1);
	}
}

void main();
