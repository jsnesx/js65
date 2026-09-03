import { decode } from "./decoder";
import { encode } from "./encoder";
import { decodeRgb, decodeRgba } from "./output-format";

export type {
  BmpBinaryInput,
  DecodeColorOptions,
  EncodeBitDepth,
  BmpImageData,
  BmpPaletteColor,
  DecodeOptions,
  DecodedBmp,
  DecodedRgb,
  EncodeOptions,
  EncodedBmp,
} from "./types";
export { BmpDecoder } from "./decoder";
export { BmpEncoder } from "./encoder";
export { encode, decode, decodeRgba, decodeRgb };

const bmp = {
  encode,
  decode,
  decodeRgba,
  decodeRgb,
};

export default bmp;
