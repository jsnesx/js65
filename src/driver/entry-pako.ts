// SPDX-License-Identifier: MPL-2.0

import { setGzipCodec } from './codec/codec.ts';
import { pakoCodec } from './codec/pako.ts';

setGzipCodec(pakoCodec);

export * from '../libassembler.ts';
