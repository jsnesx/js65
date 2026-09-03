import { toUint8Array } from "./binary";
import type { BmpBinaryInput, BmpPaletteColor, DecodeOptions, DecodedBmp } from "./types";

const FILE_HEADER_SIZE = 14;
const INFO_HEADER_MIN = 40;
const CORE_HEADER_SIZE = 12;

function rowStride(width: number, bitPP: number): number {
  return Math.floor((bitPP * width + 31) / 32) * 4;
}

class BmpDecoder implements DecodedBmp {
  private pos = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly options: Required<DecodeOptions>;
  private bottomUp = true;
  private dibStart = FILE_HEADER_SIZE;
  private paletteEntrySize = 4;
  private externalMaskOffset = 0;

  private maskRed = 0;
  private maskGreen = 0;
  private maskBlue = 0;
  private maskAlpha = 0;

  fileSize!: number;
  reserved!: number;
  offset!: number;
  headerSize!: number;
  width!: number;
  height!: number;
  planes!: number;
  bitPP!: number;
  compress!: number;
  rawSize!: number;
  hr!: number;
  vr!: number;
  colors!: number;
  importantColors!: number;
  palette?: BmpPaletteColor[];
  data!: Uint8Array;
  // js65: one palette index per pixel, present only for the indexed depths (1/4/8).
  indices?: Uint8Array;

  constructor(input: BmpBinaryInput, options: DecodeOptions = {}) {
    this.bytes = toUint8Array(input);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.options = {
      treat16BitAs15BitAlpha: options.treat16BitAs15BitAlpha ?? false,
      toRGBA: options.toRGBA ?? false,
    };

    this.parseFileHeader();
    this.parseDibHeader();
    this.parsePalette();
    this.pos = this.offset;
    this.parseRGBA();
    this.transformToRgbaIfNeeded();
  }

  private ensureReadable(offset: number, size: number, context: string): void {
    if (offset < 0 || size < 0 || offset + size > this.bytes.length) {
      throw new Error(`BMP decode out-of-range while reading ${context}`);
    }
  }

  private readUInt8(offset = this.pos): number {
    this.ensureReadable(offset, 1, "uint8");
    if (offset === this.pos) this.pos += 1;
    return this.view.getUint8(offset);
  }

  private readUInt16LE(offset = this.pos): number {
    this.ensureReadable(offset, 2, "uint16");
    if (offset === this.pos) this.pos += 2;
    return this.view.getUint16(offset, true);
  }

  private readInt16LE(offset = this.pos): number {
    this.ensureReadable(offset, 2, "int16");
    if (offset === this.pos) this.pos += 2;
    return this.view.getInt16(offset, true);
  }

  private readUInt32LE(offset = this.pos): number {
    this.ensureReadable(offset, 4, "uint32");
    if (offset === this.pos) this.pos += 4;
    return this.view.getUint32(offset, true);
  }

  private readInt32LE(offset = this.pos): number {
    this.ensureReadable(offset, 4, "int32");
    if (offset === this.pos) this.pos += 4;
    return this.view.getInt32(offset, true);
  }

  private parseFileHeader(): void {
    this.ensureReadable(0, FILE_HEADER_SIZE, "file header");
    if (this.bytes[0] !== 0x42 || this.bytes[1] !== 0x4d) {
      throw new Error("Invalid BMP file signature");
    }

    this.pos = 2;
    this.fileSize = this.readUInt32LE();
    this.reserved = this.readUInt32LE();
    this.offset = this.readUInt32LE();

    if (this.offset < FILE_HEADER_SIZE || this.offset > this.bytes.length) {
      throw new Error(`Invalid pixel data offset: ${this.offset}`);
    }
  }

  private parseDibHeader(): void {
    this.pos = this.dibStart;
    this.headerSize = this.readUInt32LE();
    if (this.headerSize < CORE_HEADER_SIZE) {
      throw new Error(`Unsupported DIB header size: ${this.headerSize}`);
    }
    this.ensureReadable(this.dibStart, this.headerSize, "DIB header");

    if (this.headerSize === CORE_HEADER_SIZE) {
      this.parseCoreHeader();
      return;
    }

    if (this.headerSize < INFO_HEADER_MIN) {
      throw new Error(`Unsupported DIB header size: ${this.headerSize}`);
    }

    this.parseInfoHeader();
  }

