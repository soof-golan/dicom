import { describe, expect, it } from "vite-plus/test";
import { readAllSeries, readFixture, readSeries, SERIES_NAMES } from "../dicom/fixtures.ts";
import { parseDicom } from "../dicom/parse.ts";
import { readInstance } from "../dicom/instance.ts";
import { applyAffine, distance, dot, invertAffine, subtract } from "../geometry/vec3.ts";
import { groupIntoSeries } from "./series.ts";
import { buildVolume, sampleNearest, voxelToPatient } from "./build.ts";

const coronalInstances = readSeries("pd_tse_fs_cor_DRB").map((bytes) =>
  readInstance(parseDicom(bytes)),
);

describe("groupIntoSeries", () => {
  const all = readAllSeries().map((bytes) => readInstance(parseDicom(bytes)));

  it("finds every series in the study", () => {
    expect(groupIntoSeries(all)).toHaveLength(SERIES_NAMES.length);
  });

  it("keeps each series whole", () => {
    for (const series of groupIntoSeries(all)) {
      expect(series.instances).toHaveLength(3);
    }
  });

  it("names each series from its description", () => {
    const names = groupIntoSeries(all).map((series) => series.description);
    expect(new Set(names)).toEqual(new Set(SERIES_NAMES));
  });

  it("orders series by series number", () => {
    const numbers = groupIntoSeries(all).map((series) => series.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("puts instances of one series under one series instance UID", () => {
    for (const series of groupIntoSeries(all)) {
      const uids = new Set(series.instances.map((i) => i.seriesInstanceUid));
      expect(uids.size).toBe(1);
    }
  });
});

describe("buildVolume", () => {
  it("stacks the slices into a 3D grid", () => {
    const volume = buildVolume(coronalInstances);
    expect(volume.dims).toEqual([64, 64, 3]);
    expect(volume.data).toHaveLength(64 * 64 * 3);
  });

  it("takes in-plane spacing from PixelSpacing and slice spacing from the geometry", () => {
    const volume = buildVolume(coronalInstances);
    // PixelSpacing is [between rows, between columns].
    expect(volume.spacing[0]).toBeCloseTo(0.2734, 6);
    expect(volume.spacing[1]).toBeCloseTo(0.2734, 6);
    expect(volume.spacing[2]).toBeCloseTo(3.3, 3);
  });

  it("uses orthonormal axes", () => {
    const { axes } = buildVolume(coronalInstances);
    expect(dot(axes[0], axes[1])).toBeCloseTo(0, 6);
    expect(dot(axes[1], axes[2])).toBeCloseTo(0, 6);
    expect(dot(axes[0], axes[2])).toBeCloseTo(0, 6);
  });

  it("puts the origin at the first slice", () => {
    const volume = buildVolume(coronalInstances);
    const sorted = [...coronalInstances].sort(
      (a, b) => dot(a.position, a.normal) - dot(b.position, b.normal),
    );
    expect(distance(volume.origin, sorted[0]!.position)).toBeCloseTo(0, 4);
  });

  it("gives the same volume whatever order the slices arrive in", () => {
    const forward = buildVolume(coronalInstances);
    const backward = buildVolume([...coronalInstances].reverse());
    expect(backward.origin).toEqual(forward.origin);
    expect(Array.from(backward.data)).toEqual(Array.from(forward.data));
  });

  it("rejects an empty series", () => {
    expect(() => buildVolume([])).toThrow(/no slices/i);
  });

  it("rejects slices whose sizes disagree", () => {
    const small = readInstance(parseDicom(readFixture("variants/small-32.dcm")));
    expect(() => buildVolume([coronalInstances[0]!, small])).toThrow(/size/i);
  });

  it("keeps row spacing and column spacing on the right axes", () => {
    // PixelSpacing is [between rows, between columns] = [0.5, 0.25] here.
    // The i axis runs across a row, so it steps by the column spacing.
    const volume = buildVolume([readInstance(parseDicom(readFixture("variants/anisotropic.dcm")))]);
    expect(volume.spacing[0]).toBeCloseTo(0.25, 6);
    expect(volume.spacing[1]).toBeCloseTo(0.5, 6);
  });

  it("builds a single-slice volume without a slice spacing", () => {
    const volume = buildVolume([coronalInstances[0]!]);
    expect(volume.dims[2]).toBe(1);
    expect(volume.spacing[2]).toBeGreaterThan(0);
  });
});

describe("voxel and patient coordinates", () => {
  it("maps voxel (0,0,0) to the origin", () => {
    const volume = buildVolume(coronalInstances);
    expect(distance(voxelToPatient(volume, [0, 0, 0]), volume.origin)).toBeCloseTo(0, 6);
  });

  it("steps one column by the column spacing", () => {
    const volume = buildVolume(coronalInstances);
    const a = voxelToPatient(volume, [0, 0, 0]);
    const b = voxelToPatient(volume, [1, 0, 0]);
    expect(distance(a, b)).toBeCloseTo(volume.spacing[0], 6);
  });

  it("steps one slice by the slice spacing", () => {
    const volume = buildVolume(coronalInstances);
    const a = voxelToPatient(volume, [0, 0, 0]);
    const b = voxelToPatient(volume, [0, 0, 1]);
    expect(distance(a, b)).toBeCloseTo(volume.spacing[2], 4);
  });

  it("round-trips through the inverse matrix", () => {
    const volume = buildVolume(coronalInstances);
    const inverse = invertAffine(volume.voxelToPatient);
    for (const voxel of [
      [0, 0, 0],
      [63, 63, 2],
      [17, 42, 1],
    ] as const) {
      const patient = applyAffine(volume.voxelToPatient, voxel);
      const back = applyAffine(inverse, patient);
      expect(
        subtract(back, voxel)
          .map(Math.abs)
          .every((d) => d < 1e-6),
      ).toBe(true);
    }
  });

  it("puts every slice on the plane the DICOM header claims", () => {
    const volume = buildVolume(coronalInstances);
    const sorted = [...coronalInstances].sort(
      (a, b) => dot(a.position, a.normal) - dot(b.position, b.normal),
    );
    sorted.forEach((instance, index) => {
      const corner = voxelToPatient(volume, [0, 0, index]);
      expect(distance(corner, instance.position)).toBeLessThan(1e-3);
    });
  });
});

describe("sampleNearest", () => {
  it("reads the same value the slice holds", () => {
    const volume = buildVolume(coronalInstances);
    const index = 10 * 64 + 20;
    expect(sampleNearest(volume, [20, 10, 0])).toBe(volume.data[index]);
  });

  it("returns undefined outside the grid", () => {
    const volume = buildVolume(coronalInstances);
    expect(sampleNearest(volume, [-1, 0, 0])).toBeUndefined();
    expect(sampleNearest(volume, [64, 0, 0])).toBeUndefined();
    expect(sampleNearest(volume, [0, 0, 3])).toBeUndefined();
  });
});

describe("volume statistics", () => {
  it("reports the stored value range across every slice", () => {
    const volume = buildVolume(coronalInstances);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of volume.data) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    expect(volume.valueRange).toEqual({ min, max });
  });
});
