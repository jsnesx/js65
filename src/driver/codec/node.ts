// SPDX-License-Identifier: MPL-2.0

import { createRequire } from 'node:module';
import type { GzipCodec } from './codec.ts';

type Zlib = typeof import('node:zlib');

let z: Zlib | undefined;
const zlib = (): Zlib =>
    (z ??= (process as { getBuiltinModule?: (id: string) => Zlib }).getBuiltinModule?.('node:zlib')
        ?? createRequire(import.meta.url)('node:zlib'));

// node:zlib returns a Buffer (a Uint8Array subclass)
// normalize to a plain Uint8Array so it matches other codecs.
function toUint8Array(buf: Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export const nodeZlibCodec: GzipCodec = {
  gzip: (data) => toUint8Array(zlib().gzipSync(data, { level: 1 })),
  gunzip: (data) => toUint8Array(zlib().gunzipSync(data)),
};
