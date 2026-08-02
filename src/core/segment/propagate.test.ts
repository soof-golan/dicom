import { describe, expect, it } from "vite-plus/test";
import { emptyMask, maskArea } from "./mask.ts";
import {
  DEFAULT_GROWTH,
  growthDepths,
  interiorPoint,
  judgeSlice,
  promptBox,
  stopMessage,
  type StopCause,
} from "./propagate.ts";
import type { Mask } from "./types.ts";

/** A filled rectangle, the shape a mask of one structure usually has. */
function block(width: number, height: number, x0: number, y0: number, w: number, h: number): Mask {
  const mask = emptyMask(width, height);
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) mask.data[y * width + x] = 1;
  }
  return mask;
}

/** A ring, whose middle of area is a hole. */
function ring(size: number): Mask {
  const mask = block(size, size, 2, 2, size - 4, size - 4);
  const hole = 4;
  const start = Math.round(size / 2 - hole / 2);
  for (let y = start; y < start + hole; y += 1) {
    for (let x = start; x < start + hole; x += 1) mask.data[y * size + x] = 0;
  }
  return mask;
}

describe("judgeSlice", () => {
  const limits = DEFAULT_GROWTH;

  it("keeps a slice that looks like the one before it", () => {
    expect(judgeSlice(1000, 950, 0.9, limits)).toBeUndefined();
  });

  it("stops when the mask goes empty", () => {
    expect(judgeSlice(1000, 0, 0.9, limits)).toBe("vanished");
  });

  it("stops when the mask falls under the smallest area worth keeping", () => {
    expect(judgeSlice(1000, limits.minArea - 1, 0.9, limits)).toBe("collapsed");
  });

  it("stops when the mask jumps against the slice before it", () => {
    expect(judgeSlice(1000, 1000 * limits.growthRatio + 1, 0.9, limits)).toBe("leaked");
  });

  it("stops when the model rates its own answer low", () => {
    expect(judgeSlice(1000, 950, limits.minScore - 0.01, limits)).toBe("low-score");
  });

  it("reports the leak before the score, because a leak is the worse fault", () => {
    expect(judgeSlice(100, 100_000, 0.1, limits)).toBe("leaked");
  });

  it("lets a structure taper without calling it a fault", () => {
    let area = 4000;
    for (let step = 0; step < 6; step += 1) {
      const next = Math.round(area * 0.8);
      expect(judgeSlice(area, next, 0.85, limits, 4000)).toBeUndefined();
      area = next;
    }
  });

  it("stops a mask that drifted far past the slice the user clicked", () => {
    expect(judgeSlice(2000, 1000 * limits.driftRatio + 1, 0.9, limits, 1000)).toBe("drifted");
  });

  it("catches slow drift that every step test passes", () => {
    let area = 1000;
    let cause: StopCause | undefined;
    for (let step = 0; step < 20 && !cause; step += 1) {
      const next = Math.round(area * 1.2);
      cause = judgeSlice(area, next, 0.9, limits, 1000);
      area = next;
    }
    expect(cause).toBe("drifted");
  });

  it("ignores the drift test when the caller gives no seed", () => {
    expect(judgeSlice(2000, 1000 * limits.driftRatio + 1, 0.9, limits)).toBeUndefined();
  });
});

describe("stopMessage", () => {
  it("gives a plain reason for every cause", () => {
    const causes: StopCause[] = [
      "edge",
      "vanished",
      "collapsed",
      "leaked",
      "drifted",
      "low-score",
      "limit",
    ];
    for (const cause of causes) {
      expect(stopMessage(cause).length).toBeGreaterThan(10);
    }
  });

  it("tells a structure that ended apart from a tracker that gave up", () => {
    expect(stopMessage("vanished")).not.toBe(stopMessage("low-score"));
  });
});

describe("interiorPoint", () => {
  it("returns nothing for an empty mask", () => {
    expect(interiorPoint(emptyMask(8, 8))).toBeUndefined();
  });

  it("lands inside a filled block", () => {
    const mask = block(32, 32, 8, 10, 12, 9);
    const point = interiorPoint(mask)!;
    expect(mask.data[Math.round(point.y) * 32 + Math.round(point.x)]).toBe(1);
  });

  it("lands on the mask and not in the hole of a ring", () => {
    const mask = ring(24);
    const point = interiorPoint(mask)!;
    expect(mask.data[Math.round(point.y) * 24 + Math.round(point.x)]).toBe(1);
  });

  it("works on a mask one pixel wide, which erosion would wipe out", () => {
    const mask = block(16, 16, 7, 3, 1, 8);
    const point = interiorPoint(mask)!;
    expect(mask.data[Math.round(point.y) * 16 + Math.round(point.x)]).toBe(1);
  });
});

describe("promptBox", () => {
  it("returns nothing for an empty mask", () => {
    expect(promptBox(emptyMask(8, 8), 0.1)).toBeUndefined();
  });

  it("holds the whole mask", () => {
    const box = promptBox(block(40, 40, 10, 12, 8, 6), 0)!;
    expect(box).toEqual({ x0: 10, y0: 12, x1: 18, y1: 18 });
  });

  it("grows by the margin, so the next slice can move a little", () => {
    const tight = promptBox(block(40, 40, 10, 12, 10, 10), 0)!;
    const loose = promptBox(block(40, 40, 10, 12, 10, 10), 0.2)!;
    expect(loose.x0).toBeLessThan(tight.x0);
    expect(loose.x1).toBeGreaterThan(tight.x1);
  });

  it("never leaves the mask, so no prompt sits off the picture", () => {
    const box = promptBox(block(20, 20, 0, 0, 20, 20), 0.5)!;
    expect(box.x0).toBe(0);
    expect(box.y0).toBe(0);
    expect(box.x1).toBe(20);
    expect(box.y1).toBe(20);
  });
});

describe("growthDepths", () => {
  const range = { min: 0, max: 100 };

  it("walks up from the seed in steps of one slice", () => {
    expect(growthDepths(50, 5, 1, 3, range)).toEqual([55, 60, 65]);
  });

  it("walks down from the seed", () => {
    expect(growthDepths(50, 5, -1, 3, range)).toEqual([45, 40, 35]);
  });

  it("stops at the edge of the volume", () => {
    expect(growthDepths(92, 5, 1, 10, range)).toEqual([97]);
  });

  it("never travels further than the limit", () => {
    expect(growthDepths(50, 1, 1, 4, range)).toHaveLength(4);
  });

  it("gives nothing when the seed sits on the edge", () => {
    expect(growthDepths(99, 5, 1, 10, range)).toEqual([]);
  });

  it("refuses a step of zero, which would never move", () => {
    expect(growthDepths(50, 0, 1, 10, range)).toEqual([]);
  });
});

describe("DEFAULT_GROWTH", () => {
  it("caps the travel, so one seed cannot fill the volume", () => {
    expect(DEFAULT_GROWTH.maxSlices).toBeGreaterThan(0);
    expect(DEFAULT_GROWTH.maxSlices).toBeLessThanOrEqual(64);
  });

  it("keeps a mask smaller than the smallest area worth reporting", () => {
    expect(maskArea(block(8, 8, 0, 0, 3, 3))).toBeLessThan(DEFAULT_GROWTH.minArea);
  });
});
