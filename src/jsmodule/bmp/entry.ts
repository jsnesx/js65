// SPDX-License-Identifier: MPL-2.0

// The `bmp` module for `.jsmodule bmp`

import { decode, encode } from './vendor/index.ts';
import type { BmpPaletteColor, EncodeBitDepth } from './vendor/types.ts';

type Rgb = readonly [number, number, number];

interface LoadOptions {
  palette?: readonly Rgb[];
  exact?: boolean;
}

interface IndexedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: Rgb[];
}

interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

interface EncodeOptions {
  bits?: EncodeBitDepth;
  palette?: readonly Rgb[];
}

function toRgb(entry: BmpPaletteColor): Rgb {
  return [entry.red, entry.green, entry.blue];
}

function toPaletteColor([red, green, blue]: Rgb): BmpPaletteColor {
  return { red, green, blue, quad: 0 };
}

function checkPalette(palette: readonly Rgb[]): void {
  if (!palette.length) throw new Error('bmp: palette is empty');
  for (const [i, entry] of palette.entries()) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new Error(`bmp: palette[${i}] is not an [r, g, b] triple`);
    }
    for (const c of entry) {
      if (!Number.isInteger(c) || c < 0 || c > 255) {
        throw new Error(`bmp: palette[${i}] has a channel outside 0-255: ${entry.join()}`);
      }
    }
  }
}

/** Maps straight RGBA to palette indices, erroring on an unmapped color by default. */
function indexRgba(data: Uint8Array, width: number, palette: readonly Rgb[],
                   exact: boolean): Uint8Array {
  const lookup = new Map<number, number>();
  for (let i = palette.length - 1; i >= 0; i--) {
    const [r, g, b] = palette[i];
    lookup.set((r << 16) | (g << 8) | b, i);
  }
  const out = new Uint8Array(data.length / 4);
  for (let p = 0; p < out.length; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    const hit = lookup.get((r << 16) | (g << 8) | b);
    if (hit !== undefined) {
      out[p] = hit;
      continue;
    }
    if (exact) {
      const x = p % width, y = (p - x) / width;
      throw new Error(
          `bmp: color rgb(${r}, ${g}, ${b}) at (${x}, ${y}) is not in the palette. ` +
          `Pass {exact: false} to take the nearest match instead.`);
    }
    out[p] = nearest(r, g, b, palette);
  }
  return out;
}

function nearest(r: number, g: number, b: number, palette: readonly Rgb[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** RGBA to the ABGR the vendored encoder reads. */
function rgbaToAbgr(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = data[i + 3];
    out[i + 1] = data[i + 2];
    out[i + 2] = data[i + 1];
    out[i + 3] = data[i];
  }
  return out;
}

function loadRgba(bytes: Uint8Array): RgbaImage {
  const d = decode(bytes, { toRGBA: true });
  return { width: d.width, height: d.height, data: d.data };
}

function load(bytes: Uint8Array, opts: LoadOptions = {}): IndexedImage {
  const d = decode(bytes, { toRGBA: true });
  const { width, height } = d;

  // An indexed source carries its own indices, so no palette is needed and none is
  // guessed at: the file's order is preserved exactly as authored.
  if (d.indices && d.palette) {
    const palette = d.palette.map(toRgb);
    const skipped = d.indices.indexOf(palette.length);
    if (skipped >= 0) {
      const x = skipped % width, y = (skipped - x) / width;
      throw new Error(
          `bmp: the RLE data leaves the pixel at (${x}, ${y}) undefined, ` +
          `so it has no palette index`);
    }
    return { width, height, pixels: d.indices, palette };
  }

  if (!opts.palette) {
    throw new Error(
        `bmp: this is a ${d.bitPP}-bit image with no palette of its own, so ` +
        `.load needs one: bmp.load(bytes, {palette: [[r, g, b], ...]})`);
  }
  checkPalette(opts.palette);
  const palette = opts.palette.map(e => [...e] as unknown as Rgb);
  return {
    width, height, palette,
    pixels: indexRgba(d.data, width, palette, opts.exact !== false),
  };
}

function encodeImage(image: RgbaImage | IndexedImage, opts: EncodeOptions = {}): Uint8Array {
  const { width, height } = image;
  const palette = opts.palette ?? ('palette' in image ? image.palette : undefined);
  let rgba: Uint8Array;

  if ('pixels' in image) {
    if (!palette) throw new Error('bmp.encode: an indexed image needs a palette');
    checkPalette(palette);
    rgba = new Uint8Array(width * height * 4);
    for (let p = 0; p < image.pixels.length; p++) {
      const entry = palette[image.pixels[p]];
      if (!entry) {
        throw new Error(
            `bmp.encode: pixel ${p} has index ${image.pixels[p]}, ` +
            `outside a palette of ${palette.length}`);
      }
      rgba[p * 4] = entry[0];
      rgba[p * 4 + 1] = entry[1];
      rgba[p * 4 + 2] = entry[2];
      rgba[p * 4 + 3] = 0xff;
    }
  } else {
    rgba = image.data;
  }

  const bits = opts.bits ?? (palette ? 8 : 24);
  return encode({ data: rgbaToAbgr(rgba), width, height }, {
    bitPP: bits,
    palette: palette?.map(toPaletteColor) ?? [],
  }).data;
}

return {
  load,
  loadRgba,
  encode: encodeImage,
  lib: { decode, encode },
};
