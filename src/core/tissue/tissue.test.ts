import { describe, expect, it } from "vite-plus/test";
import { readSeries, SERIES_NAMES } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { applyAffine } from "../geometry/vec3.ts";
import { buildVolume } from "../volume/build.ts";
import {
  classifyPair,
  classifySingle,
  FATSAT_THRESHOLDS,
  T1_THRESHOLDS,
  tally,
  TISSUE_INFO,
  TISSUE_ORDER,
  type TissueClass,
} from "./classify.ts";
import { createSampler, sharesFrameOfReference, overlaps, trilinear } from "./resample.ts";
import { MUSCLE_LEVEL } from "./scale.ts";

/** A signal, as a multiple of muscle. This is the scale the classifier reads. */
const times = (muscles: number) => muscles * MUSCLE_LEVEL;

const volumeOf = (name: (typeof SERIES_NAMES)[number]) =>
  buildVolume(readSeries(name).map((bytes) => readInstance(parseDicom(bytes))));

const pdfs = volumeOf("pd_tse_fs_cor_DRB");
const t1 = volumeOf("t1_tse_cor_DRB");

describe("classifyPair", () => {
  it("calls bright T1 with dark fat-sat fat", () => {
    expect(classifyPair({ t1: 0.75, pdfs: 0.15 }).tissue).toBe("fat");
  });

  it("reports fatty marrow and subcutaneous fat as the one class they are", () => {
    // Both are fat, and no signal separates them. A brightness cut on T1 was
    // measured against the reference elbow and told nothing about the place.
    expect(classifyPair({ t1: times(2.6), pdfs: times(0.4) }).tissue).toBe("fat");
    expect(TISSUE_ORDER).not.toContain("marrow");
    expect(TISSUE_INFO.fat.covers).toMatch(/no signal separates/i);
  });

  it("calls fat any tissue the fat pulse removes, even at muscle brightness", () => {
    // A surface coil leaves far fat no brighter than near muscle on T1. Only
    // the drop under fat saturation names it, and nothing but fat drops.
    expect(classifyPair({ t1: times(1.0), pdfs: times(0.4) }).tissue).toBe("fat");
  });

  it("calls dark T1 with bright fat-sat fluid", () => {
    expect(classifyPair({ t1: times(0.5), pdfs: times(3.0) }).tissue).toBe("fluid");
  });

  it("calls middle T1 with bright fat-sat edema", () => {
    // This is the signal of a bone bruise, and it is invisible on T1 alone.
    expect(classifyPair({ t1: times(1.0), pdfs: times(2.8) }).tissue).toBe("edema");
  });

  it("refuses to call bright on both edema, because edema is water", () => {
    // Water is never bright on T1. This pair means the fat pulse failed there,
    // or that blood is breaking down. Calling it edema flooded the arm pink.
    expect(classifyPair({ t1: times(2.0), pdfs: times(3.0) }).tissue).toBe("unknown");
  });

  it("needs water far brighter than muscle before it says edema", () => {
    // Ordinary tissue reaches twice muscle on a fat-saturated sequence.
    expect(classifyPair({ t1: times(1.0), pdfs: times(2.0) }).tissue).toBe("muscle");
  });

  it("calls middle on both muscle", () => {
    expect(classifyPair({ t1: times(1.0), pdfs: times(1.0) }).tissue).toBe("muscle");
  });

  it("groups cortical bone, tendon, and ligament as one dark class", () => {
    const result = classifyPair({ t1: 0.12, pdfs: 0.1 });
    expect(result.tissue).toBe("dark");
    expect(TISSUE_INFO.dark.covers).toMatch(/cannot be separated/i);
  });

  it("calls a voxel outside the body background", () => {
    expect(classifyPair({ t1: 0.01, pdfs: 0.02 }).tissue).toBe("background");
  });

  it("separates fat from fluid, which one sequence cannot", () => {
    // Both look bright on their own sequence. Only the pair tells them apart.
    expect(classifyPair({ t1: 0.8, pdfs: 0.1 }).tissue).toBe("fat");
    expect(classifyPair({ t1: 0.1, pdfs: 0.8 }).tissue).toBe("fluid");
  });

  it("reports low confidence at a boundary", () => {
    const edge = classifyPair({ t1: T1_THRESHOLDS.low, pdfs: FATSAT_THRESHOLDS.low });
    const clear = classifyPair({ t1: times(1.0), pdfs: times(1.0) });
    expect(edge.confidence).toBeLessThan(clear.confidence);
  });

  it("gives each sequence its own band edges, because their contrast differs", () => {
    // Fat reaches about 1.4 times muscle on T1. Water reaches three times
    // muscle after fat saturation. One edge for both floods the arm with edema.
    expect(FATSAT_THRESHOLDS.high).toBeGreaterThan(T1_THRESHOLDS.high * 1.5);
  });
});

