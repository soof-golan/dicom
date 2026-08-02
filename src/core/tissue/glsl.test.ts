import { describe, expect, it } from "vite-plus/test";
import {
  BANDS,
  FATSAT_THRESHOLDS,
  SIGNAL_TABLE,
  T1_THRESHOLDS,
  TISSUE_INFO,
  type TissueClass,
} from "./classify.ts";
import { tissueGlsl } from "./glsl.ts";

const source = tissueGlsl();

/** How the generator writes a number, so a test can look for it. */
const f = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value));

describe("the generated shader carries the numbers from the classifier", () => {
  it("writes every threshold of both sequences", () => {
    for (const [suffix, t] of [
      ["T1", T1_THRESHOLDS],
      ["Fat", FATSAT_THRESHOLDS],
    ] as const) {
      expect(source).toContain(`TISSUE_NOISE_${suffix} = ${f(t.noise)}`);
      expect(source).toContain(`TISSUE_LOW_${suffix} = ${f(t.low)}`);
      expect(source).toContain(`TISSUE_HIGH_${suffix} = ${f(t.high)}`);
      expect(source).toContain(`nearest / ${f(t.margin)}`);
    }
  });

  it("keeps the two sequences apart, because their contrast differs", () => {
    expect(T1_THRESHOLDS.high).not.toBe(FATSAT_THRESHOLDS.high);
    expect(source).toContain("int a = tissueBandT1(t1);");
    expect(source).toContain("int b = tissueBandFat(fatsat);");
  });

  it("writes the color of every class the table can return", () => {
    const returned = new Set<TissueClass>(["background"]);
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
    const moved = tissueGlsl({ noise: 0.05, low: 0.25, high: 0.7, margin: 0.1 });
    expect(moved).toContain("TISSUE_LOW_T1 = 0.25");
    expect(moved).not.toContain(`TISSUE_LOW_T1 = ${f(T1_THRESHOLDS.low)}`);
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
