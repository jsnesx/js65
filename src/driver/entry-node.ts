// SPDX-License-Identifier: MPL-2.0

import { setGzipCodec } from './codec/codec.ts';
import { nodeZlibCodec } from './codec/node.ts';

setGzipCodec(nodeZlibCodec);

export * from '../libassembler.ts';
