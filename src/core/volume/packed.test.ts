import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { SERIES_NAMES, readSeries, type SeriesName } from "../dicom/fixtures.ts";
import { parseDicom } from "../dicom/parse.ts";
import { readInstance } from "../dicom/instance.ts";
import { buildVolume } from "./build.ts";
import {
  PACKED_FORMAT,
  parseManifest,
  parseSidecar,
  volumeFromPacked,
  type PackedSidecar,
} from "./packed.ts";

/**
 * The fixtures under `tests/fixtures/packed/` come from the same DICOM files as
 * the fixtures under `tests/fixtures/series/`. `scripts/pack_volume.py` wrote
 * them. Every test below compares one path against the other, so nothing here
 * needs a mock: if the packer and the reader disagree, the numbers differ.
 */
const PACKED_ROOT = new URL("../../../tests/fixtures/packed/", import.meta.url).pathname;

const manifest = parseManifest(
  JSON.parse(readFileSync(join(PACKED_ROOT, "manifest.json"), "utf8")),
);

function readVoxels(sidecar: PackedSidecar): ArrayBuffer {
  const bytes = readFileSync(join(PACKED_ROOT, sidecar.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fromDicom(name: SeriesName) {
  return buildVolume(readSeries(name).map((bytes) => readInstance(parseDicom(bytes))));
}

function entryFor(name: SeriesName) {
  const entry = manifest.series.find((series) => series.name === name);
  if (!entry) throw new Error(`no packed series named ${name}`);
  return entry;
}

describe("parseManifest", () => {
  it("reads every series of the study", () => {
    expect(manifest.series.map((series) => series.name).sort()).toEqual([...SERIES_NAMES].sort());
  });

  it("orders series by series number", () => {
    const numbers = manifest.series.map((series) => series.seriesNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("rejects a format it does not know", () => {
    expect(() => parseManifest({ format: "something/else@9", series: [] })).toThrow(/format/i);
  });

  it("rejects a manifest with no series array", () => {
    expect(() => parseManifest({ format: PACKED_FORMAT })).toThrow(/series/i);
  });
});

describe("parseSidecar", () => {
  it("rejects a sidecar whose dims are not three numbers", () => {
    const broken = { ...JSON.parse(JSON.stringify(entryFor("t1_tse_cor_DRB").full)), dims: [64, 64] };
    expect(() => parseSidecar(broken)).toThrow(/dims/i);
  });

  it("rejects an affine that is not 16 numbers", () => {
    const source = JSON.parse(JSON.stringify(entryFor("t1_tse_cor_DRB").full));
    expect(() => parseSidecar({ ...source, voxelToPatient: [1, 0, 0, 1] })).toThrow(
      /voxelToPatient/i,
    );
  });
});

describe("volumeFromPacked", () => {
  it("rejects a block of the wrong length", () => {
    const { full } = entryFor("pd_tse_fs_cor_DRB");
    expect(() => volumeFromPacked(full, new ArrayBuffer(full.bytes - 2))).toThrow(/bytes/i);
  });

  it("reads the byte count that the sidecar declares", () => {
    for (const series of manifest.series) {
      expect(readVoxels(series.full).byteLength).toBe(series.full.bytes);
      expect(readVoxels(series.preview).byteLength).toBe(series.preview.bytes);
    }
  });
});

describe.each(SERIES_NAMES)("the packed %s reproduces the DICOM volume", (name) => {
  const expected = fromDicom(name);
  const { full } = entryFor(name);
  const actual = volumeFromPacked(full, readVoxels(full));

  it("has the same grid size", () => {
    expect(actual.dims).toEqual(expected.dims);
  });

  it("has the same spacing", () => {
    for (let axis = 0; axis < 3; axis += 1) {
      expect(actual.spacing[axis]!).toBeCloseTo(expected.spacing[axis]!, 6);
    }
  });

  it("has the same origin and axes", () => {
    for (let axis = 0; axis < 3; axis += 1) {
      expect(actual.origin[axis]!).toBeCloseTo(expected.origin[axis]!, 6);
      for (let part = 0; part < 3; part += 1) {
        expect(actual.axes[axis]![part]!).toBeCloseTo(expected.axes[axis]![part]!, 9);
      }
    }
  });

  it("has the same voxel-to-patient affine", () => {
    for (let cell = 0; cell < 16; cell += 1) {
      expect(actual.voxelToPatient[cell]!).toBeCloseTo(expected.voxelToPatient[cell]!, 6);
    }
  });

  it("holds the same voxel values", () => {
    expect(actual.data).toHaveLength(expected.data.length);
    expect(Array.from(actual.data)).toEqual(Array.from(expected.data));
  });

  it("reports the same value range, rescale and window", () => {
    expect(actual.valueRange).toEqual(expected.valueRange);
    expect(actual.rescaleSlope).toBe(expected.rescaleSlope);
    expect(actual.rescaleIntercept).toBe(expected.rescaleIntercept);
    expect(actual.windowCenter).toBe(expected.windowCenter);
    expect(actual.windowWidth).toBe(expected.windowWidth);
  });

  it("carries the same series identity", () => {
    expect(actual.description).toBe(expected.description);
    expect(actual.modality).toBe(expected.modality);
    expect(actual.seriesInstanceUid).toBe(expected.seriesInstanceUid);
    expect(actual.signed).toBe(expected.signed);
    expect(actual.warnings).toEqual(expected.warnings);
  });
});

describe("the preview", () => {
  const { full, preview } = entryFor("pd_tse_fs_cor_DRB");
  const large = volumeFromPacked(full, readVoxels(full));
  const small = volumeFromPacked(preview, readVoxels(preview));

  it("halves the grid in plane and keeps every slice", () => {
    expect(small.dims).toEqual([large.dims[0] / 2, large.dims[1] / 2, large.dims[2]]);
  });

  it("doubles the in-plane spacing and keeps the slice spacing", () => {
    expect(small.spacing[0]).toBeCloseTo(large.spacing[0] * 2, 9);
    expect(small.spacing[1]).toBeCloseTo(large.spacing[1] * 2, 9);
    expect(small.spacing[2]).toBeCloseTo(large.spacing[2], 9);
  });

  it("moves the origin to the center of the first block", () => {
    // The first preview sample is the mean of a 2x2 block, so it sits half a
    // full voxel along i and half along j. A preview that skipped this step
    // would draw the anatomy off by a quarter of a millimeter.
    for (let axis = 0; axis < 3; axis += 1) {
      const shift =
        0.5 * large.spacing[0] * large.axes[0]![axis]! +
        0.5 * large.spacing[1] * large.axes[1]![axis]!;
      expect(small.origin[axis]!).toBeCloseTo(large.origin[axis]! + shift, 6);
    }
  });

  it("averages every 2x2 block", () => {
    const [wide, tall] = large.dims;
    const [narrow, short, slices] = small.dims;
    const wrong: string[] = [];

    for (let k = 0; k < slices; k += 1) {
      for (let j = 0; j < short; j += 1) {
        for (let i = 0; i < narrow; i += 1) {
          const corner = k * wide * tall + j * 2 * wide + i * 2;
          const mean =
            (large.data[corner]! +
              large.data[corner + 1]! +
              large.data[corner + wide]! +
              large.data[corner + wide + 1]!) /
            4;
          const value = small.data[k * narrow * short + j * narrow + i]!;
          if (value !== Math.round(mean)) wrong.push(`(${i},${j},${k}) ${value} != ${mean}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });
});
