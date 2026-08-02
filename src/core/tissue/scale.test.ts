import { describe, expect, it } from "vite-plus/test";
import { readSeries, type SeriesName } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import type { Volume } from "../volume/build.ts";
import { buildVolume } from "../volume/build.ts";
import { BODY_FLOOR, MUSCLE_LEVEL, muscleRange, TISSUE_TOP, toSignal } from "./scale.ts";

const volumeOf = (name: SeriesName) =>
  buildVolume(readSeries(name).map((bytes) => readInstance(parseDicom(bytes))));

const pdfs = volumeOf("pd_tse_fs_cor_DRB");
const t1 = volumeOf("t1_tse_cor_DRB");

/** Every voxel as a fraction of the stored range, darkest first. */
function stored(volume: Volume): number[] {
  const { min, max } = volume.valueRange;
  const span = max - min || 1;
  return [...volume.data].map((raw) => (raw - min) / span).sort((a, b) => a - b);
}

/** Every voxel on the classifier's scale, darkest first. */
function signals(volume: Volume): number[] {
  const range = muscleRange(volume);
  return stored(volume).map((value) => toSignal(value, range));
}

/** The volume, with every voxel multiplied. This is what a gain change does. */
function amplified(volume: Volume, gain: number): Volume {
  return {
    ...volume,
    data: Uint32Array.from(volume.data, (value) => Math.round(value * gain)),
    valueRange: {
      min: Math.round(volume.valueRange.min * gain),
      max: Math.round(volume.valueRange.max * gain),
    },
  };
}

describe("muscleRange", () => {
  it("puts the middle of the body at the muscle level", () => {
    // Counted from the sorted voxels, so the histogram inside is checked
    // against a second, independent way of finding the same median. The two
    // differ by a few percent, because the histogram samples every 7th voxel.
    for (const volume of [pdfs, t1]) {
      const sorted = stored(volume);
      const top = sorted[Math.floor(TISSUE_TOP * sorted.length)]!;
      const inside = sorted.filter((value) => value > BODY_FLOOR * top);
      const median = inside[Math.floor(inside.length / 2)]!;
      expect(toSignal(median, muscleRange(volume))).toBeCloseTo(MUSCLE_LEVEL, 1);
    }
  });

  it("gives the same signal after the scanner gain changes", () => {
    // This is why the scale is anchored on tissue. MRI signal has no unit, so
    // the same elbow scanned twice can differ by any factor.
    const plain = signals(t1);
    for (const gain of [0.5, 3]) {
      const scaled = signals(amplified(t1, gain));
      for (const at of [0.1, 0.5, 0.9]) {
        const index = Math.floor(at * plain.length);
        expect(scaled[index]!).toBeCloseTo(plain[index]!, 2);
      }
    }
  });

  it("leaves headroom above muscle for fluid, which is far brighter", () => {
    // Fluid reaches four times the signal of muscle. A scale that clipped there
    // would push an effusion and normal muscle into the same band.
    expect(MUSCLE_LEVEL).toBeLessThan(0.34);
  });

  it("reads zero signal as zero, because MRI has no negative offset", () => {
    expect(muscleRange(t1).low).toBe(0);
    expect(toSignal(0, muscleRange(t1))).toBe(0);
  });

  it("survives a volume with no signal at all", () => {
    const empty: Volume = {
      ...t1,
      data: new Uint16Array(t1.data.length),
      valueRange: { min: 0, max: 0 },
    };
    expect(Number.isFinite(muscleRange(empty).high)).toBe(true);
  });
});

describe("toSignal", () => {
  it("holds the value inside 0 and 1", () => {
    const range = { low: 0, high: 0.5 };
    expect(toSignal(-1, range)).toBe(0);
    expect(toSignal(9, range)).toBe(1);
    expect(toSignal(0.25, range)).toBeCloseTo(0.5, 6);
  });
});
