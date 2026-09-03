import { assertInteger } from "./binary";
import type {
  BmpImageData,
  BmpPaletteColor,
  EncodeBitDepth,
  EncodeOptions,
  EncodedBmp,
} from "./types";

const FILE_HEADER_SIZE = 14;
const INFO_HEADER_SIZE = 40;
const BYTES_PER_PIXEL_ABGR = 4;
const SUPPORTED_BIT_DEPTHS = [1, 4, 8, 16, 24, 32] as const;

type SupportedBitDepth = (typeof SUPPORTED_BIT_DEPTHS)[number];
type ResolvedEncodeOptions = Required<Pick<EncodeOptions, "orientation" | "bitPP">> & {
  palette: BmpPaletteColor[];
};

function isSupportedBitDepth(value: number): value is SupportedBitDepth {
  return (SUPPORTED_BIT_DEPTHS as readonly number[]).includes(value);
}

function normalizeEncodeOptions(qualityOrOptions?: number | EncodeOptions): ResolvedEncodeOptions {
  if (typeof qualityOrOptions === "number" || typeof qualityOrOptions === "undefined") {
    return {
      orientation: "top-down",
      bitPP: 24,
      palette: [],
    };
  }

  return {
    orientation: qualityOrOptions.orientation ?? "top-down",
    bitPP: qualityOrOptions.bitPP ?? 24,
    palette: qualityOrOptions.palette ?? [],
  };
}

class BmpEncoder {
  private readonly pixelData: Uint8Array;
  private readonly width: number;
  private readonly height: number;
  private readonly options: ResolvedEncodeOptions;
  private readonly palette: BmpPaletteColor[];
  private readonly exactPaletteIndex = new Map<number, number>();

  constructor(imgData: BmpImageData, options: ResolvedEncodeOptions) {
    this.pixelData = imgData.data;
    this.width = imgData.width;
    this.height = imgData.height;
    this.options = options;
    this.palette = this.normalizePalette(options);

    assertInteger("width", this.width);
    assertInteger("height", this.height);

    if (!isSupportedBitDepth(this.options.bitPP)) {
      throw new Error(
        `Unsupported encode bit depth: ${this.options.bitPP}. Supported: 1, 4, 8, 16, 24, 32.`,
      );
    }

    const minLength = this.width * this.height * BYTES_PER_PIXEL_ABGR;
    if (this.pixelData.length < minLength) {
      throw new Error(
        `Image data is too short: expected at least ${minLength} bytes for ${this.width}x${this.height} ABGR data.`,
      );
    }

    for (let i = 0; i < this.palette.length; i += 1) {
      const color = this.palette[i]!;
      const key = this.paletteKey(color.quad, color.blue, color.green, color.red);
      if (!this.exactPaletteIndex.has(key)) {
        this.exactPaletteIndex.set(key, i);
      }
    }
  }

  private normalizePalette(options: ResolvedEncodeOptions): BmpPaletteColor[] {
    if (options.bitPP === 1) {
      const palette = options.palette.length
        ? options.palette
        : [
            { red: 255, green: 255, blue: 255, quad: 0 },
            { red: 0, green: 0, blue: 0, quad: 0 },
          ];
      this.validatePalette(options.bitPP, palette);
      return palette;
    }

    if (options.bitPP === 4 || options.bitPP === 8) {
      if (options.palette.length === 0) {
        throw new Error(`Encoding ${options.bitPP}-bit BMP requires a non-empty palette.`);
      }
      this.validatePalette(options.bitPP, options.palette);
      return options.palette;
    }

    return [];
  }

  private validatePalette(bitPP: 1 | 4 | 8, palette: BmpPaletteColor[]): void {
    const maxSize = 1 << bitPP;
    if (palette.length === 0 || palette.length > maxSize) {
      throw new Error(
        `Palette size ${palette.length} is invalid for ${bitPP}-bit BMP. Expected 1..${maxSize}.`,
      );
    }

    for (const color of palette) {
      this.validateChannel("palette.red", color.red);
      this.validateChannel("palette.green", color.green);
      this.validateChannel("palette.blue", color.blue);
      this.validateChannel("palette.quad", color.quad);
    }
  }

