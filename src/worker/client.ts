
// SPDX-License-Identifier: MPL-2.0

import type { HostPort } from './port.ts';
import type { PreloadedFiles } from './filemap.ts';

// The adapters live in `port.ts` so the worker half can use `WorkerPort` without pulling in
// the client, but a host only ever needs this module.
export { browserHostPort, nodeHostPort, type HostPort, type WorkerPort } from './port.ts';
export type { PreloadedFiles } from './filemap.ts';
import { PROTOCOL_VERSION, allocateCancelBuffer, fromWireError, isCorrelated, requestCancel,
         type CancelRequestMessage, type CompileRequestMessage, type CompileResult,
         type Js65Request, type PingRequest, type PingResponseValue, type Res,
         type WireError } from './protocol.ts';

/** Everything one compile needs, with the files it may read handed over up front. */
export interface CompileOptions {
  /** JSON of a `Js65Request`, or the request itself. */
  request: string | Js65Request;
  /** Absolute POSIX path -> contents, covering every `.include`/`.incbin` reachable. */
  files?: PreloadedFiles;
  baseRom?: Uint8Array;
  /**
   * Hand `baseRom`'s buffer to the worker instead of copying it. Detaches it host-side, so
   * only pass it when this host will not compile against that ROM again.
   */
  transferBaseRom?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export class Js65Worker {
  private readonly pending = new Map<number, Pending>();
  /** Compile ids posted and not yet settled, in post order. See `cancel`. */
  private readonly running: number[] = [];
  private nextId = 1;
  private readonly cancelBuffer?: SharedArrayBuffer;
  private readonly cancelFlag?: Int32Array;
  private readonly handshake: Promise<void>;
  private closed?: Error;

  constructor(private readonly port: HostPort) {
    this.cancelBuffer = allocateCancelBuffer();
    this.cancelFlag = this.cancelBuffer ? new Int32Array(this.cancelBuffer) : undefined;
    this.port.onMessage((message) => this.receive(message));
    this.port.post({kind: 'init', cancelBuffer: this.cancelBuffer});
    this.handshake = this.ping();
    // Nothing has awaited ready() yet, so a version mismatch would otherwise surface as an
    // unhandled rejection. The rejection is still delivered to whoever awaits it later.
    this.handshake.catch(() => {});
  }

  get canCancelRunning(): boolean {
    return this.cancelFlag !== undefined;
  }

  /** Resolves once the worker has answered the version handshake. */
  ready(): Promise<void> {
    return this.handshake;
  }

  async compile(options: CompileOptions): Promise<CompileResult> {
    // Allocated before the first await, so `peekNextId()` still names this request even when
    // the handshake has not settled and the call suspends here.
    const id = this.nextId++;
    await this.handshake;
    const request = typeof options.request === 'string'
        ? options.request : JSON.stringify(options.request);
    const message: CompileRequestMessage = {
      v: PROTOCOL_VERSION,
      id,
      kind: 'compile',
      request,
      files: options.files ?? new Map(),
      baseRom: options.baseRom,
      transferBaseRom: options.transferBaseRom,
    };
    // Request-direction buffers stay host-owned unless the caller says otherwise; detaching
    // a base ROM the caller means to reuse would break the next compile against it.
    const transfer = options.transferBaseRom && options.baseRom
        ? [options.baseRom.buffer as ArrayBuffer] : undefined;
    // The worker clears the flag as it picks each compile up. Clearing it here instead would
    // race a cancel just issued for the compile still running, wiping it before that one's
    // polling loop ever saw it.
    this.running.push(id);
    try {
      return await this.send(id, message, transfer) as CompileResult;
    } finally {
      const at = this.running.indexOf(id);
      if (at >= 0) this.running.splice(at, 1);
    }
  }

  cancel(id: number): void {
    if (this.closed) return;
    // One flag is shared by every request, so tripping it for a queued id would abort the
    // compile the worker is actually inside. The worker takes compiles in the order they
    // were posted, which makes the oldest unsettled one the only possible occupant.
    if (this.cancelFlag && this.running[0] === id) requestCancel(this.cancelFlag);
    const message: CancelRequestMessage = {
      v: PROTOCOL_VERSION, id: this.nextId++, kind: 'cancel', target: id,
    };
    this.port.post(message);
  }

  peekNextId(): number {
    return this.nextId;
  }

  /** Shuts the worker down and rejects everything still in flight. */
  async terminate(): Promise<void> {
    this.fail(new Error('Worker terminated'));
    await this.port.terminate();
  }

  private async ping(): Promise<void> {
    const id = this.nextId++;
    const message: PingRequest = {v: PROTOCOL_VERSION, id, kind: 'ping'};
    const value = await this.send(id, message) as PingResponseValue;
    if (value?.v !== PROTOCOL_VERSION) {
      const err = new Error(
          `Worker protocol version ${value?.v} does not match host ${PROTOCOL_VERSION}. ` +
          `The worker bundle is probably stale.`);
      this.fail(err);
      throw err;
    }
  }

  private send(id: number, message: unknown, transfer?: ArrayBuffer[]): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      try {
        this.port.post(message, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private receive(message: unknown): void {
    const res = message as Res;
    if (!res || typeof res !== 'object' || !isCorrelated(res)) return;
    const pending = this.pending.get(res.id);
    if (!pending) return; // A cancelled or already-settled request; nothing to do.
    this.pending.delete(res.id);
    if (res.ok) pending.resolve(res.value);
    else pending.reject(fromWireError(res.error as WireError));
  }

  private fail(err: Error): void {
    this.closed = err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}
