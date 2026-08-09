// SPDX-License-Identifier: MPL-2.0

/**
 * Stage the repo's license into the extension folder so it ships inside the
 * VSIX. MPL-2.0 requires the license to travel with the distributed form, and
 * vsce only picks up a `LICENSE*` that sits next to `package.json`.
 *
 * The copy is generated so the repo keeps a single source of truth at the root.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(extensionRoot, '..', '..', 'LICENSE.txt');

if (!existsSync(source)) {
	console.error(`No license found at ${source}.`);
	process.exit(1);
}

const dest = join(extensionRoot, 'LICENSE.txt');
copyFileSync(source, dest);
console.log(`Copied ${source} -> ${dest}`);
