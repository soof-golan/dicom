import { describe, expect, it } from "vite-plus/test";
import { readSeries } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { applyAffine, dot, type Vec3 } from "../geometry/vec3.ts";
import { buildVolume } from "../volume/build.ts";
import {
  autoWindow,
  clampToBounds,
  cursorInPlane,
  clipEquation,
  defaultWindow,
  patientBounds,
  standardPlane,
  standardPlanes,
} from "./planes.ts";

const volume = buildVolume(
  readSeries("pd_tse_fs_cor_DRB").map((bytes) => readInstance(parseDicom(bytes))),
);

describe("patientBounds", () => {
  const bounds = patientBounds(volume);

  it("holds every corner of the volume", () => {
    const [nx, ny, nz] = volume.dims;
    for (const i of [0, nx - 1]) {
      for (const j of [0, ny - 1]) {
        for (const k of [0, nz - 1]) {
          const point = applyAffine(volume.voxelToPatient, [i, j, k]);
          for (let axis = 0; axis < 3; axis += 1) {
            expect(point[axis]).toBeGreaterThanOrEqual(bounds.min[axis]! - 1e-6);
            expect(point[axis]).toBeLessThanOrEqual(bounds.max[axis]! + 1e-6);
          }
        }
      }
    }
  });

  it("puts the center halfway between the corners", () => {
    for (let axis = 0; axis < 3; axis += 1) {
      expect(bounds.center[axis]).toBeCloseTo((bounds.min[axis]! + bounds.max[axis]!) / 2, 6);
    }
  });

  it("measures a diagonal that spans the elbow", () => {
    // 64 voxels at 0.27 mm across, 3 slices at 3.3 mm: a small crop.
    expect(bounds.diagonal).toBeGreaterThan(10);
    expect(bounds.diagonal).toBeLessThan(60);
  });
});

describe("standardPlane", () => {
  const cursor = patientBounds(volume).center;

  it("gives three views", () => {
    expect(standardPlanes(volume, cursor).map((plane) => plane.id)).toEqual([
      "axial",
      "coronal",
      "sagittal",
    ]);
  });

  it("uses screen axes at right angles", () => {
    for (const plane of standardPlanes(volume, cursor)) {
      expect(dot(plane.u, plane.v)).toBeCloseTo(0, 6);
      expect(dot(plane.u, plane.normal)).toBeCloseTo(0, 6);
      expect(dot(plane.v, plane.normal)).toBeCloseTo(0, 6);
    }
  });

  it("puts the patient's left on the right of an axial view", () => {
    expect(standardPlane(volume, "axial", cursor).edges.right).toBe("L");
    expect(standardPlane(volume, "axial", cursor).edges.left).toBe("R");
  });

  it("puts anterior at the top of an axial view", () => {
    expect(standardPlane(volume, "axial", cursor).edges.top).toBe("A");
    expect(standardPlane(volume, "axial", cursor).edges.bottom).toBe("P");
  });

  it("puts superior at the top of a coronal view", () => {
    const coronal = standardPlane(volume, "coronal", cursor);
    expect(coronal.edges.top).toBe("S");
    expect(coronal.edges.bottom).toBe("I");
    expect(coronal.edges.right).toBe("L");
  });

  it("looks at the patient from the left in a sagittal view", () => {
    const sagittal = standardPlane(volume, "sagittal", cursor);
    expect(sagittal.edges.top).toBe("S");
    expect(sagittal.edges.left).toBe("A");
    expect(sagittal.edges.right).toBe("P");
  });

  it("sizes each view to hold the whole volume", () => {
    const bounds = patientBounds(volume);
    for (const plane of standardPlanes(volume, cursor)) {
      expect(plane.size[0]).toBeGreaterThan(0);
      expect(plane.size[1]).toBeGreaterThan(0);
      expect(Math.hypot(plane.size[0], plane.size[1])).toBeGreaterThanOrEqual(
        Math.max(bounds.size[0], bounds.size[1], bounds.size[2]) - 1e-6,
      );
    }
  });

  it("follows the cursor in depth only", () => {
    const bounds = patientBounds(volume);
    const moved: Vec3 = [bounds.center[0] + 20, bounds.center[1] - 15, bounds.center[2] + 5];
    const plane = standardPlane(volume, "axial", moved);

    // The cut moves to the depth of the cursor.
    expect(dot(plane.origin, plane.normal)).toBeCloseTo(dot(moved, plane.normal), 6);
    // The view stays where it was inside its own plane.
    expect(dot(plane.origin, plane.u)).toBeCloseTo(dot(bounds.center, plane.u), 6);
    expect(dot(plane.origin, plane.v)).toBeCloseTo(dot(bounds.center, plane.v), 6);
  });

  it("shifts the view when the user pans", () => {
    const cursor = patientBounds(volume).center;
    const still = standardPlane(volume, "axial", cursor);
    const panned = standardPlane(volume, "axial", cursor, [7, -3]);
    expect(dot(panned.origin, panned.u) - dot(still.origin, still.u)).toBeCloseTo(7, 6);
    expect(dot(panned.origin, panned.v) - dot(still.origin, still.v)).toBeCloseTo(-3, 6);
  });

  it("keeps the cut depth when the user pans", () => {
    const cursor = patientBounds(volume).center;
    const still = standardPlane(volume, "axial", cursor);
    const panned = standardPlane(volume, "axial", cursor, [7, -3]);
    expect(dot(panned.origin, panned.normal)).toBeCloseTo(dot(still.origin, still.normal), 6);
  });
});

