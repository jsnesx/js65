// SPDX-License-Identifier: MPL-2.0

import {setGzipCodec} from '../../src/driver/codec/codec.ts';
import {nodeZlibCodec} from '../../src/driver/codec/node.ts';
import {setJsEngine} from '../../src/driver/js/engine.ts';
import {functionEngine} from '../../src/driver/js/function.ts';

export function installNodeHost(): void {
  setGzipCodec(nodeZlibCodec);
  setJsEngine(functionEngine);
}
