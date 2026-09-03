
// SPDX-License-Identifier: MPL-2.0

import { parentPort } from 'node:worker_threads';
import { setGzipCodec } from './codec/codec.ts';
import { nodeZlibCodec } from './codec/node.ts';
import { setJsEngine } from './js/engine.ts';
import { functionEngine } from './js/function.ts';
import { serveWorker } from '../worker/handler.ts';
import type { WorkerPort } from '../worker/port.ts';

setGzipCodec(nodeZlibCodec);
setJsEngine(functionEngine);

if (!parentPort) {
  throw new Error('entry-worker-node must be loaded as a worker_threads worker');
}

const parent = parentPort;
const port: WorkerPort = {
  post: (message, transfer) => parent.postMessage(message, transfer ?? []),
  onMessage: (handler) => parent.on('message', handler),
};

serveWorker(port);
