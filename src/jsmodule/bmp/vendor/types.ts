export interface BmpPaletteColor {
  red: number;
  green: number;
  blue: number;
  quad: number;
}

export type BmpBinaryInput = ArrayBuffer | ArrayBufferView;
export type EncodeBitDepth = 1 | 4 | 8 | 16 | 24 | 32;

export interface BmpImageData {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface EncodeOptions {
  orientation?: "top-down" | "bottom-up";
  bitPP?: EncodeBitDepth;
  palette?: BmpPaletteColor[];
}

export interface DecodeOptions {
  treat16BitAs15BitAlpha?: boolean;
  toRGBA?: boolean;
}

export type DecodeColorOptions = Omit<DecodeOptions, "toRGBA">;

export interface EncodedBmp {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DecodedBmp {
  fileSize: number;
  reserved: number;
  offset: number;
  headerSize: number;
  width: number;
  height: number;
  planes: number;
  bitPP: number;
  compress: number;
  rawSize: number;
  hr: number;
  vr: number;
  colors: number;
  importantColors: number;
  palette?: BmpPaletteColor[];
  data: Uint8Array;
  /** js65 added: for indexed bmps, each pixel's index stored in a byte */
  indices?: Uint8Array;
  getData(): Uint8Array;
}

export interface DecodedRgb extends BmpImageData {
  channels: 3;
  format: "rgb";
}
