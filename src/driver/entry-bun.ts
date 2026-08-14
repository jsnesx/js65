// SPDX-License-Identifier: MPL-2.0

import { setGzipCodec } from './codec/codec.ts';
import { bunCodec } from './codec/bun.ts';

setGzipCodec(bunCodec);

export * from '../libassembler.ts';
