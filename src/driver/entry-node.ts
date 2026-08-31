// SPDX-License-Identifier: MPL-2.0

import { setGzipCodec } from './codec/codec.ts';
import { nodeZlibCodec } from './codec/node.ts';
import { setJsEngine } from './js/engine.ts';
import { functionEngine } from './js/function.ts';

setGzipCodec(nodeZlibCodec);
setJsEngine(functionEngine);

export * from '../libassembler.ts';
