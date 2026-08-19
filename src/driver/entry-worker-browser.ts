
// SPDX-License-Identifier: MPL-2.0

import { setGzipCodec } from './codec/codec.ts';
import { pakoCodec } from './codec/pako.ts';
import { serveWorker } from '../worker/handler.ts';
import type { WorkerPort } from '../worker/port.ts';

setGzipCodec(pakoCodec);

// Just the slice of DedicatedWorkerGlobalScope this file touches, declared locally rather
// than pulling the whole "WebWorker" lib into every tsconfig that compiles src/.
declare const self: {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: 'message', handler: (event: {data: unknown}) => void): void;
};

const port: WorkerPort = {
  post: (message, transfer) => self.postMessage(message, transfer ?? []),
  onMessage: (handler) => self.addEventListener('message', (event) => handler(event.data)),
};

serveWorker(port);
