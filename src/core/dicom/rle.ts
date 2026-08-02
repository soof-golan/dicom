/**
 * RLE Lossless decoding (DICOM PS3.5 Annex G).
 *
 * An RLE frame starts with a 64-byte header of sixteen 32-bit little-endian
 * values: the segment count, then the byte offset of each segment. Every
 * segment holds one byte plane of one sample, and is PackBits encoded.
 *
 * A 16-bit image has two segments. The first holds the high byte of every
 * pixel, the second holds the low byte. The decoder writes them back in
 * little-endian order, which is the order that RLE Lossless always uses.
 */

const HEADER_LENGTH = 64;
const MAX_SEGMENTS = 15;

export class RleDecodeError extends Error {
  override readonly name = "RleDecodeError";
}

/** Expand one PackBits segment into `out`, taking one byte every `stride`. */
function expandSegment(
  source: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
  firstByte: number,
  stride: number,
): void {
  let read = start;
  let write = firstByte;

  while (read < end && write < out.length) {
    const control = source[read]!;
    read += 1;

    if (control < 128) {
      // Copy the next control + 1 bytes without change.
      const count = control + 1;
      for (let i = 0; i < count && read < end && write < out.length; i += 1) {
        out[write] = source[read]!;
        read += 1;
        write += stride;
      }
    } else if (control > 128) {
      // Repeat the next byte 257 - control times.
      const count = 257 - control;
      const value = source[read]!;
      read += 1;
      for (let i = 0; i < count && write < out.length; i += 1) {
        out[write] = value;
        write += stride;
      }
    }
    // A control byte of exactly 128 does nothing.
  }
}

/**
 * Decode one RLE frame into raw little-endian pixel bytes.
 *
 * @param frame The fragment bytes, starting at the 64-byte segment header.
 * @param sampleCount `rows * columns * samplesPerPixel`.
 * @param bitsAllocated 8, 16, or 32.
 * @throws {RleDecodeError} if the header is short or the segment count is wrong.
 */
export function decodeRle(
  frame: Uint8Array,
  sampleCount: number,
  bitsAllocated: number,
): Uint8Array {
  if (frame.length < HEADER_LENGTH) {
    throw new RleDecodeError(`RLE frame is shorter than its 64-byte header: ${frame.length} bytes`);
  }

  const header = new DataView(frame.buffer, frame.byteOffset, HEADER_LENGTH);
  const segmentCount = header.getUint32(0, true);
  if (segmentCount < 1 || segmentCount > MAX_SEGMENTS) {
    throw new RleDecodeError(`RLE segment count is out of range: ${segmentCount}`);
  }

  const bytesPerSample = bitsAllocated / 8;
  const samples = segmentCount / bytesPerSample;
  if (!Number.isInteger(samples)) {
    throw new RleDecodeError(
      `RLE has ${segmentCount} segments, which does not divide into ${bytesPerSample}-byte samples`,
    );
  }

  const out = new Uint8Array(sampleCount * bytesPerSample);
  const stride = bytesPerSample;

  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = header.getUint32(4 + segment * 4, true);
    const next =
      segment + 1 < segmentCount ? header.getUint32(4 + (segment + 1) * 4, true) : frame.length;
    const end = Math.min(next === 0 ? frame.length : next, frame.length);
    if (start === 0 || start >= frame.length) continue;

    // Segments run from the most significant byte to the least significant.
    // Little-endian output needs the reverse, so the write position mirrors.
    const sample = Math.floor(segment / bytesPerSample);
    const byteInSample = segment % bytesPerSample;
    const firstByte = sample * bytesPerSample + (bytesPerSample - 1 - byteInSample);

    expandSegment(frame, start, end, out, firstByte, stride);
  }

  return out;
}
