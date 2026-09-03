import { decode } from "./decoder";
import type { BmpBinaryInput, DecodeColorOptions, DecodedBmp, DecodedRgb } from "./types";

function rgbaToRgb(rgba: Uint8Array): Uint8Array {
  if (rgba.length % 4 !== 0) {
    throw new Error("RGBA input length must be a multiple of 4.");
  }

  const rgb = new Uint8Array((rgba.length / 4) * 3);

  for (let src = 0, dst = 0; src < rgba.length; src += 4, dst += 3) {
    const red = rgba[src] ?? 0;
    const green = rgba[src + 1] ?? 0;
    const blue = rgba[src + 2] ?? 0;

    rgb[dst] = red;
    rgb[dst + 1] = green;
    rgb[dst + 2] = blue;
  }

  return rgb;
}

/**
 * Decode BMP data directly to RGBA without changing the default `decode` behavior.
 */
export function decodeRgba(bmpData: BmpBinaryInput, options: DecodeColorOptions = {}): DecodedBmp {
  return decode(bmpData, { ...options, toRGBA: true });
}

/**
 * Decode BMP data to packed RGB bytes (`width * height * 3`).
 */
export function decodeRgb(bmpData: BmpBinaryInput, options: DecodeColorOptions = {}): DecodedRgb {
  const rgbaDecoded = decodeRgba(bmpData, options);

  return {
    data: rgbaToRgb(rgbaDecoded.data),
    width: rgbaDecoded.width,
    height: rgbaDecoded.height,
    channels: 3,
    format: "rgb",
  };
}
