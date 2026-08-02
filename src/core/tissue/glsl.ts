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
  FATSAT_THRESHOLDS,
  SIGNAL_TABLE,
  SINGLE_PENALTY,
  T1_THRESHOLDS,
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
 * The band test and the confidence curve for one sequence.
 *
 * Each sequence carries its own edges, so each needs its own pair of functions.
 * `suffix` names them apart: `tissueBandT1` and `tissueBandFat`.
 */
function bandFunctions(suffix: string, t: Thresholds): string {
  return /* glsl */ `
const float TISSUE_NOISE_${suffix} = ${f(t.noise)};
const float TISSUE_LOW_${suffix} = ${f(t.low)};
const float TISSUE_HIGH_${suffix} = ${f(t.high)};

int tissueBand${suffix}(float value) {
  if (value < TISSUE_LOW_${suffix}) return 0;
  if (value < TISSUE_HIGH_${suffix}) return 1;
  return 2;
}

// Confidence is the distance to the nearest band edge. A voxel that sits on an
// edge could belong to either class, and the viewer must not claim otherwise.
float tissueMargin${suffix}(float value) {
  float nearest = min(abs(value - TISSUE_LOW_${suffix}), abs(value - TISSUE_HIGH_${suffix}));
  return min(1.0, nearest / ${f(t.margin)});
}
`;
}

/**
 * Write the classifier.
 *
 * The result declares `classifyTissue` and `classifyTissueSingle`. Both return
 * a color in `rgb` and a confidence from 0 to 1 in `a`.
 */
export function tissueGlsl(
  t1Bands: Thresholds = T1_THRESHOLDS,
  fatBands: Thresholds = FATSAT_THRESHOLDS,
): string {
  const table = BANDS.map((t1Band, row) => {
    const arms = BANDS.map((fatBand, column) => {
      const cell = SIGNAL_TABLE[t1Band][fatBand];
      const value = `vec4(${color(cell.tissue)}, confidence * ${f(cell.weight)})`;
      // The last band needs no test, because the bands cover every value.
      return column === BANDS.length - 1
        ? `    return ${value};`
        : `    if (b == ${column}) return ${value};`;
    }).join("\n");
    return `  if (a == ${row}) {\n${arms}\n  }`;
  }).join("\n");

  return /* glsl */ `
const vec3 TISSUE_BACKGROUND = ${color("background")};
${bandFunctions("T1", t1Bands)}${bandFunctions("Fat", fatBands)}
// Two sequences. This is the table from classify.ts, written out.
vec4 classifyTissue(float t1, float fatsat) {
  if (t1 < TISSUE_NOISE_T1 && fatsat < TISSUE_NOISE_Fat) return vec4(TISSUE_BACKGROUND, 1.0);
  int a = tissueBandT1(t1);
  int b = tissueBandFat(fatsat);
  float confidence = min(tissueMarginT1(t1), tissueMarginFat(fatsat));
${table}
  return vec4(TISSUE_BACKGROUND, 0.0);
}

// One sequence. Fat and fluid cannot be separated, so confidence is halved and
// the classes are coarse.
vec4 classifyTissueSingle(float value, bool isFatSat) {
  float noise = isFatSat ? TISSUE_NOISE_Fat : TISSUE_NOISE_T1;
  if (value < noise) return vec4(TISSUE_BACKGROUND, 1.0);
  float confidence =
    (isFatSat ? tissueMarginFat(value) : tissueMarginT1(value)) * ${f(SINGLE_PENALTY)};
  int a = isFatSat ? tissueBandFat(value) : tissueBandT1(value);
  if (a == 2) return vec4(isFatSat ? ${color("fluid")} : ${color("fat")}, confidence);
  if (a == 1) return vec4(${color("muscle")}, confidence);
  return vec4(${color("dark")}, confidence);
}
`;
}
