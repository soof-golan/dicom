import { describe, expect, it } from "vite-plus/test";
import { readSeries, SERIES_NAMES } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import {
  affineFromAxes,
  applyAffine,
  invertAffine,
  length,
  scale,
  subtract,
  type Vec3,
} from "../geometry/vec3.ts";
import { createSampler } from "../tissue/resample.ts";
import type { Volume } from "./build.ts";
import { buildVolume } from "./build.ts";
import { FusionError, fuseVolumes, planFusion, shareFrameOfReference } from "./fuse.ts";

const volumeOf = (name: (typeof SERIES_NAMES)[number]) =>
  buildVolume(readSeries(name).map((bytes) => readInstance(parseDicom(bytes))));

const coronal = volumeOf("pd_tse_fs_cor_DRB");
const axial = volumeOf("pd_tse_fs_tra_DRB");
const sagittal = volumeOf("pd_tse_fs_sag_DRB");
const all = [coronal, axial, sagittal];

describe("shareFrameOfReference", () => {
  it("accepts the three fat-saturated series of the real study", () => {
    expect(shareFrameOfReference(all)).toBe(true);
  });

  it("refuses a series from another frame of reference", () => {
    expect(shareFrameOfReference([coronal, { ...axial, frameOfReferenceUid: "1.2.3" }])).toBe(
      false,
    );
  });

  it("refuses volumes that name no frame of reference", () => {
    // An empty identifier says nothing, so it must never count as a match.
    const nameless = { ...coronal, frameOfReferenceUid: "" };
    expect(shareFrameOfReference([nameless, { ...axial, frameOfReferenceUid: "" }])).toBe(false);
  });
});

describe("planFusion", () => {
  it("makes a grid with the same step along all three axes", () => {
    const grid = planFusion(all);
    expect(grid.spacing[0]).toBeCloseTo(grid.spacing[1], 6);
    expect(grid.spacing[1]).toBeCloseTo(grid.spacing[2], 6);
  });

  it("stays inside the voxel budget", () => {
    const budget = 200_000;
    const grid = planFusion(all, { voxelBudget: budget });
    expect(grid.dims[0] * grid.dims[1] * grid.dims[2]).toBeLessThanOrEqual(budget);
  });

  it("makes a finer grid when the budget grows", () => {
    const small = planFusion(all, { voxelBudget: 50_000 });
    const large = planFusion(all, { voxelBudget: 4_000_000 });
    expect(large.spacing[0]).toBeLessThan(small.spacing[0]);
  });

  it("covers every corner of every series it was given", () => {
    const grid = planFusion(all);
    for (const volume of all) {
      const [nx, ny, nz] = volume.dims;
      for (const voxel of [
        [-0.5, -0.5, -0.5],
        [nx - 0.5, ny - 0.5, nz - 0.5],
      ] as const) {
        const point = applyAffine(volume.voxelToPatient, voxel);
        for (let axis = 0; axis < 3; axis += 1) {
          expect(point[axis]).toBeGreaterThanOrEqual(grid.origin[axis]! - grid.spacing[axis]!);
          const far = grid.origin[axis]! + grid.dims[axis]! * grid.spacing[axis]!;
          expect(point[axis]).toBeLessThanOrEqual(far + grid.spacing[axis]!);
        }
      }
    }
  });

  it("uses a spacing the caller asks for", () => {
    expect(planFusion(all, { spacing: 2 }).spacing[0]).toBeCloseTo(2, 6);
  });
});

