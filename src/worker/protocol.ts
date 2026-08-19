
// SPDX-License-Identifier: MPL-2.0

import type {AssemblerMessage, SourceInfo} from '../error.ts';
import type {CancelSignal, CompileResult, Js65Request, OutputFile} from '../libassembler.ts';
import type {PreloadedFiles} from './filemap.ts';

export const PROTOCOL_VERSION = 1;

// -----
// Cancellation

/** Byte length of the cancel buffer: one `Int32` slot. */
export const CANCEL_BYTE_LENGTH = Int32Array.BYTES_PER_ELEMENT;

const CANCEL_SLOT = 0;

export const enum Cancel {
  RUNNING = 0,
  CANCELLED = 1,
}

/** Allocates the shared cancel flag, or `undefined` where shared memory is unavailable. */
export function allocateCancelBuffer(): SharedArrayBuffer | undefined {
  if (!sharedMemoryAvailable()) return undefined;
  return new SharedArrayBuffer(CANCEL_BYTE_LENGTH);
}

/** True when this runtime can share memory at all. Browsers need cross-origin isolation. */
export function sharedMemoryAvailable(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  const isolated = (globalThis as {crossOriginIsolated?: boolean}).crossOriginIsolated;
  // Node has no isolation concept and leaves the global undefined; only a browser that
  // explicitly reports false is actually unable to use shared memory.
  return isolated !== false;
}

/** Wraps the cancel flag in the shape the core polls per line. */
export function cancelSignal(flag: Int32Array): CancelSignal {
  return {
    get aborted() { return isCancelled(flag); },
  };
}

/** Host side: asks the worker to abandon whatever it is currently running. */
export function requestCancel(flag: Int32Array): void {
  Atomics.store(flag, CANCEL_SLOT, Cancel.CANCELLED);
}

/** Clears the flag so the next request does not start out already cancelled. */
export function resetCancel(flag: Int32Array): void {
  Atomics.store(flag, CANCEL_SLOT, Cancel.RUNNING);
}

export function isCancelled(flag: Int32Array): boolean {
  return Atomics.load(flag, CANCEL_SLOT) === Cancel.CANCELLED;
}

// -----
// Messages

/** Health check, also used to verify the worker was built from the same protocol. */
export interface PingRequest {
  v: typeof PROTOCOL_VERSION;
  id: number;
  kind: 'ping';
}

/** A full compile, carrying every file it could need. */
export interface CompileRequestMessage {
  v: typeof PROTOCOL_VERSION;
  id: number;
  kind: 'compile';
  /** JSON of a `Js65Request`. */
  request: string;
  /** Everything `.include`/`.incbin` may reach for, resolved entirely worker-side. */
  files: PreloadedFiles;
  baseRom?: Uint8Array;
  /**
   * Whether `baseRom`'s buffer may go in the transfer list. Host-owned by default, since
   * the caller usually wants to compile against it again.
   */
  transferBaseRom?: boolean;
}

/** Cancels `target`, whether it is queued or already running. */
export interface CancelRequestMessage {
  v: typeof PROTOCOL_VERSION;
  id: number;
  kind: 'cancel';
  target: number;
}

export type Req = PingRequest | CompileRequestMessage | CancelRequestMessage;

/** Serialized form of a thrown value. Structured clone drops prototypes and custom fields. */
export interface WireError {
  /** `err.name` for an `Error`, `'Error'` otherwise. */
  name: string;
  message: string;
  stack?: string;
  asMessage: AssemblerMessage;
}

export interface OkResponse {
  v: typeof PROTOCOL_VERSION;
  id: number;
  ok: true;
  value: unknown;
}

export interface ErrResponse {
  v: typeof PROTOCOL_VERSION;
  id: number;
  ok: false;
  error: WireError;
}

export type Res = OkResponse | ErrResponse;

/** Narrows a worker message to a response with an `id`, i.e. not a notification. */
export function isCorrelated(res: {id?: number}): res is Res {
  return 'id' in res;
}

/** The `value` of a successful `ping` response. */
export interface PingResponseValue {
  v: number;
}

/** The `value` of a successful `compile` response. */
export type CompileResponseValue = CompileResult;

// Re-exported so the client can type a compile request without importing the assembler.
export type {CompileResult, Js65Request, OutputFile};

// -----
// Error serialization

/** Ducktyped version of SourceInfo so we don't drag in error.ts */
function sourceOf(err: unknown): SourceInfo | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const source = (err as {source?: unknown}).source;
  if (!source || typeof source !== 'object') return undefined;
  const {file, line, column} = source as Partial<SourceInfo>;
  if (typeof file !== 'string' || typeof line !== 'number') return undefined;
  return {...(source as SourceInfo), file, line, column: column ?? 0};
}

export function toWireError(err: unknown): WireError {
  const isError = err instanceof Error;
  const name = isError ? err.name : 'Error';
  const message = isError ? err.message : String(err);
  const stack = isError ? err.stack : undefined;
  const source = sourceOf(err);
  return {
    name,
    message,
    stack,
    asMessage: {level: 'error', message, source, stack},
  };
}

/** Rebuild a throwable from a `WireError`, keeping the original name and stack. */
export function fromWireError(wire: WireError): Error {
  const err = new Error(wire.message);
  err.name = wire.name;
  if (wire.stack) err.stack = wire.stack;
  return err;
}

// -----
// Transfers

/** Buffers to hand to `postMessage`'s transfer list for a set of outputs. */
export function collectTransfers(outputs: readonly OutputFile[]): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const transfers: ArrayBuffer[] = [];
  for (const out of outputs) {
    const buffer = out.data?.buffer;
    // A SharedArrayBuffer is not transferable, and detaching one would be meaningless.
    if (!(buffer instanceof ArrayBuffer)) continue;
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    transfers.push(buffer);
  }
  return transfers;
}
