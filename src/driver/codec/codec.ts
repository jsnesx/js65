// SPDX-License-Identifier: MPL-2.0

/**
 * Each frontend can bring their own gzip codec or use the built-in pako based gzip.
 * Its split into all these files so you only pay for what you need. Something like
 * hermes can use a native library for gzip, and bun/node have their own native
 * gzip libraries available too.
 */
export interface GzipCodec {
  /** Compress at level 1. No FNAME/mtime header if possible. */
  gzip(data: Uint8Array): Uint8Array;
  /** Decompress a gzip member. Throws on malformed/truncated input. */
  gunzip(data: Uint8Array): Uint8Array;
  /** Optional zlib deflate wrapper used by the UPNG library used in `.jsmodule png` */
  deflate?(data: Uint8Array, level?: number): Uint8Array;
}

let codec: GzipCodec | undefined;

export function setGzipCodec(c: GzipCodec): void {
  codec = c;
}

export function gzipCodec(): GzipCodec | undefined {
  return codec;
}
