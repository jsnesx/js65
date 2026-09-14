// SPDX-License-Identifier: MPL-2.0

import {parentPort} from 'node:worker_threads';

import type {WorkerPort} from '../../src/worker/port.ts';

const buffered: unknown[] = [];
let capturing = false;
let handler: ((message: unknown) => void) | undefined;

/**
 * Bun has an issue where if the worker starts after the client, then any messages the client
 * sent are lost. In node the messages are buffered for the late connecting worker.
 * We work around it by buffering the messages immediately.
 * We need this workaround in both the bun and node entry points since the test cases that
 * run the node entrypoint still use bun to run them and so the error can happen there too.
 */
export function bufferWorkerMessages(): void {
  if (!parentPort || capturing) return;
  if (typeof (globalThis as {Bun?: unknown}).Bun !== 'object') return;
  capturing = true;
  parentPort.on('message', (message: unknown) => {
    if (handler) handler(message);
    else buffered.push(message);
  });
}

/** Start the listen and replay any captured messages. */
export function replayBufferedMessages(): WorkerPort {
  const parent = parentPort;
  if (!parent) {
    throw new Error('js65 lsp --worker must be loaded as a worker_threads worker');
  }
  return {
    post: (message, transfer) => parent.postMessage(message, transfer ?? []),
    onMessage: (h) => {
      if (!capturing) {
        parent.on('message', h);
        return;
      }
      handler = h;
      for (const message of buffered.splice(0, buffered.length)) h(message);
    },
  };
}
