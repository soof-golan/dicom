/**
 * Pixel decoding.
 *
 * The output holds stored values, not physical units. The rescale slope and
 * intercept travel with the frame so the GPU can apply them, which keeps the
 * data at 16 bits per voxel instead of 32.
 */
import { getBytes, getNumber, getNumbers, getString } from "./access.ts";
import { decodeRle } from "./rle.ts";
import type { DicomDataSet } from "./parse.ts";
import { Tag } from "./tags.ts";

export type Photometric =
  | "MONOCHROME1"
  | "MONOCHROME2"
  | "PALETTE COLOR"
  | "RGB"
  | "YBR_FULL"
  | "YBR_FULL_422"
  | "YBR_ICT"
  | "YBR_RCT";

export type PixelArray = Uint8Array | Uint16Array | Int16Array | Int32Array | Uint32Array;

export interface Frame {
  readonly rows: number;
  readonly columns: number;
  readonly samplesPerPixel: number;
  readonly photometric: Photometric;
  /** Stored values. Length is `rows * columns * samplesPerPixel`. */
  readonly pixels: PixelArray;
  readonly signed: boolean;
  readonly bitsAllocated: number;
  readonly bitsStored: number;
  readonly rescaleSlope: number;
  readonly rescaleIntercept: number;
  readonly windowCenter?: number;
  readonly windowWidth?: number;
  /** True for MONOCHROME1, where a high stored value means black. */
  readonly invert: boolean;
}

export class PixelDecodeError extends Error {
  override readonly name = "PixelDecodeError";
}

export function frameCount(dataSet: DicomDataSet): number {
  return getNumber(dataSet, Tag.NumberOfFrames) ?? 1;
}

/**
 * Read one frame of an image.
 *
 * @throws {PixelDecodeError} for a missing frame, an unsupported transfer
 * syntax, or a truncated pixel block.
 */
export function decodeFrame(dataSet: DicomDataSet, frameIndex = 0): Frame {
  const total = frameCount(dataSet);
  if (frameIndex < 0 || frameIndex >= total) {
    throw new PixelDecodeError(`frame ${frameIndex} is outside the image, which has ${total}`);
  }

  const rows = getNumber(dataSet, Tag.Rows);
  const columns = getNumber(dataSet, Tag.Columns);
  if (!rows || !columns) {
    throw new PixelDecodeError("image has no Rows or Columns");
  }

  const samplesPerPixel = getNumber(dataSet, Tag.SamplesPerPixel) ?? 1;
  const bitsAllocated = getNumber(dataSet, Tag.BitsAllocated) ?? 16;
  const bitsStored = getNumber(dataSet, Tag.BitsStored) ?? bitsAllocated;
  const highBit = getNumber(dataSet, Tag.HighBit) ?? bitsStored - 1;
  const signed = (getNumber(dataSet, Tag.PixelRepresentation) ?? 0) === 1;
  const photometric = (getString(dataSet, Tag.PhotometricInterpretation) ??
    "MONOCHROME2") as Photometric;

  const sampleCount = rows * columns * samplesPerPixel;
  const raw = readFrameBytes(dataSet, frameIndex, sampleCount, bitsAllocated);
  const pixels = unpack(raw, dataSet.littleEndian, bitsAllocated, signed, sampleCount);
  applyBitMask(pixels, bitsAllocated, bitsStored, highBit, signed);

  const windows = getNumbers(dataSet, Tag.WindowCenter);
  const widths = getNumbers(dataSet, Tag.WindowWidth);

  return {
    rows,
    columns,
    samplesPerPixel,
    photometric,
    pixels,
    signed,
    bitsAllocated,
    bitsStored,
    rescaleSlope: getNumber(dataSet, Tag.RescaleSlope) ?? 1,
    rescaleIntercept: getNumber(dataSet, Tag.RescaleIntercept) ?? 0,
    windowCenter: windows[0],
    windowWidth: widths[0],
    invert: photometric === "MONOCHROME1",
  };
}

