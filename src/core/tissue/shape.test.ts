import { describe, expect, it } from "vite-plus/test";
import { readSeries } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { buildVolume } from "../volume/build.ts";
import {
  fieldFromVolume,
  hessianEigenvalues,
  prepareScales,
  shapeAt,
  smooth,
  type ScalarField,
} from "./shape.ts";

type Spacing = readonly [number, number, number];
type Dims = readonly [number, number, number];

/** Build a field by reading a function of the offset in millimetres. */
function synthetic(
  dims: Dims,
  spacing: Spacing,
  read: (x: number, y: number, z: number) => number,
): ScalarField {
  const [nx, ny, nz] = dims;
  const data = new Float32Array(nx * ny * nz);
  const centre = [(nx - 1) / 2, (ny - 1) / 2, (nz - 1) / 2] as const;
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const x = (i - centre[0]) * spacing[0];
        const y = (j - centre[1]) * spacing[1];
        const z = (k - centre[2]) * spacing[2];
        data[k * nx * ny + j * nx + i] = read(x, y, z);
      }
    }
  }
  return { dims, spacing, data };
}

/** A dark well of width `w`, in a surround of 1. This is the shape of a tendon. */
const well = (squared: number, w: number): number => 1 - Math.exp(-squared / (2 * w * w));

/** A dark tube along the j axis. Across it lie the i and k axes. */
const tube = (dims: Dims, spacing: Spacing, w = 3): ScalarField =>
  synthetic(dims, spacing, (x, _y, z) => well(x * x + z * z, w));

/** A dark sheet across the i axis. This is the shape of a cortical shell. */
const sheet = (dims: Dims, spacing: Spacing, w = 3): ScalarField =>
  synthetic(dims, spacing, (x) => well(x * x, w));

const blob = (dims: Dims, spacing: Spacing, w = 3): ScalarField =>
  synthetic(dims, spacing, (x, y, z) => well(x * x + y * y + z * z, w));

const middle = (field: ScalarField): readonly [number, number, number] => [
  Math.floor(field.dims[0] / 2),
  Math.floor(field.dims[1] / 2),
  Math.floor(field.dims[2] / 2),
];

/** The shape at the centre of a field, over the default scales. */
function shapeAtCentre(field: ScalarField): ReturnType<typeof shapeAt> {
  return shapeAt(prepareScales(field), ...middle(field));
}

const ISOTROPIC: Spacing = [0.6, 0.6, 0.6];
/** The real grid of this study: 0.27 mm in a slice, 3.3 mm between slices. */
const ANISOTROPIC: Spacing = [0.2734, 0.2734, 3.3];

describe("hessianEigenvalues", () => {
  it("sorts the eigenvalues by size, smallest first", () => {
    const field = tube([21, 21, 21], ISOTROPIC);
    const [e1, e2, e3] = hessianEigenvalues(field, 10, 10, 10);
    expect(Math.abs(e1)).toBeLessThanOrEqual(Math.abs(e2));
    expect(Math.abs(e2)).toBeLessThanOrEqual(Math.abs(e3));
  });

  it("makes the eigenvalues positive at a dark structure", () => {
    // A dark structure is a low point of the field, so the field curves up.
    const [, , e3] = hessianEigenvalues(blob([21, 21, 21], ISOTROPIC), 10, 10, 10);
    expect(e3).toBeGreaterThan(0);
  });

  it("gives one small eigenvalue along a tube", () => {
    const [e1, , e3] = hessianEigenvalues(tube([21, 21, 21], ISOTROPIC), 10, 10, 10);
    expect(Math.abs(e1)).toBeLessThan(Math.abs(e3) * 0.1);
  });

  it("gives the same eigenvalues for the same shape on two grids", () => {
    // The eigenvalues are a property of the patient, not of the sampling grid.
    const coarse = hessianEigenvalues(blob([25, 25, 25], [0.5, 0.5, 0.5]), 12, 12, 12);
    const fine = hessianEigenvalues(blob([49, 49, 49], [0.25, 0.25, 0.25]), 24, 24, 24);
    for (let index = 0; index < 3; index += 1) {
      expect(coarse[index]!).toBeCloseTo(fine[index]!, 2);
    }
  });

  it("returns zeros outside the grid", () => {
    expect(hessianEigenvalues(tube([21, 21, 21], ISOTROPIC), 0, 10, 10)).toEqual([0, 0, 0]);
  });
});

