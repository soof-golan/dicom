import { describe, expect, it } from "vite-plus/test";
import { readSeries } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { dot } from "../geometry/vec3.ts";
import { PLANE_IDS, standardPlane } from "../view/planes.ts";
import { buildVolume } from "../volume/build.ts";
import { framePixelToPatient, sliceFrame } from "./project.ts";
import {
  cutAtDepth,
  depthOf,
  groupByCut,
  onCut,
  planeNormal,
  promptOpacity,
  PROMPT_FADE_MM,
  sameCut,
  sliceKey,
  sliceThickness,
} from "./slice.ts";

const volume = buildVolume(
  readSeries("pd_tse_fs_cor_DRB").map((bytes) => readInstance(parseDicom(bytes))),
);

describe("planeNormal", () => {
  it("returns a unit vector for every standard cut", () => {
    for (const id of PLANE_IDS) {
      const normal = planeNormal(volume, id);
      expect(Math.hypot(...normal)).toBeCloseTo(1, 10);
    }
  });

  it("agrees with the normal that the viewer draws with", () => {
    for (const id of PLANE_IDS) {
      const plane = standardPlane(volume, id, [0, 0, 0]);
      expect(planeNormal(volume, id)).toEqual(plane.normal);
    }
  });
});

describe("cutAtDepth", () => {
  it("puts the cut at the depth it was asked for", () => {
    for (const id of PLANE_IDS) {
      for (const depth of [-40, 0, 17.5]) {
        const cut = cutAtDepth(volume, id, depth);
        expect(depthOf(volume, id, cut.origin)).toBeCloseTo(depth, 9);
      }
    }
  });

  it("ignores the pan, so a stored cut comes back the same after a drag", () => {
    const normal = planeNormal(volume, "axial");
    const panned = standardPlane(volume, "axial", [0, 0, 0], [25, -12]);
    const rebuilt = cutAtDepth(volume, "axial", dot(panned.origin, normal));
    expect(rebuilt.origin).not.toEqual(panned.origin);
    expect(depthOf(volume, "axial", rebuilt.origin)).toBeCloseTo(0, 9);
  });
});

describe("depthOf", () => {
  it("gives one depth for every point on one cut", () => {
    const cut = cutAtDepth(volume, "sagittal", 12);
    const frame = sliceFrame(volume, cut, 64);
    for (const [x, y] of [
      [0, 0],
      [31, 17],
      [frame.width - 1, frame.height - 1],
    ]) {
      const patient = framePixelToPatient(frame, x!, y!);
      expect(depthOf(volume, "sagittal", patient)).toBeCloseTo(12, 9);
    }
  });
});

describe("sliceThickness", () => {
  it("is positive on every cut of a real series", () => {
    for (const id of PLANE_IDS) {
      expect(sliceThickness(volume, id)).toBeGreaterThan(0);
    }
  });
});

describe("sameCut", () => {
  const thickness = sliceThickness(volume, "axial");

  it("joins two clicks inside one voxel slab", () => {
    expect(sameCut(10, 10 + thickness / 4, thickness)).toBe(true);
  });

  it("keeps two clicks on different slabs apart", () => {
    expect(sameCut(10, 10 + thickness * 2, thickness)).toBe(false);
  });
});

describe("sliceKey", () => {
  it("separates the same depth on different cuts and different series", () => {
    const base = { seriesUid: "1.2.3", plane: "axial", depth: 4 } as const;
    expect(sliceKey(base)).toBe(sliceKey({ ...base, depth: 4.0000001 }));
    expect(sliceKey(base)).not.toBe(sliceKey({ ...base, plane: "coronal" }));
    expect(sliceKey(base)).not.toBe(sliceKey({ ...base, seriesUid: "9.9.9" }));
    expect(sliceKey(base)).not.toBe(sliceKey({ ...base, depth: 5 }));
  });
});

describe("groupByCut", () => {
  const thickness = sliceThickness(volume, "axial");
  const at = (plane: "axial" | "coronal", depth: number) => ({ plane, depth });

  it("puts clicks from one slab in one group", () => {
    const groups = groupByCut(
      [at("axial", 0), at("axial", thickness / 3), at("axial", -thickness / 3)],
      thickness,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(3);
  });

  it("splits clicks from different cuts", () => {
    const groups = groupByCut([at("axial", 0), at("coronal", 0)], thickness);
    expect(groups).toHaveLength(2);
  });

  it("splits clicks from far apart slabs on one cut", () => {
    const groups = groupByCut([at("axial", 0), at("axial", 30)], thickness);
    expect(groups).toHaveLength(2);
  });

  it("keeps the depth of the first member, so a group never drifts", () => {
    const groups = groupByCut([at("axial", 5), at("axial", 5 + thickness / 3)], thickness);
    expect(groups[0]!.depth).toBe(5);
  });
});

describe("onCut", () => {
  const thickness = sliceThickness(volume, "coronal");

  it("accepts a cut that runs through the slab", () => {
    expect(onCut(20, 20 + thickness / 4, thickness)).toBe(true);
  });

  it("refuses a cut that misses the slab", () => {
    expect(onCut(20, 26 + thickness, thickness)).toBe(false);
  });
});

describe("promptOpacity", () => {
  it("draws a mark on its own cut at full strength", () => {
    expect(promptOpacity(0, 3)).toBe(1);
    expect(promptOpacity(1.4, 3)).toBe(1);
  });

  it("fades a mark as the cut moves away from it", () => {
    const near = promptOpacity(4, 3);
    const far = promptOpacity(12, 3);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it("drops a mark that is further away than the fade range", () => {
    expect(promptOpacity(PROMPT_FADE_MM + 5, 3)).toBe(0);
  });

  it("never returns a value outside 0 to 1", () => {
    for (const offset of [-100, -3, 0, 0.5, 9, 400]) {
      const value = promptOpacity(offset, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("treats a mark in front the same as a mark behind", () => {
    expect(promptOpacity(-7, 3)).toBe(promptOpacity(7, 3));
  });
});