function readFrameBytes(
  dataSet: DicomDataSet,
  frameIndex: number,
  sampleCount: number,
  bitsAllocated: number,
): Uint8Array {
  const element = dataSet.elements.get(Tag.PixelData);
  if (!element) {
    throw new PixelDecodeError("image has no PixelData");
  }

  if (element.fragments) {
    return decodeEncapsulated(dataSet, element.fragments, frameIndex, sampleCount, bitsAllocated);
  }

  const all = getBytes(dataSet, Tag.PixelData);
  if (!all) {
    throw new PixelDecodeError("image has no PixelData");
  }
  const frameBytes = Math.ceil((sampleCount * bitsAllocated) / 8);
  const start = frameIndex * frameBytes;
  if (start + frameBytes > all.length) {
    throw new PixelDecodeError(
      `PixelData is truncated: need ${start + frameBytes} bytes, found ${all.length}`,
    );
  }
  return all.subarray(start, start + frameBytes);
}

function decodeEncapsulated(
  dataSet: DicomDataSet,
  fragments: readonly Uint8Array[],
  frameIndex: number,
  sampleCount: number,
  bitsAllocated: number,
): Uint8Array {
  // The first fragment is the basic offset table. One fragment per frame after
  // it is the common case, and the only one this decoder handles.
  const frames = fragments.slice(1);
  const fragment = frames[frameIndex];
  if (!fragment) {
    throw new PixelDecodeError(`no pixel fragment for frame ${frameIndex}`);
  }

  if (dataSet.transferSyntaxUid === "1.2.840.10008.1.2.5") {
    return decodeRle(fragment, sampleCount, bitsAllocated);
  }
  throw new PixelDecodeError(
    `transfer syntax ${dataSet.transferSyntaxUid} needs an image codec that is not loaded`,
  );
}

function unpack(
  raw: Uint8Array,
  littleEndian: boolean,
  bitsAllocated: number,
  signed: boolean,
  sampleCount: number,
): PixelArray {
  if (bitsAllocated === 8) {
    const out = signed ? new Int16Array(sampleCount) : new Uint8Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      const byte = raw[i] ?? 0;
      out[i] = signed && byte > 127 ? byte - 256 : byte;
    }
    return out;
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  if (bitsAllocated === 16) {
    const out = signed ? new Int16Array(sampleCount) : new Uint16Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      out[i] = signed ? view.getInt16(i * 2, littleEndian) : view.getUint16(i * 2, littleEndian);
    }
    return out;
  }

  if (bitsAllocated === 32) {
    const out = signed ? new Int32Array(sampleCount) : new Uint32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      out[i] = signed ? view.getInt32(i * 4, littleEndian) : view.getUint32(i * 4, littleEndian);
    }
    return out;
  }

  throw new PixelDecodeError(`unsupported BitsAllocated: ${bitsAllocated}`);
}

/**
 * Discard the bits outside the stored range.
 *
 * A scanner can leave anything in the unused high bits. Siemens MR stores 12
 * bits inside 16, so bits 12 to 15 are noise and must go.
 */
function applyBitMask(
  pixels: PixelArray,
  bitsAllocated: number,
  bitsStored: number,
  highBit: number,
  signed: boolean,
): void {
  if (bitsStored >= bitsAllocated) return;

  const shift = highBit + 1 - bitsStored;
  const mask = (1 << bitsStored) - 1;
  const signBit = 1 << (bitsStored - 1);

  for (let i = 0; i < pixels.length; i += 1) {
    const value = ((pixels[i] ?? 0) >> shift) & mask;
    pixels[i] = signed && (value & signBit) !== 0 ? value - (1 << bitsStored) : value;
  }
}

/** The smallest and largest stored value in a frame. */
export function storedValueRange(frame: Frame): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < frame.pixels.length; i += 1) {
    const value = frame.pixels[i]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** Turn stored values into physical units with the rescale transform. */
export function rescale(frame: Frame): Float32Array {
  const { rescaleSlope: slope, rescaleIntercept: intercept, pixels } = frame;
  const out = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) {
    out[i] = pixels[i]! * slope + intercept;
  }
  return out;
}