  private parseCoreHeader(): void {
    const width = this.readUInt16LE(this.dibStart + 4);
    const height = this.readUInt16LE(this.dibStart + 6);

    this.width = width;
    this.height = height;
    this.planes = this.readUInt16LE(this.dibStart + 8);
    this.bitPP = this.readUInt16LE(this.dibStart + 10);
    this.compress = 0;
    this.rawSize = 0;
    this.hr = 0;
    this.vr = 0;
    this.colors = 0;
    this.importantColors = 0;
    this.bottomUp = true;
    this.paletteEntrySize = 3;
    this.externalMaskOffset = this.dibStart + this.headerSize;

    this.validateDimensions();
  }

  private parseInfoHeader(): void {
    const rawWidth = this.readInt32LE(this.dibStart + 4);
    const rawHeight = this.readInt32LE(this.dibStart + 8);

    this.width = rawWidth;
    this.height = rawHeight;
    this.planes = this.readUInt16LE(this.dibStart + 12);
    this.bitPP = this.readUInt16LE(this.dibStart + 14);
    this.compress = this.readUInt32LE(this.dibStart + 16);
    this.rawSize = this.readUInt32LE(this.dibStart + 20);
    this.hr = this.readUInt32LE(this.dibStart + 24);
    this.vr = this.readUInt32LE(this.dibStart + 28);
    this.colors = this.readUInt32LE(this.dibStart + 32);
    this.importantColors = this.readUInt32LE(this.dibStart + 36);
    this.paletteEntrySize = 4;
    this.externalMaskOffset = this.dibStart + this.headerSize;

    if (this.height < 0) {
      this.height *= -1;
      this.bottomUp = false;
    }

    if (this.width < 0) {
      this.width *= -1;
    }

    if (this.bitPP === 16 && this.options.treat16BitAs15BitAlpha) {
      this.bitPP = 15;
    }

    this.validateDimensions();
    this.parseBitMasks();
  }

  private validateDimensions(): void {
    if (
      !Number.isInteger(this.width) ||
      !Number.isInteger(this.height) ||
      this.width <= 0 ||
      this.height <= 0
    ) {
      throw new Error(`Invalid BMP dimensions: ${this.width}x${this.height}`);
    }
  }

  private parseBitMasks(): void {
    if (
      !(this.bitPP === 16 || this.bitPP === 32) ||
      !(this.compress === 3 || this.compress === 6)
    ) {
      return;
    }

    const inHeaderMaskStart = this.dibStart + 40;
    const hasMasksInHeader = this.headerSize >= 52;
    const maskStart = hasMasksInHeader ? inHeaderMaskStart : this.externalMaskOffset;
    const maskCount = this.compress === 6 || this.headerSize >= 56 ? 4 : 3;
    this.ensureReadable(maskStart, maskCount * 4, "bit masks");

    this.maskRed = this.readUInt32LE(maskStart);
    this.maskGreen = this.readUInt32LE(maskStart + 4);
    this.maskBlue = this.readUInt32LE(maskStart + 8);
    this.maskAlpha = maskCount >= 4 ? this.readUInt32LE(maskStart + 12) : 0;

    if (!hasMasksInHeader) {
      this.externalMaskOffset += maskCount * 4;
    }
  }

  private parsePalette(): void {
    if (this.bitPP >= 16) {
      return;
    }

    const colorCount = this.colors === 0 ? 1 << this.bitPP : this.colors;
    if (colorCount <= 0) {
      return;
    }

    const paletteStart = this.externalMaskOffset;
    const paletteSize = colorCount * this.paletteEntrySize;
    if (paletteStart + paletteSize > this.offset) {
      throw new Error("Palette data overlaps or exceeds pixel data offset");
    }

    this.palette = new Array(colorCount);
    for (let i = 0; i < colorCount; i += 1) {
      const base = paletteStart + i * this.paletteEntrySize;
      const blue = this.readUInt8(base);
      const green = this.readUInt8(base + 1);
      const red = this.readUInt8(base + 2);
      const quad = this.paletteEntrySize === 4 ? this.readUInt8(base + 3) : 0;
      this.palette[i] = { red, green, blue, quad };
    }
  }

