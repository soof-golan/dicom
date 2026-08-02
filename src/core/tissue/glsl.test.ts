import { describe, expect, it } from "vite-plus/test";
import {
  BANDS,
  DEFAULT_THRESHOLDS,
  MARROW_T1,
  SIGNAL_TABLE,
  TISSUE_INFO,
  type TissueClass,
} from "./classify.ts";
import { tissueGlsl } from "./glsl.ts";

const source = tissueGlsl();

/** How the generator writes a number, so a test can look for it. */
const f = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value));

describe("the generated shader carries the numbers from the classifier", () => {
  it("writes every threshold", () => {
    expect(source).toContain(`TISSUE_NOISE = ${f(DEFAULT_THRESHOLDS.noise)}`);
    expect(source).toContain(`TISSUE_LOW = ${f(DEFAULT_THRESHOLDS.low)}`);
    expect(source).toContain(`TISSUE_HIGH = ${f(DEFAULT_THRESHOLDS.high)}`);
  });

  it("writes the brightness that separates marrow from fat", () => {
    expect(source).toContain(`t1 > ${f(MARROW_T1)}`);
  });

  it("writes the color of every class the table can return", () => {
    const returned = new Set<TissueClass>(["background", "marrow"]);
    for (const row of BANDS) {
      for (const column of BANDS) returned.add(SIGNAL_TABLE[row][column].tissue);
    }
    returned.delete("unknown");

    for (const id of returned) {
      const [r, g, b] = TISSUE_INFO[id].color;
      expect(source, `${id} is missing from the shader`).toContain(
        `vec3(${f(r)}, ${f(g)}, ${f(b)})`,
      );
    }
  });

  it("follows a threshold when it changes, instead of keeping a stale copy", () => {
    // This is the whole point of generating the shader. A reader who corrects a
    // threshold must not have to remember a second place.
    const moved = tissueGlsl({ noise: 0.05, low: 0.25, high: 0.7 });
    expect(moved).toContain("TISSUE_LOW = 0.25");
    expect(moved).not.toContain(`TISSUE_LOW = ${f(DEFAULT_THRESHOLDS.low)}`);
  });
});

describe("the generated shader matches the table", () => {
  it("writes one arm for every cell, in band order", () => {
    for (const [row, t1Band] of BANDS.entries()) {
      expect(source).toContain(`if (a == ${row}) {`);
      for (const fatBand of BANDS) {
        const cell = SIGNAL_TABLE[t1Band][fatBand];
        const weight = `confidence * ${f(cell.weight)}`;
        expect(source, `${t1Band}/${fatBand} is missing`).toContain(weight);
      }
    }
  });

  it("gives the cell that fits no tissue zero confidence", () => {
    // Dark on T1 with middling water signal is the empty cell of the table.
    expect(SIGNAL_TABLE.low.mid.tissue).toBe("unknown");
    expect(source).toContain("confidence * 0.0");
  });

  it("declares both entry points", () => {
    expect(source).toContain("vec4 classifyTissue(float t1, float fatsat)");
    expect(source).toContain("vec4 classifyTissueSingle(float value, bool isFatSat)");
  });

  it("is valid enough to have balanced braces and no stray undefined", () => {
    expect(source).not.toContain("undefined");
    expect(source).not.toContain("NaN");
    expect(source.match(/\{/g)?.length).toBe(source.match(/\}/g)?.length);
  });
});
