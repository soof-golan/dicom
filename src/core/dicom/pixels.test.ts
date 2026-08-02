import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { getNumber } from "./access.ts";
import { readFixture } from "./fixtures.ts";
import { parseDicom } from "./parse.ts";
import { decodeFrame, frameCount, rescale, storedValueRange } from "./pixels.ts";
import { Tag } from "./tags.ts";

interface Reference {
  rows: number;
  columns: number;
  min: number;
  max: number;
  sum: number;
  sha256: string;
  samples: [number, number, number][];
}

const REFERENCE = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/syntax/reference.json", import.meta.url), "utf8"),
) as Reference;

function sha256OfUint16(pixels: ArrayLike<number>): string {
  const bytes = new Uint8Array(pixels.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pixels.length; i += 1) {
    view.setUint16(i * 2, pixels[i]!, true);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeFixture(name: string) {
  return decodeFrame(parseDicom(readFixture(`syntax/${name}`)), 0);
}

describe("decodeFrame", () => {
  it("matches the reference pixels byte for byte", () => {
    const frame = decodeFixture("explicit-le.dcm");
    expect(frame.rows).toBe(REFERENCE.rows);
    expect(frame.columns).toBe(REFERENCE.columns);
    expect(frame.pixels).toHaveLength(REFERENCE.rows * REFERENCE.columns);
    expect(sha256OfUint16(frame.pixels)).toBe(REFERENCE.sha256);
  });

  it("reads each sampled pixel at the right row and column", () => {
    const frame = decodeFixture("explicit-le.dcm");
    for (const [row, column, value] of REFERENCE.samples) {
      expect(frame.pixels[row * frame.columns + column]).toBe(value);
    }
  });

  it("reports the stored value range", () => {
    const frame = decodeFixture("explicit-le.dcm");
    expect(storedValueRange(frame)).toEqual({
      min: REFERENCE.min,
      max: REFERENCE.max,
    });
  });

  it.each(["implicit-le.dcm", "explicit-be.dcm", "rle.dcm"])(
    "decodes %s to the same pixels as explicit little endian",
    (name) => {
      expect(sha256OfUint16(decodeFixture(name).pixels)).toBe(REFERENCE.sha256);
    },
  );

  it("keeps every value inside the stored bit depth", () => {
    const frame = decodeFixture("explicit-le.dcm");
    expect(frame.bitsStored).toBe(12);
    expect(storedValueRange(frame).max).toBeLessThan(2 ** 12);
  });

  it("describes a monochrome frame", () => {
    const frame = decodeFixture("explicit-le.dcm");
    expect(frame.samplesPerPixel).toBe(1);
    expect(frame.photometric).toBe("MONOCHROME2");
    expect(frame.signed).toBe(false);
    expect(frame.invert).toBe(false);
  });

  it("carries the window that the scanner suggested", () => {
    const frame = decodeFixture("explicit-le.dcm");
    expect(frame.windowCenter).toBeGreaterThan(0);
    expect(frame.windowWidth).toBeGreaterThan(0);
  });
});

describe("signed pixels and the rescale transform", () => {
  it("reads signed values as negative numbers", () => {
    const frame = decodeFixture("signed-rescaled.dcm");
    expect(frame.signed).toBe(true);
    expect(frame.pixels).toBeInstanceOf(Int16Array);
    expect(storedValueRange(frame).min).toBeLessThan(0);
  });

  it("applies slope and intercept", () => {
    const frame = decodeFixture("signed-rescaled.dcm");
    expect(frame.rescaleSlope).toBe(2);
    expect(frame.rescaleIntercept).toBe(-1024);
    const values = rescale(frame);
    const first = frame.pixels[0]!;
    expect(values[0]).toBeCloseTo(first * 2 - 1024, 5);
  });

  it("undoes the shift that the fixture applied", () => {
    // The fixture stored `original - 1024`. Slope 2 then doubles it.
    const signed = decodeFixture("signed-rescaled.dcm");
    const original = decodeFixture("explicit-le.dcm");
    expect(signed.pixels[0]! + 1024).toBe(original.pixels[0]);
  });
});

describe("frameCount", () => {
  it("reports one frame for a single-frame image", () => {
    expect(frameCount(parseDicom(readFixture("syntax/explicit-le.dcm")))).toBe(1);
  });

  it("rejects a frame index outside the image", () => {
    const dataSet = parseDicom(readFixture("syntax/explicit-le.dcm"));
    expect(() => decodeFrame(dataSet, 1)).toThrow(/frame 1/i);
  });
});

describe("fixture sanity", () => {
  it("has 12 bits stored inside 16 allocated", () => {
    const dataSet = parseDicom(readFixture("syntax/explicit-le.dcm"));
    expect(getNumber(dataSet, Tag.BitsAllocated)).toBe(16);
    expect(getNumber(dataSet, Tag.BitsStored)).toBe(12);
  });
});
