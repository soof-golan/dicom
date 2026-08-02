/**
 * The structure labels, as GLSL.
 *
 * The shape rules cannot run in a shader. They need connected components and a
 * walk outward from each one, and neither fits a per-pixel program. So the CPU
 * decides once and hands the GPU a label per voxel.
 *
 * This module writes the lookup from the same `STRUCTURE_INFO` table that the
 * legend reads, so a color cannot differ between the picture and its key.
 */
import { STRUCTURE_INFO, STRUCTURE_ORDER, type StructureClass } from "./structures.ts";

/** GLSL reads `1` as an integer, so every float needs a decimal point. */
function f(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function color(id: StructureClass): string {
  const [r, g, b] = STRUCTURE_INFO[id].color;
  return `vec3(${f(r)}, ${f(g)}, ${f(b)})`;
}

/**
 * Write the label reader.
 *
 * The result declares `structureAt`, which returns a color in `rgb` and a
 * confidence from 0 to 1 in `a`. A confidence of 0 means the label says
 * nothing, and the caller must keep whatever the signal rule said.
 */
export function structureGlsl(): string {
  // Label 0 is `dark`, which adds nothing to the signal answer, so it returns
  // no confidence and the arms start at 1.
  const arms = STRUCTURE_ORDER.slice(1)
    .map((id, index) => `  if (label == ${index + 1}) return vec4(${color(id)}, confidence);`)
    .join("\n");

  return /* glsl */ `
uniform sampler3D uStructures;
uniform vec3 uStructureDims;
uniform mat4 uPatientToStructure;
uniform float uHasStructures;

// Read the label volume at a point in the patient. The labels were decided on
// the CPU, so this is a lookup and never a rule.
vec4 structureAt(vec3 patient) {
  if (uHasStructures < 0.5) return vec4(0.0);
  vec3 voxel = (uPatientToStructure * vec4(patient, 1.0)).xyz;
  if (any(lessThan(voxel, vec3(-0.5))) || any(greaterThan(voxel, uStructureDims - 0.5))) {
    return vec4(0.0);
  }
  vec2 texel = texture(uStructures, (voxel + 0.5) / uStructureDims).rg;
  int label = int(texel.r * 255.0 + 0.5);
  float confidence = texel.g;
${arms}
  return vec4(0.0);
}
`;
}
