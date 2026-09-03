// SPDX-License-Identifier: MPL-2.0

import { setGzipCodec } from './codec/codec.ts';
import { pakoCodec } from './codec/pako.ts';
import { setJsEngine } from './js/engine.ts';
import { functionEngine } from './js/function.ts';

setGzipCodec(pakoCodec);
setJsEngine(functionEngine);

export * from '../libassembler.ts';
