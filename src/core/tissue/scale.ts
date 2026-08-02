/**
 * The signal scale that the tissue classifier reads.
 *
 * MRI signal has no unit. A CT number is Hounsfield and means the same thing on
 * every scanner, but an MRI value means nothing on its own: it moves with the
 * coil, the gain, and the distance from the coil. So a threshold on the raw
 * value cannot name a tissue.
 *
 * What a radiologist does instead is compare against a tissue in the same
 * image, and in a limb the tissue that is always there is muscle. This module
 * puts muscle at a fixed place on the scale, so a threshold above it means
 * "brighter than muscle" and holds for any scan of any arm.
 *
 * Muscle is found as the middle of the body. In a limb, muscle is the largest
 * soft tissue by volume, so the median voxel inside the arm is muscle. That is
 * an approximation, and it fails on a study that is mostly fat or mostly bone.
 *
 * CAUTION: the earlier scale divided by the 99.5th percentile of the whole
 * volume. That percentile follows how much air the technologist left in the
 * field of view, so muscle landed on a band edge and half of the fat fell into
 * the muscle band.
 */
import type { Volume } from "../volume/build.ts";

/** Where muscle sits on the 0 to 1 scale that the classifier reads. */
export const MUSCLE_LEVEL = 0.3;

/**
 * A voxel counts as body when it is above this share of the brightest tissue.
 *
 * Air and its noise sit far below any tissue, so the floor only has to separate
 * the two. It does not have to trace the skin.
 */
export const BODY_FLOOR = 0.12;

/** The brightest tissue, not the brightest voxel. One hot voxel is noise. */
export const TISSUE_TOP = 0.998;

const BINS = 1024;

export interface SignalRange {
  /** The stored fraction that reads as no signal. */
  readonly low: number;
  /** The stored fraction that reads as the top of the scale. */
  readonly high: number;
}

/** Put a stored fraction on the classifier's scale. */
export function toSignal(stored: number, range: SignalRange): number {
  return Math.min(1, Math.max(0, (stored - range.low) / Math.max(range.high - range.low, 1e-6)));
}

/**
 * The scale for one volume, anchored so that muscle reads `MUSCLE_LEVEL`.
 *
 * `low` is zero, because no signal means no signal on every MRI sequence. Only
 * the slope is measured, which makes the scale a plain multiple and keeps a
 * threshold readable as "this many times muscle".
 */
export function muscleRange(volume: Volume, sampleStride = 7): SignalRange {
  const { min, max } = volume.valueRange;
  const span = max - min;
  if (span <= 0) return { low: 0, high: 1 };

  const histogram = new Uint32Array(BINS);
  const scale = (BINS - 1) / span;
  let counted = 0;
  for (let i = 0; i < volume.data.length; i += sampleStride) {
    histogram[Math.round((volume.data[i]! - min) * scale)]! += 1;
    counted += 1;
  }

  const binAt = (fraction: number): number => {
    let target = counted * fraction;
    for (let bin = 0; bin < BINS; bin += 1) {
      target -= histogram[bin]!;
      if (target <= 0) return bin;
    }
    return BINS - 1;
  };

  const floor = Math.round(binAt(TISSUE_TOP) * BODY_FLOOR);
  let body = 0;
  for (let bin = floor; bin < BINS; bin += 1) body += histogram[bin]!;
  if (body === 0) return { low: 0, high: 1 };

  let seen = 0;
  let median = floor;
  for (let bin = floor; bin < BINS; bin += 1) {
    seen += histogram[bin]!;
    if (seen * 2 >= body) {
      median = bin;
      break;
    }
  }

  const muscle = median / (BINS - 1);
  return { low: 0, high: Math.max(muscle / MUSCLE_LEVEL, 1e-4) };
}