  private parseRGBA(): void {
    const pixelCount = this.width * this.height;
    const len = pixelCount * 4;
    this.data = new Uint8Array(len);
    // js65: allocated only where indices exist, so `indices` doubles as the "was this
    // an indexed BMP" flag.
    if (this.bitPP === 1 || this.bitPP === 4 || this.bitPP === 8) {
      this.indices = new Uint8Array(pixelCount);
    }

    switch (this.bitPP) {
      case 1:
        this.bit1();
        return;
      case 4:
        this.bit4();
        return;
      case 8:
        this.bit8();
        return;
      case 15:
        this.bit15();
        return;
      case 16:
        this.bit16();
        return;
      case 24:
        this.bit24();
        return;
      case 32:
        this.bit32();
        return;
      default:
        throw new Error(`Unsupported BMP bit depth: ${this.bitPP}`);
    }
  }

  private transformToRgbaIfNeeded(): void {
    if (!this.options.toRGBA) {
      return;
    }

    for (let i = 0; i < this.data.length; i += 4) {
      const alpha = this.data[i] ?? 0;
      const blue = this.data[i + 1] ?? 0;
      const green = this.data[i + 2] ?? 0;
      const red = this.data[i + 3] ?? 0;

      this.data[i] = red;
      this.data[i + 1] = green;
      this.data[i + 2] = blue;
      this.data[i + 3] = alpha;
    }
  }

  private getPaletteColor(index: number): BmpPaletteColor {
    const color = this.palette?.[index];
    if (color) {
      return color;
    }

    return { red: 0xff, green: 0xff, blue: 0xff, quad: 0x00 };
  }

  private setPixel(
    destY: number,
    x: number,
    alpha: number,
    blue: number,
    green: number,
    red: number,
  ): void {
    const base = (destY * this.width + x) * 4;
    this.data[base] = alpha;
    this.data[base + 1] = blue;
    this.data[base + 2] = green;
    this.data[base + 3] = red;
  }

  // js65: expands a palette index and keeps the index itself
  private setIndexedPixel(destY: number, x: number, index: number): void {
    const rgb = this.getPaletteColor(index);
    this.setPixel(destY, x, 0xff, rgb.blue, rgb.green, rgb.red);
    if (this.indices) this.indices[destY * this.width + x] = index;
  }

  private bit1(): void {
    const stride = rowStride(this.width, 1);
    const bytesPerRow = Math.ceil(this.width / 8);

    for (let srcRow = 0; srcRow < this.height; srcRow += 1) {
      const rowStart = this.offset + srcRow * stride;
      this.ensureReadable(rowStart, bytesPerRow, "1-bit row");
      const destY = this.bottomUp ? this.height - 1 - srcRow : srcRow;

      for (let x = 0; x < this.width; x += 1) {
        const packed = this.readUInt8(rowStart + Math.floor(x / 8));
        const bit = (packed >> (7 - (x % 8))) & 0x01;
        this.setIndexedPixel(destY, x, bit);
      }
    }
  }

  private bit4(): void {
    if (this.compress === 2) {
      this.bit4Rle();
      return;
    }

    const stride = rowStride(this.width, 4);
    const bytesPerRow = Math.ceil(this.width / 2);

    for (let srcRow = 0; srcRow < this.height; srcRow += 1) {
      const rowStart = this.offset + srcRow * stride;
      this.ensureReadable(rowStart, bytesPerRow, "4-bit row");
      const destY = this.bottomUp ? this.height - 1 - srcRow : srcRow;

      for (let x = 0; x < this.width; x += 1) {
        const packed = this.readUInt8(rowStart + Math.floor(x / 2));
        const idx = x % 2 === 0 ? (packed & 0xf0) >> 4 : packed & 0x0f;
        this.setIndexedPixel(destY, x, idx);
      }
    }
  }

