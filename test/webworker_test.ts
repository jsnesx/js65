// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {Worker as NodeWorker} from 'node:worker_threads';
import {compile, deserializeObjectFile, searchFiles, type AssemblyInput,
        type FileCallbacks} from '../src/libassembler.ts';
import {SourceError} from '../src/error.ts';
import {joinDir} from '../src/util.ts';
import {toPosix} from '../src/driver/project.ts';
import {fileCallbacksFor, type PreloadedFiles} from '../src/worker/filemap.ts';
import {Js65Worker} from '../src/worker/client.ts';
import {serveWorker} from '../src/worker/handler.ts';
import {nodeHostPort, type HostPort, type WorkerPort} from '../src/worker/port.ts';
import {CANCEL_BYTE_LENGTH, PROTOCOL_VERSION, cancelSignal, collectTransfers, fromWireError,
        isCancelled, isCorrelated, requestCancel, resetCancel, sharedMemoryAvailable,
        toWireError, type Res} from '../src/worker/protocol.ts';

const HEADER = `
.segment "HEADER" :bank $00 :size $0010 :mem $0000 :off $00000
.segment "PRG"    :bank $00 :size $8000 :mem $8000 :off $00010
.segment "CHR"    :bank $00 :size $2000 :mem $0000 :off $08010
`;

function source(code: string, name = 'test.s'): AssemblyInput {
  return {type: 'source', code, name};
}

/** The map-backed frontend and a disk-style one have to agree, so build both from one fixture. */
function fixtureFiles(): PreloadedFiles {
  return new Map<string, string | Uint8Array>([
    ['/proj/inc/hdr.inc', HEADER],
    ['/proj/inc/nested/deep.inc', 'DEEP = $42\n'],
    ['/proj/data/blob.bin', new Uint8Array([1, 2, 3, 4])],
  ]);
}

/** Same lookup rule as `fileCallbacksFor`, but built the way the CLI/LSP build theirs. */
function searchFilesOver(files: PreloadedFiles): FileCallbacks {
  const read = (base: string, rel: string) => {
    const key = joinDir(toPosix(base), toPosix(rel));
    if (!files.has(key)) throw new Error(`ENOENT ${key}`);
    return files.get(key)!;
  };
  return {
    resolveText: searchFiles((base, rel) => {
      const found = read(base, rel);
      return typeof found === 'string' ? found : undefined;
    }),
    resolveBinary: searchFiles(read),
  };
}

