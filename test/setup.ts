// SPDX-License-Identifier: MPL-2.0

// Since we run tests in bun, this file sets up the bunCodec before running tests
// See bunfig.toml

import { setGzipCodec } from '../src/driver/codec/codec.ts';
import { bunCodec } from '../src/driver/codec/bun.ts';

setGzipCodec(bunCodec);
