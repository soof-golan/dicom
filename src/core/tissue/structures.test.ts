import { describe, expect, it } from "vite-plus/test";
import { readSeries, type SeriesName } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { buildVolume } from "../volume/build.ts";
import {
  DEFAULT_STRUCTURE_RULES,
  findStructures,
  MIN_STRUCTURE_CONFIDENCE,
  nameComponent,
  splitEnds,
  STRUCTURE_INFO,
  STRUCTURE_ORDER,
  StructureError,
  VOXEL_FADE,
  type ComponentEvidence,
  type StructureClass,
} from "./structures.ts";

const volumeOf = (name: SeriesName) =>
  buildVolume(readSeries(name).map((bytes) => readInstance(parseDicom(bytes))));

const t1 = volumeOf("t1_tse_cor_DRB");
const fatsat = volumeOf("pd_tse_fs_cor_DRB");

const NO_CONTACT = { marrow: 0, muscle: 0 } as const;
const BONE = { marrow: 0.3, muscle: 0 } as const;
const MUSCLE = { marrow: 0, muscle: 0.4 } as const;

/** Evidence for a clear tube. Each test changes only what it tests. */
const evidence = (patch: Partial<ComponentEvidence> = {}): ComponentEvidence => ({
  kind: "tube",
  voxels: 400,
  shapeAgreement: 0.9,
  shapeConfidence: 0.8,
  marrowContact: 0.15,
  muscleContact: 0.2,
  fatContact: 0.3,
  ends: [MUSCLE, BONE],
  lengthMillimetres: 30,
  ...patch,
});