describe("cursorInPlane", () => {
  it("puts a cursor at the middle of its own cut", () => {
    const cursor = patientBounds(volume).center;
    const where = cursorInPlane(standardPlane(volume, "axial", cursor), cursor);
    expect(where.x).toBeCloseTo(0, 6);
    expect(where.y).toBeCloseTo(0, 6);
  });

  it("measures the offset as a fraction of the view", () => {
    const bounds = patientBounds(volume);
    const plane = standardPlane(volume, "axial", bounds.center);
    const shifted: Vec3 = [
      bounds.center[0] + plane.u[0] * plane.size[0] * 0.25,
      bounds.center[1] + plane.u[1] * plane.size[0] * 0.25,
      bounds.center[2] + plane.u[2] * plane.size[0] * 0.25,
    ];
    expect(cursorInPlane(plane, shifted).x).toBeCloseTo(0.25, 6);
  });
});

describe("clipEquation", () => {
  const cursor = patientBounds(volume).center;
  const plane = standardPlane(volume, "axial", cursor);

  it("puts the plane origin exactly on the boundary", () => {
    const [a, b, c, d] = clipEquation(plane, false);
    expect(a * cursor[0] + b * cursor[1] + c * cursor[2] + d).toBeCloseTo(0, 6);
  });

  it("hides the side the normal points at", () => {
    const [a, b, c, d] = clipEquation(plane, false);
    const ahead = [
      cursor[0] + plane.normal[0],
      cursor[1] + plane.normal[1],
      cursor[2] + plane.normal[2],
    ] as const;
    expect(a * ahead[0] + b * ahead[1] + c * ahead[2] + d).toBeGreaterThan(0);
  });

  it("swaps the hidden side when flipped", () => {
    const forward = clipEquation(plane, false);
    const backward = clipEquation(plane, true);
    expect(backward[0]).toBeCloseTo(-forward[0], 6);
    expect(backward[3]).toBeCloseTo(-forward[3], 6);
  });
});

describe("clampToBounds", () => {
  it("leaves a point inside the box alone", () => {
    const bounds = patientBounds(volume);
    expect(clampToBounds(bounds, bounds.center)).toEqual(bounds.center);
  });

  it("pulls a far point back to the face of the box", () => {
    const bounds = patientBounds(volume);
    const clamped = clampToBounds(bounds, [1e6, -1e6, 0]);
    expect(clamped[0]).toBeCloseTo(bounds.max[0], 6);
    expect(clamped[1]).toBeCloseTo(bounds.min[1], 6);
  });
});

describe("autoWindow", () => {
  it("stays inside the data range", () => {
    const { center, width } = autoWindow(volume, 1);
    expect(center - width / 2).toBeGreaterThanOrEqual(volume.valueRange.min - 1);
    expect(center + width / 2).toBeLessThanOrEqual(volume.valueRange.max + 1);
  });

  it("drops the brightest half percent", () => {
    // A few very bright voxels must not darken everything else.
    expect(autoWindow(volume, 1).center + autoWindow(volume, 1).width / 2).toBeLessThan(
      volume.valueRange.max,
    );
  });

  it("gives a usable window for a flat volume", () => {
    const flat = { ...volume, valueRange: { min: 5, max: 5 } };
    expect(autoWindow(flat).width).toBeGreaterThan(0);
  });
});

describe("defaultWindow", () => {
  it("keeps a suggestion that covers the data", () => {
    const measured = autoWindow(volume);
    const generous = { ...volume, windowCenter: 100, windowWidth: measured.width };
    expect(defaultWindow(generous).width).toBe(measured.width);
    expect(defaultWindow(generous).center).toBe(100);
  });

  it("replaces a suggestion that clips most of the data", () => {
    // The scanner computes its window from one slice, often a slice of noise.
    const clipping = { ...volume, windowCenter: 39, windowWidth: 3 };
    expect(defaultWindow(clipping).width).toBeGreaterThan(3);
  });

  it("measures a window when the file suggests none", () => {
    const bare = { ...volume, windowCenter: undefined, windowWidth: undefined };
    expect(defaultWindow(bare)).toEqual(autoWindow(bare));
  });
});
