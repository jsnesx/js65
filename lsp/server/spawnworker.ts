// SPDX-License-Identifier: MPL-2.0

import {Worker} from 'node:worker_threads';

import {nodeHostPort, type HostPort} from '../../src/worker/port.ts';
import type {ServeOptions} from './worker/handler.ts';

function selfEntry(): string {
  const entry = process.argv[1];
  if (entry) return entry;
  // A CJS bundle knows its own path even when it was not the entry script.
  if (typeof require !== 'undefined' && require.main?.filename) {
    return require.main.filename;
  }
  throw new Error(
      'js65-lsp: cannot find the js65 entry script to run the analyzer worker.');
}

export function spawnAnalyzerWorker(options: ServeOptions = {}): HostPort {
  return nodeHostPort(new Worker(selfEntry(), {
    argv: ['lsp', '--worker'],
    workerData: options,
  }));
}