describe("classifySingle", () => {
  it("caps confidence below the two-sequence answer", () => {
    const one = classifySingle({ pdfs: 0.85 });
    const two = classifyPair({ t1: 0.15, pdfs: 0.85 });
    expect(one.confidence).toBeLessThan(two.confidence);
  });

  it("reads bright fat-sat signal as fluid", () => {
    expect(classifySingle({ pdfs: 0.9 }).tissue).toBe("fluid");
  });

  it("reads bright T1 signal as fat", () => {
    expect(classifySingle({ t1: 0.9 }).tissue).toBe("fat");
  });

  it("is used when one sequence is missing", () => {
    expect(classifyPair({ pdfs: 0.9 }).tissue).toBe(classifySingle({ pdfs: 0.9 }).tissue);
  });
});

describe("the tissue table", () => {
  it("describes every class", () => {
    for (const id of Object.keys(TISSUE_INFO) as TissueClass[]) {
      expect(TISSUE_INFO[id].name.length).toBeGreaterThan(0);
      expect(TISSUE_INFO[id].covers.length).toBeGreaterThan(0);
    }
  });

  it("gives each legend entry a distinct color", () => {
    const seen = TISSUE_ORDER.map((id) => TISSUE_INFO[id].color.join(","));
    expect(new Set(seen).size).toBe(TISSUE_ORDER.length);
  });

  it("counts classes", () => {
    expect(tally(["fat", "fat", "muscle"]).fat).toBe(2);
    expect(tally([]).background).toBe(0);
  });
});

describe("trilinear", () => {
  it("returns the stored value at a voxel center", () => {
    const index = 2 * 64 * 64 + 10 * 64 + 20;
    expect(trilinear(pdfs, [20, 10, 2])).toBeCloseTo(pdfs.data[index]!, 4);
  });

  it("returns a value between the two neighbours halfway along", () => {
    // Row 0 of slice 0, so the index is just the column.
    const a = pdfs.data[10]!;
    const b = pdfs.data[11]!;
    const middle = trilinear(pdfs, [10.5, 0, 0])!;
    expect(middle).toBeGreaterThanOrEqual(Math.min(a, b));
    expect(middle).toBeLessThanOrEqual(Math.max(a, b));
  });

  it("returns nothing outside the grid", () => {
    expect(trilinear(pdfs, [-2, 0, 0])).toBeUndefined();
    expect(trilinear(pdfs, [0, 0, 99])).toBeUndefined();
  });
});

describe("sampling one series at the coordinates of another", () => {
  it("finds that the study shares one frame of reference", () => {
    expect(sharesFrameOfReference(pdfs, t1)).toBe(true);
  });

  it("refuses to compare series from different frames of reference", () => {
    const stranger = { ...t1, frameOfReferenceUid: "1.2.3.4" };
    expect(sharesFrameOfReference(pdfs, stranger)).toBe(false);
  });

  it("reads a series at its own coordinates without change", () => {
    const sampler = createSampler(pdfs);
    for (const voxel of [
      [0, 0, 0],
      [31, 31, 1],
      [63, 63, 2],
    ] as const) {
      const point = applyAffine(pdfs.voxelToPatient, voxel);
      expect(sampler.at(point)).toBeCloseTo(trilinear(pdfs, voxel)!, 3);
    }
  });

  it("reads the T1 series at coordinates taken from the fat-sat series", () => {
    const sampler = createSampler(t1);
    const point = applyAffine(pdfs.voxelToPatient, [32, 32, 1]);
    const value = sampler.at(point);
    expect(value).toBeDefined();
    expect(value).toBeGreaterThanOrEqual(t1.valueRange.min);
    expect(value).toBeLessThanOrEqual(t1.valueRange.max);
  });

  it("normalizes to 0 through 1", () => {
    const sampler = createSampler(t1);
    const point = applyAffine(t1.voxelToPatient, [32, 32, 1]);
    const value = sampler.normalizedAt(point)!;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it("finds that the two coronal series cover the same elbow", () => {
    expect(overlaps(createSampler(pdfs), createSampler(t1))).toBe(true);
  });

  it("returns nothing for a point far outside the patient", () => {
    expect(createSampler(t1).at([1e5, 1e5, 1e5])).toBeUndefined();
  });
});

describe("classifying real voxels from two real sequences", () => {
  it("produces a plausible mix of tissue across the crop", () => {
    const t1Sampler = createSampler(t1);
    const counts = tally(
      (function* () {
        const [nx, ny, nz] = pdfs.dims;
        const span = pdfs.valueRange.max - pdfs.valueRange.min || 1;
        for (let k = 0; k < nz; k += 1) {
          for (let j = 0; j < ny; j += 2) {
            for (let i = 0; i < nx; i += 2) {
              const point = applyAffine(pdfs.voxelToPatient, [i, j, k]);
              const fatSat = (pdfs.data[k * nx * ny + j * nx + i]! - pdfs.valueRange.min) / span;
              yield classifyPair({ t1: t1Sampler.normalizedAt(point), pdfs: fatSat }).tissue;
            }
          }
        }
      })(),
    );

    // The crop sits inside the elbow, so it must hold tissue, not only air.
    const classified = Object.values(counts).reduce((sum, n) => sum + n, 0) - counts.background;
    expect(classified).toBeGreaterThan(0);
    // Dark structures and muscle both appear in any elbow slice.
    expect(counts.dark).toBeGreaterThan(0);
    expect(counts.muscle + counts.fat).toBeGreaterThan(0);
  });
});
