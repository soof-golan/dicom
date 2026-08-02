import { describe, expect, it } from "vite-plus/test";
import { structureGlsl } from "./structureGlsl.ts";
import { STRUCTURE_INFO, STRUCTURE_ORDER } from "./structures.ts";

describe("structureGlsl", () => {
  const source = structureGlsl();

  it("declares the reader the shaders call", () => {
    expect(source).toContain("vec4 structureAt(vec3 patient)");
  });

  it("writes the same color as the legend shows", () => {
    for (const id of STRUCTURE_ORDER) {
      if (id === "dark") continue;
      const [r] = STRUCTURE_INFO[id].color;
      expect(source).toContain(String(r));
    }
  });

  it("gives every named class an arm", () => {
    for (let label = 1; label < STRUCTURE_ORDER.length; label += 1) {
      expect(source).toContain(`if (label == ${label})`);
    }
  });

  it("gives the dark label no arm, so the signal answer stands", () => {
    expect(source).not.toContain("if (label == 0)");
  });

  it("returns nothing when no labels are bound", () => {
    expect(source).toContain("if (uHasStructures < 0.5) return vec4(0.0);");
  });

  it("writes every float with a decimal point, as GLSL needs", () => {
    // `vec3(1, 0.6, 0.35)` is a compile error in GLSL ES 3.0.
    for (const literal of source.matchAll(/vec3\(([^)]*)\)/g)) {
      for (const part of literal[1]!.split(",")) {
        expect(part.trim()).toMatch(/\./);
      }
    }
  });
});