describe('worker protocol', function() {
  describe('structured clone round trips', function() {
    it('round trips a real CompileResult carrying messages and source locations', function() {
      const result = compile([source(`${HEADER}.segment "PRG"\n.org $8000\n.include "hdr.inc"\nlda #$42\n`)],
                             {includePaths: ['/proj/inc'], generateDebugInfo: true},
                             fileCallbacksFor(fixtureFiles()));
      const res: Res = {v: PROTOCOL_VERSION, id: 7, ok: true, value: result};
      const clone = structuredClone(res) as typeof res;
      expect(clone).toEqual(res);
      // A class instance in a result type survives clone() as a bare object, so compare
      // the reconstructed bytes rather than trusting deep equality alone.
      const value = (clone as {value: typeof result}).value;
      expect(value.outputs[0].data).toBeInstanceOf(Uint8Array);
      expect(Array.from(value.outputs[0].data)).toEqual(Array.from(result.outputs[0].data));
    });

    it('round trips a failure result with its messages intact', function() {
      const result = compile([source('lda #$zz\n')], {});
      expect(result.success).toBe(false);
      const res: Res = {v: PROTOCOL_VERSION, id: 1, ok: true, value: result};
      expect(structuredClone(res)).toEqual(res);
    });

    it('round trips an error response', function() {
      const res: Res = {v: PROTOCOL_VERSION, id: 2, ok: false, error: toWireError(new Error('boom'))};
      expect(structuredClone(res)).toEqual(res);
    });

    it('round trips a preloaded file map with both content kinds', function() {
      const files = fixtureFiles();
      const clone = structuredClone(files);
      expect(clone.get('/proj/inc/hdr.inc')).toBe(HEADER);
      expect(clone.get('/proj/data/blob.bin')).toBeInstanceOf(Uint8Array);
      expect(Array.from(clone.get('/proj/data/blob.bin') as Uint8Array)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('error serialization', function() {
    it('carries name, message and stack for a plain Error', function() {
      const wire = toWireError(new TypeError('nope'));
      expect(wire.name).toBe('TypeError');
      expect(wire.message).toBe('nope');
      expect(wire.stack).toBeTruthy();
      expect(fromWireError(wire).name).toBe('TypeError');
    });

    it('surfaces a SourceError location as an AssemblerMessage rather than dropping it', function() {
      const err = new SourceError('bad thing', {file: 'test.s', line: 12, column: 3});
      const wire = toWireError(err);
      expect(wire.asMessage.level).toBe('error');
      expect(wire.asMessage.message).toContain('bad thing');
      expect(wire.asMessage.source).toEqual({file: 'test.s', line: 12, column: 3});
    });

    it('handles a non-Error throw', function() {
      const wire = toWireError('just a string');
      expect(wire.name).toBe('Error');
      expect(wire.message).toBe('just a string');
      expect(wire.stack).toBeUndefined();
      expect(wire.asMessage.source).toBeUndefined();
    });

    it('narrows a correlated response', function() {
      expect(isCorrelated({v: PROTOCOL_VERSION, id: 1, ok: true, value: null} as Res)).toBe(true);
      expect(isCorrelated({} as {id?: number})).toBe(false);
    });
  });

  describe('collectTransfers', function() {
    it('dedupes two views over one ArrayBuffer into a single entry', function() {
      const buffer = new ArrayBuffer(16);
      const transfers = collectTransfers([
        {name: 'a.nes', data: new Uint8Array(buffer, 0, 8), type: 'binary'},
        {name: 'b.mlb', data: new Uint8Array(buffer, 8, 8), type: 'debug'},
      ]);
      expect(transfers).toEqual([buffer]);
    });

    it('lists distinct buffers separately and skips shared ones', function() {
      const a = new Uint8Array(4);
      const b = new Uint8Array(4);
      expect(collectTransfers([
        {name: 'a', data: a, type: 'binary'},
        {name: 'b', data: b, type: 'debug'},
      ])).toEqual([a.buffer as ArrayBuffer, b.buffer as ArrayBuffer]);
      if (typeof SharedArrayBuffer !== 'undefined') {
        const shared = new Uint8Array(new SharedArrayBuffer(4));
        expect(collectTransfers([{name: 's', data: shared, type: 'binary'}])).toEqual([]);
      }
    });
  });

  describe('cancel flag', function() {
    it('flips the signal and resets back', function() {
      const flag = new Int32Array(new ArrayBuffer(CANCEL_BYTE_LENGTH));
      const signal = cancelSignal(flag);
      expect(signal.aborted).toBe(false);
      requestCancel(flag);
      expect(signal.aborted).toBe(true);
      expect(isCancelled(flag)).toBe(true);
      resetCancel(flag);
      expect(signal.aborted).toBe(false);
    });

    it('reports shared memory availability without throwing', function() {
      expect(typeof sharedMemoryAvailable()).toBe('boolean');
    });
  });
});

describe('worker file map', function() {
  it('resolves a hit in the first base', function() {
    const cb = fileCallbacksFor(fixtureFiles());
    expect(cb.resolveText(['/proj/inc', '/proj/other'], 'hdr.inc'))
        .toEqual({baseIndex: 0, content: HEADER});
  });

  it('resolves a hit in a later base and reports that base index', function() {
    const cb = fileCallbacksFor(fixtureFiles());
    const bases = ['/a', '/b', '/c', '/d', '/proj/inc'];
    expect(cb.resolveText(bases, 'nested/deep.inc'))
        .toEqual({baseIndex: 4, content: 'DEEP = $42\n'});
  });

  it('returns undefined for a miss', function() {
    const cb = fileCallbacksFor(fixtureFiles());
    expect(cb.resolveText(['/proj/inc'], 'missing.inc')).toBeUndefined();
    expect(cb.resolveBinary(['/proj/data'], 'missing.bin')).toBeUndefined();
  });

  it('returns binary content as bytes, not base64', function() {
    const cb = fileCallbacksFor(fixtureFiles());
    const found = cb.resolveBinary(['/proj/data'], 'blob.bin');
    expect(found?.content).toBeInstanceOf(Uint8Array);
    expect(Array.from(found!.content as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it('does not hand a binary entry back as text', function() {
    const cb = fileCallbacksFor(fixtureFiles());
    expect(cb.resolveText(['/proj/data'], 'blob.bin')).toBeUndefined();
  });

  it('encodes a text entry read as binary rather than letting it be base64-decoded', function() {
    // `compile` treats a string from `resolveBinary` as base64, so handing one straight back
    // would silently corrupt a text file pulled in with `.incbin`.
    const cb = fileCallbacksFor(fixtureFiles());
    const found = cb.resolveBinary(['/proj/inc'], 'nested/deep.inc');
    expect(found?.content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(found!.content as Uint8Array)).toBe('DEEP = $42\n');
  });

  it('reads a text file through .incbin without corrupting it', function() {
    const files = fixtureFiles();
    const input = source(
        `${HEADER}.segment "PRG"\n.org $8000\n.incbin "nested/deep.inc"\n`);
    const result = compile([input], {binIncludePaths: ['/proj/inc'], lineContinuations: true},
                           fileCallbacksFor(files));
    expect(result.success).toBe(true);
    const rom = result.outputs[0].data;
    const text = new TextDecoder().decode(rom.slice(0x10, 0x10 + 'DEEP = $42\n'.length));
    expect(text).toBe('DEEP = $42\n');
  });

  it('agrees with searchFiles() over the same fixture', function() {
    const files = fixtureFiles();
    const map = fileCallbacksFor(files);
    const disk = searchFilesOver(files);
    const cases: [string[], string][] = [
      [['/proj/inc'], 'hdr.inc'],
      [['/a', '/b', '/proj/inc'], 'nested/deep.inc'],
      [['/proj/inc'], 'nope.inc'],
      [['/proj/inc/nested', '/proj/inc'], 'hdr.inc'],
    ];
    for (const [bases, name] of cases) {
      expect(map.resolveText(bases, name)).toEqual(disk.resolveText(bases, name));
    }
    expect(map.resolveBinary(['/proj/data'], 'blob.bin'))
        .toEqual(disk.resolveBinary(['/proj/data'], 'blob.bin'));
  });

  it('compiles an include chain to the same bytes as a searchFiles frontend', function() {
    const files = fixtureFiles();
    const input = source(
        `${HEADER}.segment "PRG"\n.org $8000\n.include "nested/deep.inc"\nlda #DEEP\n`);
    const opts = {includePaths: ['/proj/inc'], lineContinuations: true};
    const viaMap = compile([input], opts, fileCallbacksFor(files));
    const viaDisk = compile([input], opts, searchFilesOver(files));
    expect(viaMap.success).toBe(true);
    expect(Array.from(viaMap.outputs[0].data)).toEqual(Array.from(viaDisk.outputs[0].data));
  });
});

// -----
// Stage 2: handler and client over an in-process fake port.

/**
 * A pair of ports wired to each other, delivering messages on a microtask so ordering is
 * deterministic without a real thread. `sent` keeps everything the worker posted, so a test
 * can assert on the wire rather than only on the promise.
 */
function fakePortPair() {
  let hostHandler: ((m: unknown) => void) | undefined;
  let workerHandler: ((m: unknown) => void) | undefined;
  const sent: unknown[] = [];
  const hostToWorker: unknown[] = [];
  let terminated = false;
  const workerPort: WorkerPort = {
    post(message) {
      sent.push(message);
      if (terminated) return;
      queueMicrotask(() => hostHandler?.(message));
    },
    onMessage(handler) { workerHandler = handler; },
  };
  const hostPort: HostPort = {
    post(message) {
      hostToWorker.push(message);
      if (terminated) return;
      queueMicrotask(() => workerHandler?.(message));
    },
    onMessage(handler) { hostHandler = handler; },
    terminate() { terminated = true; },
  };
  return {hostPort, workerPort, sent, hostToWorker};
}

/** A fake port pair with the real handler on one end and the real client on the other. */
function connected() {
  const pair = fakePortPair();
  serveWorker(pair.workerPort);
  return {...pair, client: new Js65Worker(pair.hostPort)};
}

/** The shared cancel flag, read back off the `init` message the client posts on construction. */
function cancelFlagOf(pair: ReturnType<typeof fakePortPair>): Int32Array | undefined {
  const init = pair.hostToWorker.find(m => (m as {kind?: string}).kind === 'init') as
      {cancelBuffer?: SharedArrayBuffer} | undefined;
  return init?.cancelBuffer ? new Int32Array(init.cancelBuffer) : undefined;
}

/** Answers only the handshake, so a test can drive responses by hand. */
function handshakeOnly(pair: ReturnType<typeof fakePortPair>) {
  pair.workerPort.onMessage((message) => {
    const req = message as {id: number, kind: string};
    if (req.kind !== 'ping') return;
    pair.workerPort.post({v: PROTOCOL_VERSION, id: req.id, ok: true, value: {v: PROTOCOL_VERSION}});
  });
}

function requestJson(code: string, options: Record<string, unknown> = {}): string {
  return JSON.stringify({inputs: [source(code)], options: {lineContinuations: true, ...options}});
}

/** Lets every queued microtask and timer callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('worker handler', function() {
  it('answers ping with a matching protocol version', async function() {
    const {client, sent} = connected();
    await client.ready();
    const ping = sent[0] as {ok: boolean, value: {v: number}};
    expect(ping.ok).toBe(true);
    expect(ping.value.v).toBe(PROTOCOL_VERSION);
  });

  it('rejects when the worker answers a different protocol version', async function() {
    const pair = fakePortPair();
    // A worker built against an older protocol still answers, just with the wrong v.
    pair.workerPort.onMessage((message) => {
      const req = message as {id: number, kind: string};
      if (req.kind !== 'ping') return;
      pair.workerPort.post({v: PROTOCOL_VERSION, id: req.id, ok: true, value: {v: 99}});
    });
    const client = new Js65Worker(pair.hostPort);
    await expect(client.ready()).rejects.toThrow(/does not match host/);
  });

  it('compiles an include chain from the preloaded map to the same bytes as in-process', async function() {
    const {client} = connected();
    const files = fixtureFiles();
    const code = `${HEADER}.segment "PRG"\n.org $8000\n.include "nested/deep.inc"\nlda #DEEP\n`;
    const options = {lineContinuations: true, includePaths: ['/proj/inc']};
    const direct = compile([source(code)], options, fileCallbacksFor(files));
    const viaWorker = await client.compile({
      request: JSON.stringify({inputs: [source(code)], options}),
      files,
    });
    expect(viaWorker.success).toBe(true);
    expect(Array.from(viaWorker.outputs[0].data)).toEqual(Array.from(direct.outputs[0].data));
  });

  it('reports a failed compile as ok:true carrying a failure result, not a rejection', async function() {
    const {client, sent} = connected();
    const result = await client.compile({request: requestJson('lda #$zz\n')});
    expect(result.success).toBe(false);
    expect(result.messages.some(m => m.level === 'error')).toBe(true);
    expect((sent as {ok: boolean}[]).every(m => m.ok)).toBe(true);
  });

  it('reports a missing include as a failure result rather than a fault', async function() {
    const {client} = connected();
    const result = await client.compile({
      request: requestJson('.include "nowhere.inc"\n'),
      files: new Map(),
    });
    expect(result.success).toBe(false);
    expect(result.messages.some(m => /Could not find file/.test(m.message))).toBe(true);
  });

  it('replies ok:false on an internal fault and stays up for the next request', async function() {
    const pair = fakePortPair();
    serveWorker(pair.workerPort);
    pair.hostPort.post({v: PROTOCOL_VERSION, id: 1, kind: 'bogus'});
    pair.hostPort.post({v: PROTOCOL_VERSION, id: 2, kind: 'ping'});
    await settle();
    const responses = pair.sent as {id: number, ok: boolean, error?: {message: string}}[];
    expect(responses[0]).toMatchObject({id: 1, ok: false});
    expect(responses[0].error!.message).toMatch(/Unknown request kind/);
    expect(responses[1]).toMatchObject({id: 2, ok: true});
  });

  it('correlates ids when responses arrive out of order', async function() {
    const pair = fakePortPair();
    handshakeOnly(pair);
    const client = new Js65Worker(pair.hostPort);
    await client.ready();
    const first = client.compile({request: requestJson('lda #$01\n')});
    const second = client.compile({request: requestJson('lda #$02\n')});
    await settle();
    const [idA, idB] = (pair.hostToWorker as {id: number, kind: string}[])
        .filter(m => m.kind === 'compile').map(m => m.id);
    const reply = (id: number, tag: string) => pair.workerPort.post({
      v: PROTOCOL_VERSION, id, ok: true,
      value: {success: true, outputs: [], messages: [{level: 'info', message: tag}]},
    });
    reply(idB, 'B');
    reply(idA, 'A');
    expect((await first).messages[0].message).toBe('A');
    expect((await second).messages[0].message).toBe('B');
  });

  it('rejects in-flight promises on terminate', async function() {
    const pair = fakePortPair();
    handshakeOnly(pair); // A compile is deliberately left unanswered.
    const client = new Js65Worker(pair.hostPort);
    await client.ready();
    const inFlight = client.compile({request: requestJson('lda #$01\n')});
    await client.terminate();
    await expect(inFlight).rejects.toThrow(/terminated/);
  });

  it('drops a queued request when it is cancelled before it runs', async function() {
    const pair = fakePortPair();
    serveWorker(pair.workerPort);
    // Post the compile and its cancel in the same tick so the cancel is seen first; the
    // handler takes cancels ahead of the queue precisely so this is possible.
    pair.hostPort.post({v: PROTOCOL_VERSION, id: 5, kind: 'cancel', target: 6});
    pair.hostPort.post({
      v: PROTOCOL_VERSION, id: 6, kind: 'compile',
      request: requestJson('lda #$01\n'), files: new Map(),
    });
    await settle();
    const forCompile = (pair.sent as {id: number, ok: boolean, error?: {message: string}}[])
        .find(m => m.id === 6);
    expect(forCompile).toMatchObject({ok: false});
    expect(forCompile!.error!.message).toMatch(/cancelled/);
  });

  it('does not detach a base ROM unless the caller asks for it', async function() {
    const {client} = connected();
    const baseRom = new Uint8Array(64);
    await client.compile({request: requestJson('lda #$01\n'), baseRom});
    expect(baseRom.byteLength).toBe(64);
  });

  it('errors a request from a host on another protocol version rather than dropping it', async function() {
    // A stale worker bundle. The version gate used to drop the message silently, which left
    // the host awaiting a reply that was never coming.
    const pair = fakePortPair();
    serveWorker(pair.workerPort);
    pair.hostPort.post({
      v: PROTOCOL_VERSION + 1, id: 1, kind: 'compile',
      request: requestJson('lda #$01\n'), files: new Map(),
    });
    await settle();
    const res = (pair.sent as {id: number, ok: boolean, error?: {message: string}}[])
        .find(m => m.id === 1);
    expect(res).toMatchObject({ok: false});
    expect(res!.error!.message).toMatch(/does not match host/);
  });

  it('still answers a ping from a host on another protocol version', async function() {
    // The ping is the version check itself, so it has to get past the gate that check exists
    // to trip, or the handshake never settles either way.
    const pair = fakePortPair();
    serveWorker(pair.workerPort);
    pair.hostPort.post({v: PROTOCOL_VERSION + 1, id: 1, kind: 'ping'});
    await settle();
    const res = pair.sent.find(m => (m as {id?: number}).id === 1) as
        {ok: boolean, value: {v: number}} | undefined;
    expect(res).toMatchObject({ok: true});
    expect(res!.value.v).toBe(PROTOCOL_VERSION);
  });
});

describe('worker cancellation', function() {
  it('trips the shared flag only for the request the worker is actually inside', async function() {
    if (!sharedMemoryAvailable()) return;
    const pair = fakePortPair();
    handshakeOnly(pair); // Neither compile is ever answered; both stay in flight.
    const client = new Js65Worker(pair.hostPort);
    await client.ready();
    const flag = cancelFlagOf(pair)!;
    const idA = client.peekNextId();
    const first = client.compile({request: requestJson('lda #$01\n')}).catch(() => undefined);
    const idB = client.peekNextId();
    const second = client.compile({request: requestJson('lda #$02\n')}).catch(() => undefined);
    await settle();

    // B is behind A in the worker's queue, so aborting B must not reach into A's run.
    client.cancel(idB);
    expect(isCancelled(flag)).toBe(false);
    client.cancel(idA);
    expect(isCancelled(flag)).toBe(true);

    await client.terminate();
    await Promise.all([first, second]);
  });

  it('leaves a cancel for the running compile set when the next one is posted', async function() {
    if (!sharedMemoryAvailable()) return;
    const pair = fakePortPair();
    handshakeOnly(pair);
    const client = new Js65Worker(pair.hostPort);
    await client.ready();
    const flag = cancelFlagOf(pair)!;
    const idA = client.peekNextId();
    const first = client.compile({request: requestJson('lda #$01\n')}).catch(() => undefined);
    await settle();
    client.cancel(idA);
    expect(isCancelled(flag)).toBe(true);

    // Cancel and rebuild: clearing the flag here would wipe the abort A has not polled yet.
    const second = client.compile({request: requestJson('lda #$02\n')}).catch(() => undefined);
    await settle();
    expect(isCancelled(flag)).toBe(true);

    await client.terminate();
    await Promise.all([first, second]);
  });

  it('clears a stale cancel as the worker picks the next compile up', async function() {
    if (!sharedMemoryAvailable()) return;
    // The counterpart to the test above: nothing on the host resets the flag any more, so a
    // request left cancelled must not bleed into the compile that follows it.
    const pair = fakePortPair();
    serveWorker(pair.workerPort);
    const client = new Js65Worker(pair.hostPort);
    await client.ready();
    const flag = cancelFlagOf(pair)!;
    requestCancel(flag);
    const result = await client.compile({
      request: requestJson(`${HEADER}.segment "PRG"\n.org $8000\nlda #$42\n`),
    });
    expect(result.success).toBe(true);
    expect(isCancelled(flag)).toBe(false);
  });

  it('gives peekNextId the id the compile takes, even before the handshake settles', async function() {
    // The documented use: peek an id, start a compile, cancel it without awaiting. The id
    // used to be allocated after the handshake await, so the cancel in between stole it.
    const pair = fakePortPair();
    let ping: {id: number} | undefined;
    pair.workerPort.onMessage((message) => {
      const req = message as {id: number, kind: string};
      if (req.kind === 'ping') ping = req;
    });
    const client = new Js65Worker(pair.hostPort);
    await settle();
    const id = client.peekNextId();
    const pending = client.compile({request: requestJson('lda #$01\n')}).catch(() => undefined);
    client.cancel(id);
    // Only now does the handshake land, releasing the compile that was suspended on it.
    pair.workerPort.post({v: PROTOCOL_VERSION, id: ping!.id, ok: true, value: {v: PROTOCOL_VERSION}});
    await settle();

    const posted = pair.hostToWorker as {id: number, kind: string, target?: number}[];
    expect(posted.find(m => m.kind === 'compile')!.id).toBe(id);
    expect(posted.find(m => m.kind === 'cancel')!.target).toBe(id);

    await client.terminate();
    await pending;
  });
});

// -----
// Stage 3: a real spawned worker. Kept to the handful of cases where actually crossing a
// thread boundary is the thing under test.

const WORKER_ENTRY = new URL('../src/driver/entry-worker-node.ts', import.meta.url);

/** Spawns the node/bun worker entry and wraps it for the client. */
function spawnWorker(): {client: Js65Worker, worker: NodeWorker} {
  const worker = new NodeWorker(WORKER_ENTRY);
  // Nothing else keeps the suite alive while a compile runs, and an unref'd worker would
  // let bun exit out from under it.
  return {client: new Js65Worker(nodeHostPort(worker)), worker};
}

describe('spawned worker', function() {
  it('compiles a multi-directory include chain to the same bytes as in-process', async function() {
    const {client} = spawnWorker();
    try {
      const files = new Map<string, string | Uint8Array>([
        ['/proj/inc/hdr.inc', HEADER],
        ['/proj/inc/nested/deep.inc', 'DEEP = $42\n'],
        ['/proj/other/extra.inc', 'EXTRA = $17\n'],
      ]);
      const code = `${HEADER}.segment "PRG"\n.org $8000\n` +
          `.include "nested/deep.inc"\n.include "extra.inc"\nlda #DEEP\nldx #EXTRA\n`;
      const options = {lineContinuations: true, includePaths: ['/proj/inc', '/proj/other']};
      const direct = compile([source(code)], options, fileCallbacksFor(files));
      expect(direct.success).toBe(true);
      const viaWorker = await client.compile({
        request: JSON.stringify({inputs: [source(code)], options}),
        files,
      });
      expect(viaWorker.success).toBe(true);
      expect(Array.from(viaWorker.outputs[0].data)).toEqual(Array.from(direct.outputs[0].data));
    } finally {
      await client.terminate();
    }
  });

  it('names the base an include actually resolved under in the debug info', async function() {
    const {client} = spawnWorker();
    try {
      const files = new Map<string, string | Uint8Array>([
        ['/proj/second/deep.inc', 'lda #$42\n'],
      ]);
      const code = `${HEADER}.segment "PRG"\n.org $8000\n.include "deep.inc"\n`;
      const options = {
        lineContinuations: true,
        includePaths: ['/proj/first', '/proj/second'],
        generateDebugInfo: true,
        debugLevel: 2,
      };
      const result = await client.compile({
        request: JSON.stringify({inputs: [source(code)], options}),
        files,
      });
      expect(result.success).toBe(true);
      const debug = result.outputs.find(o => o.type === 'debug');
      expect(debug).toBeTruthy();
      const text = new TextDecoder().decode(debug!.data);
      // The second base is the one that has the file; the first must not show up.
      expect(text).toContain('/proj/second/deep.inc');
      expect(text).not.toContain('/proj/first/deep.inc');
    } finally {
      await client.terminate();
    }
  });

  it('registers its own gzip codec, so an object file round trips host-side', async function() {
    const {client} = spawnWorker();
    try {
      const code = `${HEADER}.segment "PRG"\n.org $8000\nlda #$42\n`;
      const result = await client.compile({
        request: JSON.stringify({
          inputs: [source(code)],
          options: {lineContinuations: true, outputFormat: 'object'},
        }),
      });
      expect(result.success).toBe(true);
      const obj = result.outputs.find(o => o.type === 'object');
      expect(obj).toBeTruthy();
      // Would throw "no gzip codec" if bunfig's preload were what registered it, since a
      // spawned worker never sees that.
      expect(deserializeObjectFile(obj!.data)).toBeTruthy();
    } finally {
      await client.terminate();
    }
  });

  it('aborts a running compile when the cancel flag is flipped mid-assemble', async function() {
    if (!sharedMemoryAvailable()) return; // Degraded mode has nothing to assert here.
    const {client} = spawnWorker();
    try {
      await client.ready();
      expect(client.canCancelRunning).toBe(true);
      // Long enough that the flag lands while the core is still walking lines.
      const code = `${HEADER}.segment "PRG"\n.org $8000\n` + 'lda #$01\n'.repeat(200000);
      const id = client.peekNextId();
      const pending = client.compile({
        request: JSON.stringify({inputs: [source(code)], options: {lineContinuations: true}}),
      });
      setTimeout(() => client.cancel(id), 30);
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.messages.some(m => /cancel/i.test(m.message))).toBe(true);
    } finally {
      await client.terminate();
    }
  });

  it('does not detach a base ROM across two compiles against it', async function() {
    const {client} = spawnWorker();
    try {
      const initCode = `.macpack common\n${HEADER}FREE "PRG" [$8000, $10000)\n`;
      const code = `.segment "PRG"\n.org $8000\nlda #$42\n`;
      const baseRom = new Uint8Array(0xa010);
      const request = JSON.stringify({
        inputs: [source(initCode, 'init.s'), source(code)],
        options: {lineContinuations: true},
      });
      const first = await client.compile({request, baseRom});
      expect(baseRom.byteLength).toBe(0xa010);
      const second = await client.compile({request, baseRom});
      expect(baseRom.byteLength).toBe(0xa010);
      expect(first.success).toBe(true);
      expect(Array.from(second.outputs[0].data)).toEqual(Array.from(first.outputs[0].data));
    } finally {
      await client.terminate();
    }
  });
});

describe('worker bundle boundary', function() {
  it('keeps the assembler out of a bundle that only talks to the worker', async function() {
    // The whole point of `client.ts` importing nothing but `protocol.ts` and types: a page
    // that merely drives a worker must not ship the assembler alongside it.
    const built = await Bun.build({
      entrypoints: ['./src/worker/client.ts'],
      target: 'browser',
      format: 'esm',
    });
    expect(built.success).toBe(true);
    const code = await built.outputs[0].text();
    for (const symbol of ['class Assembler', 'class Tokenizer', 'class Linker', 'macpack']) {
      expect(code).not.toContain(symbol);
    }
    // A few KB of message plumbing, not a few hundred KB of assembler.
    expect(code.length).toBeLessThan(64 * 1024);
  });
});