describe("fuseVolumes", () => {
  // The fixtures are 64x64x3 crops, so a small budget keeps the test quick.
  const options = { voxelBudget: 120_000 };
  const fused = fuseVolumes(all, options);

  it("refuses fewer than two series, because one cannot be fused", () => {
    expect(() => fuseVolumes([coronal])).toThrow(FusionError);
  });

  it("refuses series from different frames of reference", () => {
    const stranger = { ...axial, frameOfReferenceUid: "1.2.3" };
    expect(() => fuseVolumes([coronal, stranger])).toThrow(FusionError);
  });

  it("makes a volume whose voxels are the same size along every axis", () => {
    expect(fused.spacing[0]).toBeCloseTo(fused.spacing[1], 6);
    expect(fused.spacing[1]).toBeCloseTo(fused.spacing[2], 6);
  });

  it("is more isotropic than any series it came from", () => {
    // This is the whole point. Each source steps about 12 times further between
    // slices than between pixels, and that is what makes a reformat streaky.
    const ratio = (v: { spacing: readonly number[] }) =>
      Math.max(...v.spacing) / Math.min(...v.spacing);
    expect(ratio(fused)).toBeLessThan(1.01);
    for (const source of all) expect(ratio(source)).toBeGreaterThan(2);
  });

  it("holds data of the size its own dimensions claim", () => {
    expect(fused.data.length).toBe(fused.dims[0] * fused.dims[1] * fused.dims[2]);
  });

  it("keeps the frame of reference, so it still lines up with the study", () => {
    expect(fused.frameOfReferenceUid).toBe(coronal.frameOfReferenceUid);
  });

  it("warns that it is a derived volume and not scanner data", () => {
    expect(fused.warnings.join(" ")).toMatch(/derived|combin|fus/i);
  });

  it("names the series it came from", () => {
    for (const source of all) expect(fused.description).toContain(String(source.dims[0]));
  });

  it("writes signal, not an empty grid", () => {
    let filled = 0;
    for (let i = 0; i < fused.data.length; i += 1) if (fused.data[i]! > 0) filled += 1;
    expect(filled).toBeGreaterThan(fused.data.length / 100);
  });

  it("reports a value range that matches the data it wrote", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < fused.data.length; i += 1) {
      const value = fused.data[i]!;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    expect(fused.valueRange.min).toBe(min);
    expect(fused.valueRange.max).toBe(max);
  });

  it("puts its axes along the patient axes, which is what isotropic means here", () => {
    // Column-major: the first three entries are the i axis in patient space.
    const m = fused.voxelToPatient;
    expect(Math.abs(m[0]!)).toBeCloseTo(fused.spacing[0], 6);
    expect(m[1]).toBeCloseTo(0, 6);
    expect(m[2]).toBeCloseTo(0, 6);
  });

  it("places voxel (0,0,0) at the origin of its own grid", () => {
    const point = applyAffine(fused.voxelToPatient, [0, 0, 0]);
    const grid = planFusion(all, options);
    expect(length(subtract(point, grid.origin))).toBeLessThan(1e-6);
  });
});