describe("nameComponent", () => {
  it("calls a plate that wraps marrow cortex", () => {
    const named = nameComponent(evidence({ kind: "sheet", marrowContact: 0.3 }));
    expect(named.structure).toBe("cortex");
  });

  it("calls a tube with muscle at one end and bone at the other a tendon", () => {
    expect(nameComponent(evidence({ ends: [MUSCLE, BONE] })).structure).toBe("tendon");
  });

  it("calls it a tendon whichever end the muscle is on", () => {
    expect(nameComponent(evidence({ ends: [BONE, MUSCLE] })).structure).toBe("tendon");
  });

  it("calls a tube with bone at both ends and no muscle a ligament", () => {
    expect(nameComponent(evidence({ ends: [BONE, BONE] })).structure).toBe("ligament");
  });

  it("calls a long tube through soft tissue that reaches no bone a vessel", () => {
    // Blood that flows returns no signal on turbo spin echo, so an artery is a
    // dark tube. Nothing but its ends separates it from a tendon.
    const named = nameComponent(
      evidence({
        ends: [NO_CONTACT, NO_CONTACT],
        marrowContact: 0,
        fatContact: 0.6,
        lengthMillimetres: 40,
      }),
    );
    expect(named.structure).toBe("vessel");
  });

  it("does not call a vessel a tendon", () => {
    // This is the trap the class exists for. Without it every artery in the
    // field would read as a tendon.
    const artery = evidence({
      ends: [NO_CONTACT, NO_CONTACT],
      marrowContact: 0,
      muscleContact: 0.35,
      fatContact: 0.35,
      lengthMillimetres: 40,
    });
    expect(nameComponent(artery).structure).not.toBe("tendon");
    expect(nameComponent(artery).structure).toBe("vessel");
  });

  it("leaves a short dark tube in fat dark", () => {
    const stub = evidence({
      ends: [NO_CONTACT, NO_CONTACT],
      marrowContact: 0,
      lengthMillimetres: 4,
    });
    expect(nameComponent(stub).structure).toBe("dark");
  });

  it("leaves a plate that touches no marrow dark", () => {
    expect(nameComponent(evidence({ kind: "sheet", marrowContact: 0 })).structure).toBe("dark");
  });

  it("leaves a tube with muscle at both ends dark", () => {
    expect(nameComponent(evidence({ ends: [MUSCLE, MUSCLE] })).structure).toBe("dark");
  });

  it("leaves a blob dark", () => {
    expect(nameComponent(evidence({ kind: "blob" })).structure).toBe("dark");
  });

  it("leaves a shape it could not read dark", () => {
    expect(nameComponent(evidence({ kind: "none" })).structure).toBe("dark");
  });

  it("leaves a component too small to trust dark", () => {
    expect(nameComponent(evidence({ voxels: 3 })).structure).toBe("dark");
  });

  it("leaves a component the dark tissue beside it disagrees with dark", () => {
    expect(nameComponent(evidence({ shapeAgreement: 0.4 })).structure).toBe("dark");
  });

  it("gives a dark answer no confidence", () => {
    expect(nameComponent(evidence({ kind: "blob" })).confidence).toBe(0);
  });

  it("never reports a confidence above 1", () => {
    const named = nameComponent(evidence({ shapeAgreement: 1, shapeConfidence: 1 }));
    expect(named.confidence).toBeLessThanOrEqual(1);
    expect(named.confidence).toBeGreaterThan(0);
  });

  it("is less sure when the shape is less clear", () => {
    const sure = nameComponent(evidence({ shapeConfidence: 0.95 }));
    const unsure = nameComponent(evidence({ shapeConfidence: 0.35 }));
    expect(unsure.confidence).toBeLessThan(sure.confidence);
  });

  it("falls back to dark below the confidence it will report", () => {
    const weak = nameComponent(evidence({ shapeConfidence: 0.01, shapeAgreement: 0.56 }));
    expect(weak.confidence).toBeLessThan(MIN_STRUCTURE_CONFIDENCE);
    expect(weak.structure).toBe("dark");
  });

  it("gives a reason a reader can check", () => {
    expect(nameComponent(evidence()).reason).toMatch(/muscle/);
    expect(nameComponent(evidence({ kind: "blob" })).reason).toMatch(/blob/i);
  });

  it("separates a tendon, a ligament, and a vessel by their ends alone", () => {
    // The shape is the same tube in all three. Only the attachment differs.
    const same = { kind: "tube", lengthMillimetres: 40 } as const;
    expect(nameComponent(evidence({ ...same, ends: [MUSCLE, BONE] })).structure).toBe("tendon");
    expect(nameComponent(evidence({ ...same, ends: [BONE, BONE] })).structure).toBe("ligament");
    expect(
      nameComponent(
        evidence({ ...same, ends: [NO_CONTACT, NO_CONTACT], marrowContact: 0, fatContact: 0.6 }),
      ).structure,
    ).toBe("vessel");
  });
});

describe("splitEnds", () => {
  it("measures a length in millimetres, not in voxel steps", () => {
    // Ten steps along the slice axis is 33 mm, not 10.
    const bucket = new Uint8Array(1000);
    const along = [...Array(10).keys()].map((k) => k * 100);
    const { length } = splitEnds(along, [10, 10, 10], [0.27, 0.27, 3.3], bucket);
    expect(length).toBeCloseTo(9 * 3.3, 3);
  });

  it("marks one end, a middle, and the other end", () => {
    const bucket = new Uint8Array(1000);
    splitEnds(
      [...Array(10).keys()].map((i) => i),
      [10, 10, 10],
      [1, 1, 1],
      bucket,
    );
    // Which end is 0 and which is 2 does not matter. The rules read both.
    expect(new Set([bucket[0], bucket[9]])).toEqual(new Set([0, 2]));
    expect(bucket[5]).toBe(1);
  });

  it("finds the long axis whichever way the component runs", () => {
    const bucket = new Uint8Array(1000);
    const acrossRows = [...Array(8).keys()].map((j) => j * 10);
    const { length, axis } = splitEnds(acrossRows, [10, 10, 10], [1, 1, 1], bucket);
    expect(length).toBeCloseTo(7, 3);
    // The component runs along j, so the axis must point that way.
    expect(Math.abs(axis[1])).toBeCloseTo(1, 6);
  });
});

