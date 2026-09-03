// SPDX-License-Identifier: MPL-2.0

import { deflate, gzip, ungzip } from 'pako';
import type { GzipCodec } from './codec.ts';

export const pakoCodec: GzipCodec = {
  gzip: (data) => gzip(data, { level: 1 }),
  gunzip: (data) => ungzip(data),
  deflate: (data, level) => deflate(data, level === undefined ? {} : { level }),
};
