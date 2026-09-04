// SPDX-License-Identifier: MPL-2.0

// The `png` module for `.jsmodule png`

import { UPNG } from './vendor/UPNG.js';

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
  palette?: readonly Rgb[];
  colors?: number;
}

function checkPalette(palette: readonly Rgb[]): void {
  if (!palette.length) throw new Error('png: palette is empty');
  for (const [i, entry] of palette.entries()) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new Error(`png: palette[${i}] is not an [r, g, b] triple`);
    }
    for (const c of entry) {
      if (!Number.isInteger(c) || c < 0 || c > 255) {
        throw new Error(`png: palette[${i}] has a channel outside 0-255: ${entry.join()}`);
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
          `png: color rgb(${r}, ${g}, ${b}) at (${x}, ${y}) is not in the palette. ` +
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

/**
 * Reads indices straight out of the unfiltered bitstream, the same row-padded arithmetic
 * UPNG's own toRGBA8 does. Avoiding the RGBA round-trip keeps duplicate palette entries
 * distinct and preserves index order as authored.
 */
function unpackIndices(data: Uint8Array, width: number, height: number,
                       depth: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const bpl = Math.ceil(width * depth / 8);
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    const s0 = y * bpl, t0 = y * width;
    for (let x = 0; x < width; x++) {
      const shift = 8 - depth - (x % perByte) * depth;
      out[t0 + x] = (data[s0 + Math.floor(x / perByte)] >> shift) & mask;
    }
  }
  return out;
}

function paletteFrom(plte: number[]): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < plte.length; i += 3) out.push([plte[i], plte[i + 1], plte[i + 2]]);
  return out;
}

function loadRgba(bytes: Uint8Array): RgbaImage {
  const d = UPNG.decode(bytes);
  return {
    width: d.width,
    height: d.height,
    data: new Uint8Array(UPNG.toRGBA8(d)[0]),
  };
}

function load(bytes: Uint8Array, opts: LoadOptions = {}): IndexedImage {
  const d = UPNG.decode(bytes);
  const { width, height } = d;

  // An indexed source carries its own indices, so no palette is needed and none is
  // guessed at: the file's order is preserved exactly as authored.
  if (d.ctype === 3) {
    const plte = d.tabs['PLTE'];
    if (!plte) throw new Error('png: an indexed PNG with no PLTE chunk');
    return {
      width, height,
      pixels: unpackIndices(d.data, width, height, d.depth),
      palette: paletteFrom(plte),
    };
  }

  if (!opts.palette) {
    throw new Error(
        `png: this is a color type ${d.ctype} image with no palette of its own, so ` +
        `.load needs one: png.load(bytes, {palette: [[r, g, b], ...]})`);
  }
  checkPalette(opts.palette);
  const palette = opts.palette.map(e => [...e] as unknown as Rgb);
  const rgba = new Uint8Array(UPNG.toRGBA8(d)[0]);
  return {
    width, height, palette,
    pixels: indexRgba(rgba, width, palette, opts.exact !== false),
  };
}

/** Smallest PNG bit depth that can hold every index in the palette. */
function depthFor(colors: number): number {
  return colors <= 2 ? 1 : colors <= 4 ? 2 : colors <= 16 ? 4 : 8;
}

/**
 * Writes an indexed PNG with the palette exactly as given. UPNG.encode cannot since it always
 * quantizes from RGBA, which reorders the palette and combines duplicate entries, so a
 * load of what it wrote would hand back different indices than went in.
 */
function encodeIndexed(image: IndexedImage, palette: readonly Rgb[]): Uint8Array {
  const { width, height, pixels } = image;
  if (palette.length > 256) {
    throw new Error(`png.encode: a palette of ${palette.length} exceeds the 256 an ` +
                    `indexed PNG can hold`);
  }
  for (let p = 0; p < pixels.length; p++) {
    if (pixels[p] >= palette.length) {
      throw new Error(`png.encode: pixel ${p} has index ${pixels[p]}, ` +
                      `outside a palette of ${palette.length}`);
    }
  }

  const depth = depthFor(palette.length);
  const bpl = Math.ceil(depth * width / 8);
  const packed = new Uint8Array(bpl * height);
  const perByte = 8 / depth;
  for (let y = 0; y < height; y++) {
    const row = y * bpl, src = y * width;
    for (let x = 0; x < width; x++) {
      const shift = 8 - depth - (x % perByte) * depth;
      packed[row + Math.floor(x / perByte)] |= pixels[src + x] << shift;
    }
  }

  // plte entries are the ABGR uint32 _main writes out; alpha 255 keeps it opaque.
  const plte = palette.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0);
  const nimg = {
    ctype: 3, depth, plte,
    frames: [{rect: {x: 0, y: 0, width, height}, img: packed,
              blend: 0, dispose: 1, bpp: 1, bpl}],
  };
  UPNG.encode._compressPNG(nimg, 0, true);
  return new Uint8Array(UPNG.encode._main(nimg, width, height, 0));
}

function encodeImage(image: RgbaImage | IndexedImage, opts: EncodeOptions = {}): Uint8Array {
  const { width, height } = image;
  const palette = opts.palette ?? ('palette' in image ? image.palette : undefined);

  if ('pixels' in image) {
    if (!palette) throw new Error('png.encode: an indexed image needs a palette');
    checkPalette(palette);
    return encodeIndexed(image, palette);
  }

  // 0 colors is UPNG's lossless mode, so truecolor stays exact unless asked otherwise.
  const rgba = image.data;
  const buf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
  return new Uint8Array(UPNG.encode([buf], width, height, opts.colors ?? 0));
}

return {
  load,
  loadRgba,
  encode: encodeImage,
  upng: UPNG,
};
