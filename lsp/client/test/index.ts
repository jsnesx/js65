// SPDX-License-Identifier: MPL-2.0

/** Mocha entry point, loaded inside the VS Code test instance. */

import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
		// Each test waits on a real assemble in a spawned server process.
		timeout: 60000,
	});

	// `JS65_TEST_GREP=<pattern> bun run test` narrows a run to one suite. Each test
	// waits on a real assemble, so a full run is slow to iterate against.
	if (process.env.JS65_TEST_GREP) mocha.grep(process.env.JS65_TEST_GREP);

	const testsRoot = __dirname;
	const files = await glob('**/*.test.js', { cwd: testsRoot });
	for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

	await new Promise<void>((resolve, reject) => {
		mocha.run(failures => {
			if (failures > 0) reject(new Error(`${failures} tests failed.`));
			else resolve();
		});
	});
}