describe("shapeAt", () => {
  it("calls a tube a tube", () => {
    expect(shapeAtCentre(tube([25, 25, 25], ISOTROPIC)).kind).toBe("tube");
  });

  it("calls a sheet a sheet", () => {
    expect(shapeAtCentre(sheet([25, 25, 25], ISOTROPIC)).kind).toBe("sheet");
  });

  it("calls a blob a blob", () => {
    expect(shapeAtCentre(blob([25, 25, 25], ISOTROPIC)).kind).toBe("blob");
  });

  it("names no shape in a flat field", () => {
    const flat = synthetic([21, 21, 21], ISOTROPIC, () => 0.5);
    const answer = shapeAtCentre(flat);
    expect(answer.kind).toBe("none");
    expect(answer.confidence).toBe(0);
  });

  it("names no shape at a bright ridge", () => {
    // The field curves down, so the structure is bright, not dark.
    const bright = synthetic([25, 25, 25], ISOTROPIC, (x, _y, z) => 1 - well(x * x + z * z, 3));
    expect(shapeAtCentre(bright).kind).toBe("none");
  });

  it("is more sure about a clear tube than about a rounded one", () => {
    const clear = shapeAtCentre(tube([25, 25, 25], ISOTROPIC));
    const rounded = shapeAtCentre(
      synthetic([25, 25, 25], ISOTROPIC, (x, y, z) => well(x * x + 0.6 * y * y + z * z, 3)),
    );
    expect(clear.confidence).toBeGreaterThan(rounded.confidence);
  });

  it("reports which scale answered", () => {
    const answer = shapeAtCentre(tube([25, 25, 25], ISOTROPIC));
    expect(answer.scale).toBeGreaterThan(0);
  });
});

describe("voxels that are 12 times longer between slices", () => {
  it("still calls a tube a tube", () => {
    // The same tube, sampled on the grid this study really used.
    const field = tube([81, 9, 9], ANISOTROPIC);
    expect(shapeAtCentre(field).kind).toBe("tube");
  });

  it("still calls a sheet a sheet", () => {
    expect(shapeAtCentre(sheet([81, 9, 9], ANISOTROPIC)).kind).toBe("sheet");
  });

  it("calls the same tube a sheet when the spacing is ignored", () => {
    // This is the trap. In index space the step between slices counts the same
    // as the step across a row, and every structure becomes a sheet.
    const field = tube([81, 9, 9], ANISOTROPIC);
    const blind: ScalarField = { ...field, spacing: [1, 1, 1] };
    expect(shapeAtCentre(field).kind).toBe("tube");
    expect(shapeAtCentre(blind).kind).toBe("sheet");
  });
});

describe("smooth", () => {
  it("keeps a flat field flat", () => {
    const flat = synthetic([15, 15, 15], ISOTROPIC, () => 0.4);
    const result = smooth(flat, 1.5);
    expect(result.data[7 * 225 + 7 * 15 + 7]).toBeCloseTo(0.4, 5);
  });

  it("raises the lowest point of a dark well", () => {
    const field = tube([25, 25, 25], ISOTROPIC, 1);
    const before = field.data[12 * 625 + 12 * 25 + 12]!;
    const after = smooth(field, 2).data[12 * 625 + 12 * 25 + 12]!;
    expect(after).toBeGreaterThan(before);
  });

  it("smooths in millimetres, so a thick axis blurs less by index", () => {
    // One millimetre is a fraction of a slice step, so slices stay separate.
    const field = synthetic([9, 9, 9], ANISOTROPIC, (_x, _y, z) => (Math.abs(z) < 1 ? 0 : 1));
    const result = smooth(field, 1);
    expect(result.data[4 * 81 + 4 * 9 + 4]).toBeLessThan(0.35);
  });
});

describe("fieldFromVolume", () => {
  const volume = buildVolume(
    readSeries("pd_tse_fs_cor_DRB").map((bytes) => readInstance(parseDicom(bytes))),
  );

  it("carries the spacing of the volume", () => {
    expect(fieldFromVolume(volume).spacing).toEqual(volume.spacing);
  });

  it("maps the stored range onto 0 through 1", () => {
    const field = fieldFromVolume(volume);
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const value of field.data) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThan(0.5);
  });

  it("answers with a shape somewhere in a real elbow crop", () => {
    const scales = prepareScales(fieldFromVolume(volume));
    const [nx, ny, nz] = volume.dims;
    let named = 0;
    for (let k = 0; k < nz; k += 1) {
      for (let j = 2; j < ny - 2; j += 4) {
        for (let i = 2; i < nx - 2; i += 4) {
          if (shapeAt(scales, i, j, k).kind !== "none") named += 1;
        }
      }
    }
    expect(named).toBeGreaterThan(0);
  });
});
