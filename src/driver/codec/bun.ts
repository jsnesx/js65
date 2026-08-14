// SPDX-License-Identifier: MPL-2.0

import type { GzipCodec } from './codec.ts';

declare const Bun: {
  gzipSync(data: Uint8Array, opts?: { level?: number }): Uint8Array;
  gunzipSync(data: Uint8Array): Uint8Array;
};

export const bunCodec: GzipCodec = {
  gzip: (data) => Bun.gzipSync(data, { level: 1 }),
  gunzip: (data) => Bun.gunzipSync(data),
};