  private bit8(): void {
    if (this.compress === 1) {
      this.bit8Rle();
      return;
    }

    const stride = rowStride(this.width, 8);
    const bytesPerRow = this.width;

    for (let srcRow = 0; srcRow < this.height; srcRow += 1) {
      const rowStart = this.offset + srcRow * stride;
      this.ensureReadable(rowStart, bytesPerRow, "8-bit row");
      const destY = this.bottomUp ? this.height - 1 - srcRow : srcRow;

      for (let x = 0; x < this.width; x += 1) {
        const idx = this.readUInt8(rowStart + x);
        this.setIndexedPixel(destY, x, idx);
      }
    }
  }

  private bit15(): void {
    const stride = rowStride(this.width, 16);
    const max = 0b11111;

    for (let srcRow = 0; srcRow < this.height; srcRow += 1) {
      const rowStart = this.offset + srcRow * stride;
      this.ensureReadable(rowStart, this.width * 2, "15-bit row");
      const destY = this.bottomUp ? this.height - 1 - srcRow : srcRow;

      for (let x = 0; x < this.width; x += 1) {
        const value = this.readUInt16LE(rowStart + x * 2);
        const blue = (((value >> 0) & max) / max) * 255;
        const green = (((value >> 5) & max) / max) * 255;
        const red = (((value >> 10) & max) / max) * 255;
        const alpha = (value & 0x8000) !== 0 ? 0xff : 0x00;

        this.setPixel(destY, x, alpha, blue | 0, green | 0, red | 0);
      }
    }
  }

  private scaleMasked(value: number, mask: number): number {
    if (mask === 0) return 0;
    let shift = 0;
    let bits = 0;
    let m = mask;
    while ((m & 1) === 0) {
      shift += 1;
      m >>>= 1;
    }
    while ((m & 1) === 1) {
      bits += 1;
      m >>>= 1;
    }

    const component = (value & mask) >>> shift;
    if (bits >= 8) {
      return component >>> (bits - 8);
    }

    return (component << (8 - bits)) & 0xff;
  }

  private bit16(): void {
    if (this.maskRed === 0 && this.maskGreen === 0 && this.maskBlue === 0) {
      this.maskRed = 0x7c00;
      this.maskGreen = 0x03e0;
      this.maskBlue = 0x001f;
    }

    const stride = rowStride(this.width, 16);

    for (let srcRow = 0; srcRow < this.height; srcRow += 1) {
      const rowStart = this.offset + srcRow * stride;
      this.ensureReadable(rowStart, this.width * 2, "16-bit row");
      const destY = this.bottomUp ? this.height - 1 - srcRow : srcRow;

      for (let x = 0; x < this.width; x += 1) {
        const value = this.readUInt16LE(rowStart + x * 2);
        const blue = this.scaleMasked(value, this.maskBlue);
        const green = this.scaleMasked(value, this.maskGreen);
        const red = this.scaleMasked(value, this.maskRed);
        const alpha = this.maskAlpha !== 0 ? this.scaleMasked(value, this.maskAlpha) : 0xff;
        this.setPixel(destY, x, alpha, blue, green, red);
      }
    }
  }

  private bit24(): void {
    const stride = rowStride(this.width, 24);

    for (let srcRow = 0; srcRow < this.height; srcRow += 1) {
      const rowStart = this.offset + srcRow * stride;
      this.ensureReadable(rowStart, this.width * 3, "24-bit row");
      const destY = this.bottomUp ? this.height - 1 - srcRow : srcRow;

      for (let x = 0; x < this.width; x += 1) {
        const base = rowStart + x * 3;
        const blue = this.readUInt8(base);
        const green = this.readUInt8(base + 1);
        const red = this.readUInt8(base + 2);
        this.setPixel(destY, x, 0xff, blue, green, red);
      }
    }
  }

