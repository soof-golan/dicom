import { describe, expect, it } from "vite-plus/test";
import { clearedForNewSeries, resolveDisplay, type DisplayParams } from "./viewState.ts";
import type { ViewerState } from "./viewer/VolumeScene.ts";

const defaults = {
  windowCenter: 700,
  windowWidth: 1400,
  tissueMix: 0,
  slabThickness: 0,
  opacity: 3,
  threshold: 0.28,
} as ViewerState;

const empty: DisplayParams = {
  wc: null,
  ww: null,
  tissue: null,
  slab: null,
  density: null,
  threshold: null,
};

describe("resolveDisplay", () => {
  it("uses the series defaults when the URL carries nothing", () => {
    expect(resolveDisplay(empty, defaults)).toEqual({
      windowCenter: 700,
      windowWidth: 1400,
      tissueMix: 0,
      slabThickness: 0,
      opacity: 3,
      threshold: 0.28,
    });
  });

  it("takes each value the URL carries", () => {
    const resolved = resolveDisplay({ ...empty, wc: 120, tissue: 0.5 }, defaults);
    expect(resolved.windowCenter).toBe(120);
    expect(resolved.tissueMix).toBe(0.5);
  });

  it("leaves the other values on their defaults", () => {
    const resolved = resolveDisplay({ ...empty, wc: 120 }, defaults);
    expect(resolved.windowWidth).toBe(1400);
    expect(resolved.opacity).toBe(3);
  });

  it("keeps a value of zero, which is not the same as absent", () => {
    // `?? ` and not `||`. A tissue mix of 0 is a real choice.
    expect(resolveDisplay({ ...empty, tissue: 0 }, { ...defaults, tissueMix: 0.9 }).tissueMix).toBe(
      0,
    );
  });

  it("keeps a negative brightness, which a signed scan can need", () => {
    expect(resolveDisplay({ ...empty, wc: -1024 }, defaults).windowCenter).toBe(-1024);
  });
});

describe("clearedForNewSeries", () => {
  it("clears only the values measured from one series", () => {
    expect(clearedForNewSeries()).toEqual({ wc: null, ww: null });
  });

  it("leaves the settings that carry over", () => {
    const cleared = clearedForNewSeries() as Partial<DisplayParams>;
    expect(cleared.tissue).toBeUndefined();
    expect(cleared.density).toBeUndefined();
    expect(cleared.threshold).toBeUndefined();
    expect(cleared.slab).toBeUndefined();
  });

  it("makes the next resolve fall back to the new series defaults", () => {
    const beforeSwitch: DisplayParams = { ...empty, wc: 120, tissue: 0.5 };
    const afterSwitch: DisplayParams = { ...beforeSwitch, ...clearedForNewSeries() };
    const next = { ...defaults, windowCenter: 55, windowWidth: 110 } as ViewerState;
    expect(resolveDisplay(afterSwitch, next).windowCenter).toBe(55);
    // A setting that is not tied to the series survives the switch.
    expect(resolveDisplay(afterSwitch, next).tissueMix).toBe(0.5);
  });
});