describe("the structure table", () => {
  it("describes every class", () => {
    for (const id of Object.keys(STRUCTURE_INFO) as StructureClass[]) {
      expect(STRUCTURE_INFO[id].name.length).toBeGreaterThan(0);
      expect(STRUCTURE_INFO[id].covers.length).toBeGreaterThan(0);
    }
  });

  it("gives each class its own color", () => {
    const seen = STRUCTURE_ORDER.map((id) => STRUCTURE_INFO[id].color.join(","));
    expect(new Set(seen).size).toBe(STRUCTURE_ORDER.length);
  });

  it("says that each named class comes from shape and position, not signal", () => {
    for (const id of ["cortex", "tendon", "ligament", "vessel"] as const) {
      expect(STRUCTURE_INFO[id].covers).toMatch(
        /shape and position|no signal|cannot be separated/i,
      );
    }
  });

  it("says that an artery and a vein cannot be separated", () => {
    expect(STRUCTURE_INFO.vessel.covers).toMatch(/artery and vein cannot be separated/i);
  });

  it("puts dark first, so its index is zero", () => {
    expect(STRUCTURE_ORDER[0]).toBe("dark");
  });
});

describe("findStructures on a real elbow crop", () => {
  const result = findStructures({ t1, fatsat });

  it("labels the grid of the T1 series", () => {
    // T1 carries the shape, because bright fat surrounds a black tendon there.
    expect(result.dims).toEqual(t1.dims);
    expect(result.labels.length).toBe(t1.dims[0] * t1.dims[1] * t1.dims[2]);
  });

  it("finds dark voxels to work on", () => {
    expect(result.darkVoxels).toBeGreaterThan(0);
  });

  it("names fewer voxels than it examined", () => {
    // Partial cover is the honest result. Full cover would mean guessing.
    expect(result.namedVoxels).toBeLessThan(result.darkVoxels);
  });

  it("warns that the voxels are far too long between slices", () => {
    expect(result.warnings.join(" ")).toMatch(/between slices/i);
  });

  it("gives every named voxel a confidence near the floor or above", () => {
    // A component must clear the floor before any of its voxels are named. A
    // voxel whose own shape was faint keeps a fraction of that score.
    for (let index = 0; index < result.labels.length; index += 1) {
      if (result.labels[index] === 0) continue;
      expect(result.confidence[index]! / 255).toBeGreaterThanOrEqual(
        MIN_STRUCTURE_CONFIDENCE * VOXEL_FADE - 1 / 255,
      );
    }
  });

  it("leaves every unnamed voxel with no confidence", () => {
    for (let index = 0; index < result.labels.length; index += 1) {
      if (result.labels[index] === 0) expect(result.confidence[index]).toBe(0);
    }
  });

  it("answers the same way twice", () => {
    const again = findStructures({ t1, fatsat });
    expect([...again.labels]).toEqual([...result.labels]);
  });

  it("names nothing when no component may reach marrow or muscle", () => {
    const strict = findStructures(
      { t1, fatsat },
      {
        rules: {
          ...DEFAULT_STRUCTURE_RULES,
          cortexMarrow: 2,
          endBone: 2,
          endMuscle: 2,
          vesselSoftTissue: 2,
        },
      },
    );
    expect(strict.namedVoxels).toBe(0);
  });

  it("reports each component it examined", () => {
    expect(result.components.length).toBeGreaterThan(0);
    for (const component of result.components) {
      expect(component.voxels).toBeGreaterThan(0);
      expect(component.reason.length).toBeGreaterThan(0);
    }
  });

  it("refuses series from different frames of reference", () => {
    const stranger = { ...fatsat, frameOfReferenceUid: "1.2.3.4" };
    expect(() => findStructures({ t1, fatsat: stranger })).toThrow(StructureError);
  });
});
