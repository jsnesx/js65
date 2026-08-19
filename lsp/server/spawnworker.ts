// SPDX-License-Identifier: MPL-2.0

import {Worker} from 'node:worker_threads';
import * as path from 'node:path';
import {existsSync} from 'node:fs';

import {nodeHostPort, type HostPort} from '../../src/worker/port.ts';
import type {ServeOptions} from './worker/handler.ts';

const WORKER_FILE = 'js65-lsp-worker.cjs';

/** Directories worth looking in, most specific first. */
function candidateDirs(): string[] {
  const dirs: string[] = [];
  const entry = process.argv[1];
  if (entry) dirs.push(path.dirname(path.resolve(entry)));
  // A CJS bundle also knows its own path; only useful when it was not the entry script.
  if (typeof require !== 'undefined' && require.main?.filename) {
    dirs.push(path.dirname(require.main.filename));
  }
  return [...new Set(dirs)];
}

/** Path of the worker bundle, or `undefined` when it was not shipped alongside the server. */
export function analyzerWorkerPath(): string | undefined {
  for (const dir of candidateDirs()) {
    const candidate = path.join(dir, WORKER_FILE);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function spawnAnalyzerWorker(options: ServeOptions = {}): HostPort {
  const workerPath = analyzerWorkerPath();
  if (!workerPath) {
    throw new Error(
        `js65-lsp: could not find ${WORKER_FILE} next to the server bundle. ` +
        `Build it with "bun run lsp-worker".`);
  }
  return nodeHostPort(new Worker(workerPath, {workerData: options}));
}
