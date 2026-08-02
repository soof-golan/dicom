import { describe, expect, it } from "vite-plus/test";
import {
  BACKGROUND,
  colourAt,
  colourDistance,
  contrastRatio,
  nextColour,
  RESERVED_COLOURS,
  SEGMENT_COLOURS,
  toBytes,
  toOklab,
} from "./palette.ts";

/** Below this, two colours read as the same colour at a glance. */
const APART = 0.1;
/** Segments must stay further from the tissue ramp than from each other. */
const CLEAR_OF_TISSUE = 0.14;

describe("the palette", () => {
  it("has no repeats", () => {
    expect(new Set(SEGMENT_COLOURS).size).toBe(SEGMENT_COLOURS.length);
  });

  it("reads clearly on the page behind the panes", () => {
    for (const colour of SEGMENT_COLOURS) {
      expect(contrastRatio(colour, BACKGROUND)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps every pair of colours apart", () => {
    for (let i = 0; i < SEGMENT_COLOURS.length; i += 1) {
      for (let j = i + 1; j < SEGMENT_COLOURS.length; j += 1) {
        const distance = colourDistance(SEGMENT_COLOURS[i]!, SEGMENT_COLOURS[j]!);
        expect(distance, `${SEGMENT_COLOURS[i]} and ${SEGMENT_COLOURS[j]}`).toBeGreaterThan(APART);
      }
    }
  });

  it("stays away from the tissue ramp and the crosshair", () => {
    for (const colour of SEGMENT_COLOURS) {
      for (const reserved of RESERVED_COLOURS) {
        const distance = colourDistance(colour, reserved);
        expect(distance, `${colour} and ${reserved}`).toBeGreaterThan(CLEAR_OF_TISSUE);
      }
    }
  });
});

describe("colour maths", () => {
  it("puts black at the bottom of the lightness axis", () => {
    expect(toOklab("#000000")[0]).toBeCloseTo(0, 6);
  });

  it("puts white at the top of the lightness axis", () => {
    expect(toOklab("#ffffff")[0]).toBeCloseTo(1, 4);
  });

  it("gives white on black the highest contrast ratio", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
  });

  it("gives a colour against itself a ratio of one", () => {
    expect(contrastRatio("#4ef07a", "#4ef07a")).toBe(1);
  });

  it("reports no distance between a colour and itself", () => {
    expect(colourDistance("#ff4fd8", "#ff4fd8")).toBe(0);
  });

  it("splits a hex colour into bytes", () => {
    expect(toBytes("#ff8a1f")).toEqual([255, 138, 31]);
  });
});

describe("handing out colours", () => {
  it("gives a different colour for each position", () => {
    const colours = SEGMENT_COLOURS.map((_, index) => colourAt(index));
    expect(new Set(colours).size).toBe(SEGMENT_COLOURS.length);
  });

  it("starts again after the last colour", () => {
    expect(colourAt(SEGMENT_COLOURS.length)).toBe(colourAt(0));
  });

  it("accepts a negative position", () => {
    expect(colourAt(-1)).toBe(SEGMENT_COLOURS[SEGMENT_COLOURS.length - 1]);
  });

  it("gives the first colour when nothing is used", () => {
    expect(nextColour([])).toBe(SEGMENT_COLOURS[0]);
  });

  it("never repeats a colour while free ones remain", () => {
    const used: string[] = [];
    for (let i = 0; i < SEGMENT_COLOURS.length; i += 1) used.push(nextColour(used));
    expect(new Set(used).size).toBe(SEGMENT_COLOURS.length);
  });

  it("picks the least used colour after the list runs out", () => {
    const used = [...SEGMENT_COLOURS, SEGMENT_COLOURS[0]!, SEGMENT_COLOURS[1]!];
    expect(nextColour(used)).toBe(SEGMENT_COLOURS[2]);
  });

  it("ignores colours that are not in the palette", () => {
    expect(nextColour(["#123456", "#123456"])).toBe(SEGMENT_COLOURS[0]);
  });
});
