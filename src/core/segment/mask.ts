/**
 * Operations on binary masks.
 *
 * Every function here takes a mask and returns a new one. Nothing is edited in
 * place, because a segment that a user keeps must not change when a later
 * click changes the draft.
 */
import type { Mask, RleMask } from "./types.ts";

export interface MaskBounds {
  readonly x0: number;
  readonly y0: number;
  /** One past the last set pixel, so `x1 - x0` is the width. */
  readonly x1: number;
  readonly y1: number;
}

export function emptyMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

function requireSameSize(a: Mask, b: Mask): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`masks differ in size: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
}

/**
 * Pack a mask into run lengths.
 *
 * The first run counts zeros, so a mask that starts with a set pixel begins
 * with a run of length 0.
 */
export function encodeRle(mask: Mask): RleMask {
  const runs: number[] = [];
  let expected = 0;
  let run = 0;
  for (const value of mask.data) {
    const bit = value === 0 ? 0 : 1;
    if (bit === expected) {
      run += 1;
      continue;
    }
    runs.push(run);
    expected = bit;
    run = 1;
  }
  if (mask.data.length > 0) runs.push(run);
  return { width: mask.width, height: mask.height, runs: Uint32Array.from(runs) };
}

export function decodeRle(rle: RleMask): Mask {
  const mask = emptyMask(rle.width, rle.height);
  let at = 0;
  let value = 0;
  for (const run of rle.runs) {
    if (value === 1) mask.data.fill(1, at, at + run);
    at += run;
    value = value === 0 ? 1 : 0;
  }
  return mask;
}

/** How many pixels are set. */
export function maskArea(mask: Mask): number {
  let total = 0;
  for (const value of mask.data) {
    if (value !== 0) total += 1;
  }
  return total;
}

/** The smallest box that holds every set pixel, or nothing when the mask is empty. */
export function maskBounds(mask: Mask): MaskBounds | undefined {
  let x0 = mask.width;
  let y0 = mask.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < mask.height; y += 1) {
    const row = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[row + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return undefined;
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Every pixel that is set in either mask. */
export function unionMask(a: Mask, b: Mask): Mask {
  requireSameSize(a, b);
  const result = emptyMask(a.width, a.height);
  for (let i = 0; i < result.data.length; i += 1) {
    result.data[i] = a.data[i] !== 0 || b.data[i] !== 0 ? 1 : 0;
  }
  return result;
}

/** Every pixel that is set in `a` and clear in `b`. */
export function subtractMask(a: Mask, b: Mask): Mask {
  requireSameSize(a, b);
  const result = emptyMask(a.width, a.height);
  for (let i = 0; i < result.data.length; i += 1) {
    result.data[i] = a.data[i] !== 0 && b.data[i] === 0 ? 1 : 0;
  }
  return result;
}

/** How many of the nine pixels around and including (x, y) are set. */
function neighbourhoodCount(mask: Mask, x: number, y: number): number {
  let count = 0;
  for (let ny = y - 1; ny <= y + 1; ny += 1) {
    if (ny < 0 || ny >= mask.height) continue;
    for (let nx = x - 1; nx <= x + 1; nx += 1) {
      if (nx < 0 || nx >= mask.width) continue;
      if (mask.data[ny * mask.width + nx] !== 0) count += 1;
    }
  }
  return count;
}

/** Add every pixel that touches a set pixel, including on the diagonal. */
export function dilate(mask: Mask): Mask {
  const result = emptyMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      result.data[y * mask.width + x] = neighbourhoodCount(mask, x, y) > 0 ? 1 : 0;
    }
  }
  return result;
}

/**
 * Keep only the pixels whose eight neighbours are all set.
 *
 * Outside the mask counts as clear, so this always clears the border row and
 * the border column.
 */
export function erode(mask: Mask): Mask {
  const result = emptyMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      result.data[y * mask.width + x] = neighbourhoodCount(mask, x, y) === 9 ? 1 : 0;
    }
  }
  return result;
}

/** The middle of the set pixels, or nothing when the mask is empty. */
export function maskCentroid(mask: Mask): { x: number; y: number } | undefined {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < mask.height; y += 1) {
    const row = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[row + x] === 0) continue;
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  if (count === 0) return undefined;
  return { x: sumX / count, y: sumY / count };
}
