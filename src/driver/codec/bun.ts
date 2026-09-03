// SPDX-License-Identifier: MPL-2.0

import type { GzipCodec } from './codec.ts';

declare const Bun: {
  gzipSync(data: Uint8Array, opts?: { level?: number }): Uint8Array;
  gunzipSync(data: Uint8Array): Uint8Array;
  deflateSync(data: Uint8Array, opts?: { level?: number }): Uint8Array;
};

function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Bun.deflateSync emits a raw stream and the UPNG library needs a zlib
// stream, so we wrap it in a small zlib compatible container.
function zlibWrap(raw: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  const sum = adler32(data);
  const end = raw.length + 2;
  out[end] = (sum >>> 24) & 0xff;
  out[end + 1] = (sum >>> 16) & 0xff;
  out[end + 2] = (sum >>> 8) & 0xff;
  out[end + 3] = sum & 0xff;
  return out;
}

export const bunCodec: GzipCodec = {
  gzip: (data) => Bun.gzipSync(data, { level: 1 }),
  gunzip: (data) => Bun.gunzipSync(data),
  deflate: (data, level) =>
      zlibWrap(Bun.deflateSync(data, level === undefined ? {} : { level }), data),
};