  private validateChannel(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`${name} must be an integer between 0 and 255.`);
    }
  }

  private rowStride(): number {
    return Math.floor((this.options.bitPP * this.width + 31) / 32) * 4;
  }

  private sourceY(fileRow: number): number {
    return this.options.orientation === "top-down" ? fileRow : this.height - 1 - fileRow;
  }

  private sourceOffset(x: number, y: number): number {
    return (y * this.width + x) * BYTES_PER_PIXEL_ABGR;
  }

  private paletteKey(alpha: number, blue: number, green: number, red: number): number {
    return (
      (((alpha & 0xff) << 24) | ((blue & 0xff) << 16) | ((green & 0xff) << 8) | (red & 0xff)) >>> 0
    );
  }

  private findPaletteIndex(a: number, b: number, g: number, r: number): number {
    const exact = this.exactPaletteIndex.get(this.paletteKey(a, b, g, r));
    if (exact !== undefined) {
      return exact;
    }

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.palette.length; i += 1) {
      const color = this.palette[i]!;
      const dr = color.red - r;
      const dg = color.green - g;
      const db = color.blue - b;
      const da = color.quad - a;
      const distance = dr * dr + dg * dg + db * db + da * da;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  private writePalette(output: Uint8Array, paletteOffset: number): void {
    for (let i = 0; i < this.palette.length; i += 1) {
      const color = this.palette[i]!;
      const base = paletteOffset + i * 4;
      output[base] = color.blue;
      output[base + 1] = color.green;
      output[base + 2] = color.red;
      output[base + 3] = color.quad;
    }
  }

  private encode1Bit(output: Uint8Array, pixelOffset: number, stride: number): void {
    for (let fileRow = 0; fileRow < this.height; fileRow += 1) {
      const srcY = this.sourceY(fileRow);
      const rowStart = pixelOffset + fileRow * stride;

      for (let x = 0; x < this.width; x += 8) {
        let packed = 0;
        for (let bit = 0; bit < 8; bit += 1) {
          const px = x + bit;
          if (px >= this.width) {
            break;
          }
          const source = this.sourceOffset(px, srcY);
          const a = this.pixelData[source] ?? 0xff;
          const b = this.pixelData[source + 1] ?? 0;
          const g = this.pixelData[source + 2] ?? 0;
          const r = this.pixelData[source + 3] ?? 0;
          const idx = this.findPaletteIndex(a, b, g, r) & 0x01;
          packed |= idx << (7 - bit);
        }
        output[rowStart + Math.floor(x / 8)] = packed;
      }
    }
  }

  private encode4Bit(output: Uint8Array, pixelOffset: number, stride: number): void {
    for (let fileRow = 0; fileRow < this.height; fileRow += 1) {
      const srcY = this.sourceY(fileRow);
      const rowStart = pixelOffset + fileRow * stride;

      for (let x = 0; x < this.width; x += 2) {
        const sourceA = this.sourceOffset(x, srcY);
        const idxA = this.findPaletteIndex(
          this.pixelData[sourceA] ?? 0xff,
          this.pixelData[sourceA + 1] ?? 0,
          this.pixelData[sourceA + 2] ?? 0,
          this.pixelData[sourceA + 3] ?? 0,
        );

        let idxB = 0;
        if (x + 1 < this.width) {
          const sourceB = this.sourceOffset(x + 1, srcY);
          idxB = this.findPaletteIndex(
            this.pixelData[sourceB] ?? 0xff,
            this.pixelData[sourceB + 1] ?? 0,
            this.pixelData[sourceB + 2] ?? 0,
            this.pixelData[sourceB + 3] ?? 0,
          );
        }

        output[rowStart + Math.floor(x / 2)] = ((idxA & 0x0f) << 4) | (idxB & 0x0f);
      }
    }
  }

  private encode8Bit(output: Uint8Array, pixelOffset: number, stride: number): void {
    for (let fileRow = 0; fileRow < this.height; fileRow += 1) {
      const srcY = this.sourceY(fileRow);
      const rowStart = pixelOffset + fileRow * stride;

      for (let x = 0; x < this.width; x += 1) {
        const source = this.sourceOffset(x, srcY);
        output[rowStart + x] = this.findPaletteIndex(
          this.pixelData[source] ?? 0xff,
          this.pixelData[source + 1] ?? 0,
          this.pixelData[source + 2] ?? 0,
          this.pixelData[source + 3] ?? 0,
        );
      }
    }
  }

  private encode16Bit(
    output: Uint8Array,
    view: DataView,
    pixelOffset: number,
    stride: number,
  ): void {
    for (let fileRow = 0; fileRow < this.height; fileRow += 1) {
      const srcY = this.sourceY(fileRow);
      const rowStart = pixelOffset + fileRow * stride;

      for (let x = 0; x < this.width; x += 1) {
        const source = this.sourceOffset(x, srcY);
        const b = this.pixelData[source + 1] ?? 0;
        const g = this.pixelData[source + 2] ?? 0;
        const r = this.pixelData[source + 3] ?? 0;

        const value = (((r >> 3) & 0x1f) << 10) | (((g >> 3) & 0x1f) << 5) | ((b >> 3) & 0x1f);
        view.setUint16(rowStart + x * 2, value, true);
      }
    }
  }

  private encode24Bit(output: Uint8Array, pixelOffset: number, stride: number): void {
    for (let fileRow = 0; fileRow < this.height; fileRow += 1) {
      const srcY = this.sourceY(fileRow);
      const rowStart = pixelOffset + fileRow * stride;

      for (let x = 0; x < this.width; x += 1) {
        const source = this.sourceOffset(x, srcY);
        const target = rowStart + x * 3;

        output[target] = this.pixelData[source + 1] ?? 0;
        output[target + 1] = this.pixelData[source + 2] ?? 0;
        output[target + 2] = this.pixelData[source + 3] ?? 0;
      }
    }
  }

  private encode32Bit(output: Uint8Array, pixelOffset: number, stride: number): void {
    for (let fileRow = 0; fileRow < this.height; fileRow += 1) {
      const srcY = this.sourceY(fileRow);
      const rowStart = pixelOffset + fileRow * stride;

      for (let x = 0; x < this.width; x += 1) {
        const source = this.sourceOffset(x, srcY);
        const target = rowStart + x * 4;

        output[target] = this.pixelData[source + 1] ?? 0;
        output[target + 1] = this.pixelData[source + 2] ?? 0;
        output[target + 2] = this.pixelData[source + 3] ?? 0;
        output[target + 3] = this.pixelData[source] ?? 0xff;
      }
    }
  }

  encode(): Uint8Array {
    const stride = this.rowStride();
    const imageSize = stride * this.height;
    const paletteSize = this.palette.length * 4;
    const offset = FILE_HEADER_SIZE + INFO_HEADER_SIZE + paletteSize;
    const totalSize = offset + imageSize;
    const output = new Uint8Array(totalSize);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

    // BITMAPFILEHEADER
    output[0] = 0x42; // B
    output[1] = 0x4d; // M
    view.setUint32(2, totalSize, true);
    view.setUint32(6, 0, true);
    view.setUint32(10, offset, true);

    // BITMAPINFOHEADER
    view.setUint32(14, INFO_HEADER_SIZE, true);
    view.setInt32(18, this.width, true);
    const signedHeight = this.options.orientation === "top-down" ? -this.height : this.height;
    view.setInt32(22, signedHeight, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, this.options.bitPP, true);
    view.setUint32(30, 0, true);
    view.setUint32(34, imageSize, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, 0, true);
    view.setUint32(46, this.palette.length, true);
    view.setUint32(50, 0, true);

    if (this.palette.length > 0) {
      this.writePalette(output, FILE_HEADER_SIZE + INFO_HEADER_SIZE);
    }

    switch (this.options.bitPP as EncodeBitDepth) {
      case 1:
        this.encode1Bit(output, offset, stride);
        break;
      case 4:
        this.encode4Bit(output, offset, stride);
        break;
      case 8:
        this.encode8Bit(output, offset, stride);
        break;
      case 16:
        this.encode16Bit(output, view, offset, stride);
        break;
      case 24:
        this.encode24Bit(output, offset, stride);
        break;
      case 32:
        this.encode32Bit(output, offset, stride);
        break;
    }

    return output;
  }
}

export function encode(
  imgData: BmpImageData,
  qualityOrOptions?: number | EncodeOptions,
): EncodedBmp {
  const options = normalizeEncodeOptions(qualityOrOptions);
  const encoder = new BmpEncoder(imgData, options);
  const data = encoder.encode();

  return {
    data,
    width: imgData.width,
    height: imgData.height,
  };
}

export { BmpEncoder };