describe("what fusion is for", () => {
  it("samples a point that one series covers and another does not", () => {
    // The three series were prescribed over different boxes, so the fused
    // volume reaches past any single one of them. A voxel that only one series
    // saw must still carry that series' signal, not a hole.
    const fused = fuseVolumes(all, { voxelBudget: 120_000 });
    expect(fused.valueRange.max).toBeGreaterThan(0);
  });

  it("gives the same answer twice for the same input", () => {
    const options = { voxelBudget: 60_000 };
    const first = fuseVolumes(all, options);
    const second = fuseVolumes(all, options);
    expect(first.dims).toEqual(second.dims);
    for (let i = 0; i < first.data.length; i += 997) {
      expect(first.data[i]).toBe(second.data[i]);
    }
  });

  it("does not depend on the order the series arrive in", () => {
    const options = { voxelBudget: 60_000 };
    const forward = fuseVolumes([coronal, axial, sagittal], options);
    const backward = fuseVolumes([sagittal, axial, coronal], options);
    expect(forward.dims).toEqual(backward.dims);
    for (let i = 0; i < forward.data.length; i += 997) {
      // Weighted averaging commutes, so only rounding can differ.
      expect(Math.abs(forward.data[i]! - backward.data[i]!)).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * Two series that disagree, cut at right angles.
 *
 * The real fixtures are three slices deep, which is too shallow to show a
 * pattern that repeats with the slice step. These are built to be deep enough,
 * and to disagree, because disagreement is what any uneven weighting turns
 * into a visible ripple.
 */
function ramp(
  along: "i" | "k",
  axes: readonly [Vec3, Vec3, Vec3],
  dims: readonly [number, number, number],
): Volume {
  const [nx, ny, nz] = dims;
  const spacing: readonly [number, number, number] = [0.3, 0.3, 3.3];
  const data = new Uint16Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        // A smooth ramp, so any roughness in the result came from fusion.
        const t = along === "i" ? i / (nx - 1) : k / (nz - 1);
        data[k * nx * ny + j * nx + i] = Math.round(400 + t * 3000);
      }
    }
  }
  return {
    dims,
    spacing,
    origin: [0, 0, 0],
    axes,
    voxelToPatient: affineFromAxes(
      scale(axes[0], spacing[0]),
      scale(axes[1], spacing[1]),
      scale(axes[2], spacing[2]),
      [0, 0, 0],
    ),
    data,
    signed: false,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    valueRange: { min: 400, max: 3400 },
    description: "synthetic",
    modality: "MR",
    seriesInstanceUid: `synthetic-${along}-${axes[2].join(",")}`,
    frameOfReferenceUid: "1.2.826.0.1.3680043.8.498.test",
    warnings: [],
  };
}

describe("banding at the slice period of a source", () => {
  // Both cover the same box. One steps its slices along patient z, the other
  // along patient x, so along x the first is smooth and the second crosses a
  // measured slice every 3.3 mm.
  const alongZ = ramp(
    "i",
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [64, 64, 24],
  );
  const alongX = ramp(
    "k",
    [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ],
    [64, 64, 24],
  );

  const fused = fuseVolumes([alongZ, alongX], { spacing: 0.9 });
  const toVoxel = invertAffine(fused.voxelToPatient);

  /** Read the fused volume along patient x, at a line inside both sources. */
  function lineAlongX(): number[] {
    const [nx, ny] = fused.dims;
    const start = applyAffine(toVoxel, [0, 6, 6]);
    const j = Math.round(start[1]);
    const k = Math.round(start[2]);
    const base = k * nx * ny + j * nx;
    const values: number[] = [];
    // The two boxes overlap over about 19 mm of x. Stay inside it.
    for (let i = Math.round(start[0]); i < Math.round(start[0]) + 19; i += 1) {
      values.push(fused.data[base + i] ?? 0);
    }
    return values;
  }

  /** Mean second difference. A ripple voxel to voxel makes this large. */
  function roughness(values: readonly number[]): number {
    let total = 0;
    for (let i = 1; i < values.length - 1; i += 1) {
      total += Math.abs(values[i - 1]! - 2 * values[i]! + values[i + 1]!);
    }
    return total / Math.max(values.length - 2, 1);
  }

  it("reads a line where both sources contribute and they disagree", () => {
    // Without this the smoothness test below would pass for the wrong reason.
    // Two sources that agree, or a line only one of them reaches, ripple
    // however they are weighted.
    const a = createSampler(alongZ);
    const b = createSampler(alongX);
    let both = 0;
    let differ = 0;
    for (let step = 0; step < 19; step += 1) {
      const point: Vec3 = [step, 6, 6];
      const first = a.normalizedAt(point);
      const second = b.normalizedAt(point);
      if (first === undefined || second === undefined) continue;
      both += 1;
      if (Math.abs(first - second) > 0.15) differ += 1;
    }
    expect(both).toBeGreaterThan(15);
    expect(differ).toBeGreaterThan(10);
  });

  it("stays smooth where both sources are smooth", () => {
    // Both inputs are ramps, so a correct fusion of them is smooth too. An
    // earlier version weighted each sample by its distance to a measured
    // slice. Those weights repeat with the slice step, so where the sources
    // disagreed the blend rang at about four voxels, and the rings were
    // plainer than the blur they were meant to avoid.
    const values = lineAlongX();
    expect(values.filter((v) => v > 0).length).toBeGreaterThan(15);
    expect(roughness(values)).toBeLessThan(60);
  });
});
