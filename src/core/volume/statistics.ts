/**
 * Measurements over the voxels of a volume.
 *
 * These read the whole grid, so a caller measures once and keeps the answer.
 */
import type { Volume } from "./build.ts";

/**
 * Where most of the signal sits, as a fraction of the stored range.
 *
 * MRI signal is not calibrated. One sequence can peak at 900 and another at
 * 4000 for the same tissue, and both carry a thin bright tail from noise and
 * flowing blood. So the lowest and highest stored values say almost nothing
 * about where tissue sits, and anything scaled by them lands too low.
 *
 * The percentiles say it instead. The result is 0 to 1 across the stored
 * range, which is the same unit the GPU texture holds, so the shader can use
 * it without any further conversion.
 */
export function percentileRange(
  volume: Volume,
  lowFraction = 0.01,
  highFraction = 0.995,
  sampleStride = 7,
): { low: number; high: number } {
  const { min, max } = volume.valueRange;
  const span = max - min;
  if (span <= 0) return { low: 0, high: 1 };

  const BINS = 1024;
  const histogram = new Uint32Array(BINS);
  const scale = (BINS - 1) / span;
  let counted = 0;
  for (let i = 0; i < volume.data.length; i += sampleStride) {
    histogram[Math.round((volume.data[i]! - min) * scale)]! += 1;
    counted += 1;
  }

  const at = (fraction: number): number => {
    let target = counted * fraction;
    for (let bin = 0; bin < BINS; bin += 1) {
      target -= histogram[bin]!;
      if (target <= 0) return bin / (BINS - 1);
    }
    return 1;
  };

  const low = at(lowFraction);
  const high = at(highFraction);
  return { low, high: Math.max(high, low + 1e-4) };
}
