// SPDX-License-Identifier: MPL-2.0

import type { GzipCodec } from './codec.ts';

declare const __js65_gzip: (data: Uint8Array) => Uint8Array;
declare const __js65_gunzip: (data: Uint8Array) => Uint8Array;

export const hermesCodec: GzipCodec = {
  gzip: (data) => __js65_gzip(data),
  gunzip: (data) => __js65_gunzip(data),
};
