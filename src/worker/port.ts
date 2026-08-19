
// SPDX-License-Identifier: MPL-2.0

export interface WorkerPort {
  /** Sends a message, optionally handing ownership of `transfer`'s buffers to the peer. */
  post(message: unknown, transfer?: ArrayBuffer[]): void;
  /** Registers the sole message listener. Calling it again replaces the previous one. */
  onMessage(handler: (message: unknown) => void): void;
}

/** Host side of a port, which can also shut the worker down. */
export interface HostPort extends WorkerPort {
  terminate(): void | Promise<unknown>;
}

/** The browser `Worker` surface these adapters use. Declared rather than pulling in a lib. */
interface BrowserWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: 'message', handler: (event: {data: unknown}) => void): void;
  terminate(): void;
}

/** The node `worker_threads` surface these adapters use. */
interface NodeWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  on(event: 'message', handler: (message: unknown) => void): unknown;
  terminate(): unknown;
}

/** Wraps a browser `Worker` so the client can drive it. */
export function browserHostPort(worker: BrowserWorkerLike): HostPort {
  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onMessage: (handler) => worker.addEventListener('message', (event) => handler(event.data)),
    terminate: () => worker.terminate(),
  };
}

/** Wraps a node (or bun) `worker_threads` `Worker` so the client can drive it. */
export function nodeHostPort(worker: NodeWorkerLike): HostPort {
  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onMessage: (handler) => { worker.on('message', handler); },
    terminate: () => { void worker.terminate(); },
  };
}
