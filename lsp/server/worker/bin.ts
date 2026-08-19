// SPDX-License-Identifier: MPL-2.0

import {parentPort, workerData} from 'node:worker_threads';
import {setGzipCodec} from '../../../src/driver/codec/codec.ts';
import {nodeZlibCodec} from '../../../src/driver/codec/node.ts';
import type {WorkerPort} from '../../../src/worker/port.ts';
import {serveLspWorker, type ServeOptions} from './handler.ts';

setGzipCodec(nodeZlibCodec);

if (!parentPort) {
  throw new Error('js65-lsp-worker must be loaded as a worker_threads worker');
}

const parent = parentPort;
const port: WorkerPort = {
  post: (message, transfer) => parent.postMessage(message, transfer ?? []),
  onMessage: (handler) => parent.on('message', handler),
};

serveLspWorker(port, (workerData ?? {}) as ServeOptions);
