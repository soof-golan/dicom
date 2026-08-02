/**
 * The tissue classifier, as GLSL.
 *
 * The GPU classifies every pixel it draws, so the rules must run in a shader.
 * The rules already exist in `classify.ts`, and two copies of a rule always
 * drift apart. A reader who corrects a threshold in one place must not have to
 * remember the other.
 *
 * So this module writes the shader from the same data that `classifyPair`
 * reads: `SIGNAL_TABLE` for the rules, `TISSUE_INFO` for the colors, and the
 * `Thresholds` for the band edges. A change to any of them changes both.
 *
 * CAUTION: half floats on the GPU carry about three decimal digits. A voxel
 * that sits exactly on a band edge can land in either band. That is what the
 * confidence value is for: near an edge it falls to zero, and the viewer shows
 * gray there instead of a color.
 */
import {
  BANDS,
  DEFAULT_THRESHOLDS,
  MARGIN_SPAN,
  MARROW_T1,
  SIGNAL_TABLE,
  SINGLE_PENALTY,
  TISSUE_INFO,
  type Thresholds,
  type TissueClass,
} from "./classify.ts";

/** GLSL reads `1` as an integer, so every float needs a decimal point. */
function f(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function color(id: TissueClass): string {
  const [r, g, b] = TISSUE_INFO[id].color;
  return `vec3(${f(r)}, ${f(g)}, ${f(b)})`;
}

/**
 * The color for one cell of the signal table.
 *
 * The fat cell that the rules fully trust also holds marrow, and the two are
 * split by brightness alone, so that split is written as a choice in the
 * shader.
 */
function cellColor(tissue: TissueClass, weight: number): string {
  if (tissue === "fat" && weight === 1) {
    return `(t1 > ${f(MARROW_T1)} ? ${color("marrow")} : ${color("fat")})`;
  }
  return color(tissue);
}

/**
 * Write the classifier.
 *
 * The result declares `classifyTissue` and `classifyTissueSingle`. Both return
 * a color in `rgb` and a confidence from 0 to 1 in `a`.
 */
export function tissueGlsl(t: Thresholds = DEFAULT_THRESHOLDS): string {
  const table = BANDS.map((t1Band, row) => {
    const arms = BANDS.map((fatBand, column) => {
      const cell = SIGNAL_TABLE[t1Band][fatBand];
      const value = `vec4(${cellColor(cell.tissue, cell.weight)}, confidence * ${f(cell.weight)})`;
      // The last band needs no test, because the bands cover every value.
      return column === BANDS.length - 1
        ? `    return ${value};`
        : `    if (b == ${column}) return ${value};`;
    }).join("\n");
    return `  if (a == ${row}) {\n${arms}\n  }`;
  }).join("\n");

  return /* glsl */ `
const float TISSUE_NOISE = ${f(t.noise)};
const float TISSUE_LOW = ${f(t.low)};
const float TISSUE_HIGH = ${f(t.high)};
const vec3 TISSUE_BACKGROUND = ${color("background")};

int tissueBand(float value) {
  if (value < TISSUE_LOW) return 0;
  if (value < TISSUE_HIGH) return 1;
  return 2;
}

// Confidence is the distance to the nearest band edge. A voxel that sits on an
// edge could belong to either class, and the viewer must not claim otherwise.
float tissueMargin(float value) {
  float nearest = min(abs(value - TISSUE_LOW), abs(value - TISSUE_HIGH));
  return min(1.0, nearest / ${f(MARGIN_SPAN)});
}

// Two sequences. This is the table from classify.ts, written out.
vec4 classifyTissue(float t1, float fatsat) {
  if (t1 < TISSUE_NOISE && fatsat < TISSUE_NOISE) return vec4(TISSUE_BACKGROUND, 1.0);
  int a = tissueBand(t1);
  int b = tissueBand(fatsat);
  float confidence = min(tissueMargin(t1), tissueMargin(fatsat));
${table}
  return vec4(TISSUE_BACKGROUND, 0.0);
}

// One sequence. Fat and fluid cannot be separated, so confidence is halved and
// the classes are coarse.
vec4 classifyTissueSingle(float value, bool isFatSat) {
  if (value < TISSUE_NOISE) return vec4(TISSUE_BACKGROUND, 1.0);
  float confidence = tissueMargin(value) * ${f(SINGLE_PENALTY)};
  int a = tissueBand(value);
  if (a == 2) return vec4(isFatSat ? ${color("fluid")} : ${color("fat")}, confidence);
  if (a == 1) return vec4(${color("muscle")}, confidence);
  return vec4(${color("dark")}, confidence);
}
`;
}