  private bit32(): void {
    const stride = rowStride(this.width, 32);

    for (let srcRow = 0; srcRow < this.height; srcRow += 1) {
      const rowStart = this.offset + srcRow * stride;
      this.ensureReadable(rowStart, this.width * 4, "32-bit row");
      const destY = this.bottomUp ? this.height - 1 - srcRow : srcRow;

      for (let x = 0; x < this.width; x += 1) {
        const base = rowStart + x * 4;
        if (this.compress === 3 || this.compress === 6) {
          const pixel = this.readUInt32LE(base);
          const red = this.scaleMasked(pixel, this.maskRed || 0x00ff0000);
          const green = this.scaleMasked(pixel, this.maskGreen || 0x0000ff00);
          const blue = this.scaleMasked(pixel, this.maskBlue || 0x000000ff);
          const alpha = this.maskAlpha === 0 ? 0xff : this.scaleMasked(pixel, this.maskAlpha);
          this.setPixel(destY, x, alpha, blue, green, red);
        } else {
          const blue = this.readUInt8(base);
          const green = this.readUInt8(base + 1);
          const red = this.readUInt8(base + 2);
          const alpha = this.readUInt8(base + 3);
          this.setPixel(destY, x, alpha, blue, green, red);
        }
      }
    }
  }

  private bit8Rle(): void {
    this.data.fill(0xff);
    // js65: RLE skips pixels (delta/EOL), and upstream leaves those opaque white. Mark
    // them with a one-past-the-end index so the wrapper can tell them from a real entry.
    this.indices?.fill(this.palette?.length ?? 0);
    this.pos = this.offset;
    let x = 0;
    let y = this.bottomUp ? this.height - 1 : 0;

    while (this.pos < this.bytes.length) {
      const count = this.readUInt8();
      const value = this.readUInt8();

      if (count === 0) {
        if (value === 0) {
          x = 0;
          y += this.bottomUp ? -1 : 1;
          continue;
        }
        if (value === 1) {
          break;
        }
        if (value === 2) {
          x += this.readUInt8();
          y += this.bottomUp ? -this.readUInt8() : this.readUInt8();
          continue;
        }

        for (let i = 0; i < value; i += 1) {
          const idx = this.readUInt8();
          if (x < this.width && y >= 0 && y < this.height) {
            this.setIndexedPixel(y, x, idx);
          }
          x += 1;
        }
        if ((value & 1) === 1) {
          this.pos += 1;
        }
        continue;
      }

      for (let i = 0; i < count; i += 1) {
        if (x < this.width && y >= 0 && y < this.height) {
          this.setIndexedPixel(y, x, value);
        }
        x += 1;
      }
    }
  }

  private bit4Rle(): void {
    this.data.fill(0xff);
    // js65: RLE skips pixels (delta/EOL), and upstream leaves those opaque white. Mark
    // them with a one-past-the-end index so the wrapper can tell them from a real entry.
    this.indices?.fill(this.palette?.length ?? 0);
    this.pos = this.offset;
    let x = 0;
    let y = this.bottomUp ? this.height - 1 : 0;

    while (this.pos < this.bytes.length) {
      const count = this.readUInt8();
      const value = this.readUInt8();

      if (count === 0) {
        if (value === 0) {
          x = 0;
          y += this.bottomUp ? -1 : 1;
          continue;
        }
        if (value === 1) {
          break;
        }
        if (value === 2) {
          x += this.readUInt8();
          y += this.bottomUp ? -this.readUInt8() : this.readUInt8();
          continue;
        }

        let current = this.readUInt8();
        for (let i = 0; i < value; i += 1) {
          const nibble = i % 2 === 0 ? (current & 0xf0) >> 4 : current & 0x0f;
          if (x < this.width && y >= 0 && y < this.height) {
            this.setIndexedPixel(y, x, nibble);
          }
          x += 1;
          if (i % 2 === 1 && i + 1 < value) {
            current = this.readUInt8();
          }
        }
        if ((((value + 1) >> 1) & 1) === 1) {
          this.pos += 1;
        }
        continue;
      }

      for (let i = 0; i < count; i += 1) {
        const nibble = i % 2 === 0 ? (value & 0xf0) >> 4 : value & 0x0f;
        if (x < this.width && y >= 0 && y < this.height) {
          this.setIndexedPixel(y, x, nibble);
        }
        x += 1;
      }
    }
  }

  getData(): Uint8Array {
    return this.data;
  }
}

export function decode(bmpData: BmpBinaryInput, options?: DecodeOptions): DecodedBmp {
  return new BmpDecoder(bmpData, options);
}

export { BmpDecoder };
