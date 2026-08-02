import { describe, expect, it } from "vite-plus/test";
import { readSeries } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { describeDirection, describePlane, edgeLabels, nearestAxis } from "./anatomy.ts";

describe("nearestAxis", () => {
  it.each([
    [[1, 0, 0], "L"],
    [[-1, 0, 0], "R"],
    [[0, 1, 0], "P"],
    [[0, -1, 0], "A"],
    [[0, 0, 1], "S"],
    [[0, 0, -1], "I"],
  ] as const)("maps %j to %s", (direction, code) => {
    expect(nearestAxis(direction).code).toBe(code);
  });

  it("snaps a nearly-axial direction to that axis", () => {
    expect(nearestAxis([0.05, 0.02, 0.99]).code).toBe("S");
  });
});

describe("describeDirection", () => {
  it("gives one letter for a clean axis", () => {
    expect(describeDirection([0, 0, 1])).toBe("S");
  });

  it("gives two letters for an edge", () => {
    expect(describeDirection([1, 0, 1])).toMatch(/^(LS|SL)$/);
  });

  it("gives three letters for a corner", () => {
    expect(describeDirection([1, 1, 1])).toHaveLength(3);
    expect(describeDirection([1, 1, 1]).split("").sort().join("")).toBe("LPS");
  });

  it("puts the strongest component first", () => {
    expect(describeDirection([0.2, 0, 0.98])[0]).toBe("S");
  });

  it("drops a component that is far weaker", () => {
    expect(describeDirection([0.99, 0, 0.05])).toBe("L");
  });
});

describe("describePlane", () => {
  it.each([
    [[0, 0, 1], "axial"],
    [[0, 1, 0], "coronal"],
    [[1, 0, 0], "sagittal"],
    [[0.6, 0.6, 0.5], "oblique"],
  ] as const)("names the plane with normal %j", (normal, expected) => {
    expect(describePlane(normal)).toBe(expected);
  });
});

describe("the elbow study", () => {
  const instanceOf = (series: Parameters<typeof readSeries>[0]) =>
    readInstance(parseDicom(readSeries(series)[0]!));

  it("reads the transverse series as axial", () => {
    // The slice normal is exactly +Z. The 32-degree rotation that lines the
    // image up with the forearm happens inside the plane, so the plane stays
    // axial.
    expect(describePlane(instanceOf("pd_tse_fs_tra_DRB").normal)).toBe("axial");
  });

  it("reads the coronal and sagittal series as oblique", () => {
    // These two are angled to the elbow joint, not to the body. A viewer that
    // called them plain coronal and sagittal would mislabel every edge.
    expect(describePlane(instanceOf("pd_tse_fs_cor_DRB").normal)).toBe("oblique");
    expect(describePlane(instanceOf("pd_tse_fs_sag_DRB").normal)).toBe("oblique");
  });

  it("labels the edges of the coronal series", () => {
    const instance = instanceOf("pd_tse_fs_cor_DRB");
    const labels = edgeLabels(instance.rowDirection, instance.columnDirection);
    expect(new Set(Object.values(labels)).size).toBe(4);
    for (const label of Object.values(labels)) {
      expect(label).toMatch(/^[RLAPSI]+$/);
    }
  });

  it("puts opposite labels on opposite edges", () => {
    const instance = instanceOf("pd_tse_fs_cor_DRB");
    const { top, bottom, left, right } = edgeLabels(
      instance.rowDirection,
      instance.columnDirection,
    );
    const opposites: Record<string, string> = {
      L: "R",
      R: "L",
      A: "P",
      P: "A",
      S: "I",
      I: "S",
    };
    expect(opposites[top[0]!]).toBe(bottom[0]);
    expect(opposites[left[0]!]).toBe(right[0]);
  });
});
