
// SPDX-License-Identifier: MPL-2.0

import { compileRequest, type CompileResult } from '../libassembler.ts';
import { fileCallbacksFor } from './filemap.ts';
import type { WorkerPort } from './port.ts';
import { PROTOCOL_VERSION, cancelSignal, collectTransfers, resetCancel, toWireError,
         type CompileRequestMessage, type ErrResponse, type OkResponse, type PingResponseValue,
         type Req, type Res } from './protocol.ts';

/** Sent once at startup so the worker can see the cancel flag the host allocated. */
export interface InitMessage {
  kind: 'init';
  cancelBuffer?: SharedArrayBuffer;
}

function isInit(message: unknown): message is InitMessage {
  return !!message && typeof message === 'object' && (message as InitMessage).kind === 'init';
}

function isRequest(message: unknown): message is Req {
  if (!message || typeof message !== 'object') return false;
  const {id, kind} = message as Partial<Req>;
  return typeof id === 'number' && typeof kind === 'string';
}

export function serveWorker(port: WorkerPort): void {
  let cancelFlag: Int32Array | undefined;
  const queue: Req[] = [];
  const cancelled = new Set<number>();
  let running = false;

  port.onMessage((message) => {
    if (isInit(message)) {
      cancelFlag = message.cancelBuffer ? new Int32Array(message.cancelBuffer) : undefined;
      return;
    }
    if (!isRequest(message)) return;
    if (message.v !== PROTOCOL_VERSION && message.kind !== 'ping') {
      respondErr(message.id, new Error(
          `Worker protocol version ${PROTOCOL_VERSION} does not match host ${message.v}. ` +
          `The worker bundle is probably stale.`));
      return;
    }
    // Cancels jump the queue: a queued target has to be marked before its turn comes up,
    // and a running one is only reachable through the flag anyway.
    if (message.kind === 'cancel') {
      cancelled.add(message.target);
      if (cancelFlag) {
        // No way to tell here whether the target is the request currently running, so trip
        // the flag unconditionally. A stale trip costs nothing: every request resets it.
        Atomics.store(cancelFlag, 0, 1);
      }
      respondOk(message.id, undefined);
      return;
    }
    queue.push(message);
    pump();
  });

  function pump(): void {
    if (running) return;
    running = true;
    try {
      let req: Req | undefined;
      while ((req = queue.shift()) !== undefined) {
        if (cancelled.delete(req.id)) {
          respondErr(req.id, new Error(`Request ${req.id} was cancelled`));
          continue;
        }
        dispatch(req);
      }
    } finally {
      running = false;
    }
  }

  function dispatch(req: Req): void {
    try {
      switch (req.kind) {
        case 'ping': {
          const value: PingResponseValue = {v: PROTOCOL_VERSION};
          respondOk(req.id, value);
          return;
        }
        case 'compile': {
          const result = runCompile(req);
          // Outputs are the bulk of the payload - a ROM plus a multi-MB .mlb - so hand
          // their buffers over rather than copying them.
          respondOk(req.id, result, collectTransfers(result.outputs));
          return;
        }
        default: {
          respondErr(req.id, new Error(`Unknown request kind: ${(req as {kind: string}).kind}`));
          return;
        }
      }
    } catch (err) {
      // A fault here is a bug in the worker, not a failed compile. Report it and stay up so
      // the next request still gets an answer.
      respondErr(req.id, err);
    }
  }

  function runCompile(req: CompileRequestMessage): CompileResult {
    // Clear whatever a previous run left behind so this one does not start out cancelled.
    if (cancelFlag) resetCancel(cancelFlag);
    const signal = cancelFlag ? cancelSignal(cancelFlag) : undefined;
    return compileRequest(req.request, fileCallbacksFor(req.files), req.baseRom, signal);
  }

  function respondOk(id: number, value: unknown, transfer?: ArrayBuffer[]): void {
    const res: OkResponse = {v: PROTOCOL_VERSION, id, ok: true, value};
    port.post(res, transfer);
  }

  function respondErr(id: number, err: unknown): void {
    const res: ErrResponse = {v: PROTOCOL_VERSION, id, ok: false, error: toWireError(err)};
    port.post(res);
  }
}

export type {Res};
