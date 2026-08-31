// SPDX-License-Identifier: MPL-2.0

import { setGzipCodec } from './codec/codec.ts';
import { bunCodec } from './codec/bun.ts';
import { setJsEngine } from './js/engine.ts';
import { functionEngine } from './js/function.ts';

setGzipCodec(bunCodec);
setJsEngine(functionEngine);

export * from '../libassembler.ts';
