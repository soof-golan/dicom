import { describe, expect, it } from "vite-plus/test";
import {
  decodeRle,
  dilate,
  emptyMask,
  encodeRle,
  erode,
  maskArea,
  maskBounds,
  maskCentroid,
  subtractMask,
  thresholdHeatmap,
  unionMask,
} from "./mask.ts";
import type { Mask } from "./types.ts";

/** Build a mask from rows of "." and "#", which reads like the picture it is. */
function maskFrom(rows: readonly string[]): Mask {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = row[x] === "#" ? 1 : 0;
    }
  });
  return { width, height, data };
}

function rowsOf(mask: Mask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.height; y += 1) {
    let row = "";
    for (let x = 0; x < mask.width; x += 1) row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
    rows.push(row);
  }
  return rows;
}

describe("run length encoding", () => {
  it("starts with the count of clear pixels", () => {
    const mask = maskFrom(["..##", "#..."]);
    expect([...encodeRle(mask).runs]).toEqual([2, 3, 3]);
  });

  it("starts with an empty run when the first pixel is set", () => {
    const mask = maskFrom(["##.."]);
    expect([...encodeRle(mask).runs]).toEqual([0, 2, 2]);
  });

  it("encodes an empty mask as one run", () => {
    expect([...encodeRle(emptyMask(3, 2)).runs]).toEqual([6]);
  });

  it("encodes a full mask as two runs", () => {
    expect([...encodeRle(maskFrom(["##", "##"])).runs]).toEqual([0, 4]);
  });

  it("round trips every pattern of a 4x3 mask", () => {
    for (let bits = 0; bits < 4096; bits += 1) {
      const mask = emptyMask(4, 3);
      for (let i = 0; i < 12; i += 1) mask.data[i] = (bits >> i) & 1;
      expect([...decodeRle(encodeRle(mask)).data]).toEqual([...mask.data]);
    }
  });

  it("shrinks a large plain mask to a few runs", () => {
    const mask = emptyMask(256, 256);
    mask.data.fill(1, 100 * 256, 140 * 256);
    expect(encodeRle(mask).runs.length).toBe(3);
    expect(mask.data.length).toBe(65_536);
  });
});

describe("thresholdHeatmap", () => {
  it("keeps the pixels at or above a share of the peak", () => {
    const values = Float32Array.from([0, 0.2, 0.5, 1]);
    expect([...thresholdHeatmap(values, 4, 1, 0.5).data]).toEqual([0, 0, 1, 1]);
  });

  it("measures the share against the peak, not against one", () => {
    // A weak answer keeps its shape. This is the case that a fixed cut-off
    // gets wrong: a phrase that peaks at 0.34 would return nothing.
    const strong = Float32Array.from([0.1, 0.5, 0.9]);
    const weak = Float32Array.from([0.034, 0.17, 0.306]);
    expect([...thresholdHeatmap(weak, 3, 1, 0.5).data]).toEqual([
      ...thresholdHeatmap(strong, 3, 1, 0.5).data,
    ]);
  });

  it("keeps only the peak at a share of one", () => {
    expect([...thresholdHeatmap(Float32Array.from([0.4, 0.9, 0.6]), 3, 1, 1).data]).toEqual([
      0, 1, 0,
    ]);
  });

  it("keeps every pixel above zero at a share of zero", () => {
    expect([...thresholdHeatmap(Float32Array.from([0, 0.1, 0.9]), 3, 1, 0).data]).toEqual([
      1, 1, 1,
    ]);
  });

  it("returns an empty mask when nothing scores above zero", () => {
    expect([...thresholdHeatmap(Float32Array.from([0, 0, 0]), 3, 1, 0.5).data]).toEqual([0, 0, 0]);
  });

  it("gives a box that a box prompt can use", () => {
    const values = new Float32Array(16);
    values[5] = 0.8;
    values[6] = 0.9;
    values[9] = 0.7;
    expect(maskBounds(thresholdHeatmap(values, 4, 4, 0.6))).toEqual({
      x0: 1,
      y0: 1,
      x1: 3,
      y1: 3,
    });
  });
});

describe("measurements", () => {
  it("counts the set pixels", () => {
    expect(maskArea(maskFrom([".#.", "###"]))).toBe(4);
  });

  it("finds the box that holds the set pixels", () => {
    expect(maskBounds(maskFrom(["....", ".##.", ".#..", "...."]))).toEqual({
      x0: 1,
      y0: 1,
      x1: 3,
      y1: 3,
    });
  });

  it("reports no box for an empty mask", () => {
    expect(maskBounds(emptyMask(4, 4))).toBeUndefined();
  });

  it("finds the middle of the set pixels", () => {
    expect(maskCentroid(maskFrom(["##", "##"]))).toEqual({ x: 0.5, y: 0.5 });
  });

  it("puts the middle of one pixel on that pixel", () => {
    expect(maskCentroid(maskFrom(["...", ".#.", "..."]))).toEqual({ x: 1, y: 1 });
  });

  it("reports no middle for an empty mask", () => {
    expect(maskCentroid(emptyMask(2, 2))).toBeUndefined();
  });
});

describe("combining", () => {
  const a = maskFrom(["##.", "##."]);
  const b = maskFrom([".##", "..."]);

  it("takes every pixel of either mask", () => {
    expect(rowsOf(unionMask(a, b))).toEqual(["###", "##."]);
  });

  it("removes the pixels of the second mask", () => {
    expect(rowsOf(subtractMask(a, b))).toEqual(["#..", "##."]);
  });

  it("refuses masks of different sizes", () => {
    expect(() => unionMask(a, emptyMask(4, 4))).toThrow(RangeError);
    expect(() => subtractMask(a, emptyMask(4, 4))).toThrow(RangeError);
  });
});

describe("dilate and erode", () => {
  it("grows one pixel into nine", () => {
    const grown = dilate(maskFrom([".....", ".....", "..#..", ".....", "....."]));
    expect(rowsOf(grown)).toEqual([".....", ".###.", ".###.", ".###.", "....."]);
  });

  it("grows on the diagonal too", () => {
    expect(maskArea(dilate(maskFrom(["...", ".#.", "..."])))).toBe(9);
  });

  it("clears a single pixel", () => {
    expect(maskArea(erode(maskFrom([".....", "..#..", "......"])))).toBe(0);
  });

  it("keeps only the inside of a block", () => {
    const shrunk = erode(maskFrom(["#####", "#####", "#####", "#####", "#####"]));
    expect(rowsOf(shrunk)).toEqual([".....", ".###.", ".###.", ".###.", "....."]);
  });

  it("treats outside the mask as clear, so a full mask loses its border", () => {
    expect(rowsOf(erode(maskFrom(["###", "###", "###"])))).toEqual(["...", ".#.", "..."]);
  });

  it("returns the same shape after growing then shrinking a wide block", () => {
    const block = maskFrom([".....", ".###.", ".###.", ".###.", "....."]);
    expect(rowsOf(erode(dilate(block)))).toEqual(rowsOf(block));
  });
});
