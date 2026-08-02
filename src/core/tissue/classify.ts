/**
 * Reading tissue type from MRI signal.
 *
 * A single MRI image cannot name a tissue. Signal strength alone is ambiguous:
 * cortical bone, a tendon, and a ligament are all black on every sequence. What
 * separates tissues is how their signal CHANGES between sequences.
 *
 * This study holds two useful sequences:
 *
 * - T1: fat and bone marrow are bright, muscle is middle, fluid is dark.
 * - PD with fat saturation: fluid and edema are bright, fat is pushed dark,
 *   muscle is middle to dark.
 *
 * Together they separate fat from fluid, which is the pair that matters most
 * after an injury. Edema and an effusion are the signs of damage, and on T1
 * alone they hide.
 *
 * CAUTION: this is signal logic, not a diagnosis. Two limits are built in, and
 * both come from the physics, not from the code:
 *
 * - A tendon, a ligament and cortical bone give no signal on either sequence.
 *   They are one class, `dark`, and the classifier never guesses between them.
 * - Bone marrow and subcutaneous fat are both fat, and behave the same on both
 *   sequences. They are one class, `fat`. An earlier version split them by T1
 *   brightness. Measured against the reference elbow, every brightness cut kept
 *   the same share of shallow and deep voxels, so the split carried no
 *   information about where the fat was.
 */
import { MUSCLE_LEVEL } from "./scale.ts";

export type TissueClass = "background" | "fat" | "muscle" | "fluid" | "edema" | "dark" | "unknown";

export interface TissueInfo {
  readonly id: TissueClass;
  readonly name: string;
  /** What the class covers, in the words a report uses. */
  readonly covers: string;
  /** sRGB, chosen to stay apart on the dark background of the viewer. */
  readonly color: readonly [number, number, number];
}

export const TISSUE_INFO: Readonly<Record<TissueClass, TissueInfo>> = {
  background: {
    id: "background",
    name: "Background",
    covers: "Air and noise outside the body.",
    color: [0.04, 0.05, 0.07],
  },
  fat: {
    id: "fat",
    name: "Fat and marrow",
    covers:
      "Subcutaneous fat, fat between muscles, and fatty bone marrow. Marrow is fat inside bone, and no signal separates the two.",
    color: [0.96, 0.85, 0.55],
  },
  muscle: {
    id: "muscle",
    name: "Muscle",
    covers: "Muscle bellies, such as the extensors and the flexors.",
    color: [0.72, 0.33, 0.31],
  },
  fluid: {
    id: "fluid",
    name: "Fluid",
    covers: "Joint fluid, an effusion, or a cyst.",
    color: [0.35, 0.82, 1.0],
  },
  edema: {
    id: "edema",
    name: "Edema",
    covers: "Swelling in soft tissue or in bone. A bone bruise reads here.",
    color: [1.0, 0.45, 0.75],
  },
  dark: {
    id: "dark",
    name: "Cortex, tendon, or ligament",
    covers:
      "Signal is absent on both sequences. Cortical bone, tendon, and ligament cannot be separated by signal.",
    color: [0.42, 0.47, 0.6],
  },
  unknown: {
    id: "unknown",
    name: "Not classified",
    covers: "The signal does not fit one class with enough confidence.",
    color: [0.3, 0.3, 0.34],
  },
};

export const TISSUE_ORDER: readonly TissueClass[] = ["dark", "muscle", "fat", "fluid", "edema"];

/** One voxel, as normalized signal from each sequence. Each value is 0 to 1. */
export interface Signal {
  /** T1-weighted signal, or `undefined` when no T1 series is loaded. */
  readonly t1?: number;
  /** Fat-saturated proton density signal. */
  readonly pdfs?: number;
}

export interface Classified {
  readonly tissue: TissueClass;
  /** 0 to 1. Low confidence means the signal sat near a boundary. */
  readonly confidence: number;
}

/**
 * Band edges for one sequence, on the muscle-anchored scale of `scale.ts`.
 *
 * Each sequence needs its own edges, because the two do not spread their
 * tissues the same way. On T1 the bright class is fat, and fat reaches only
 * about 1.4 times muscle. On a fat-saturated sequence the bright class is
 * water, and water reaches three times muscle or more. One pair of edges
 * cannot serve both: edges that catch fat on T1 would call ordinary muscle
 * edema on the fat-saturated sequence.
 */
export interface Thresholds {
  /** Below this on every sequence, the voxel is outside the body. */
  readonly noise: number;
  readonly low: number;
  readonly high: number;
  /** How far a value must sit from a band edge before confidence reaches 1. */
  readonly margin: number;
}

/** Muscle reads `MUSCLE_LEVEL`, so 0.3 on this scale is one muscle. */
const MUSCLE = MUSCLE_LEVEL;

/**
 * T1: `high` is where fat begins, at 1.4 times muscle.
 *
 * Measured on the coronal pair of the reference elbow: the voxels that fat
 * saturation removes sit at 1.55 times muscle in the middle and 2.25 times at
 * the ninth tenth. Below 0.7 times muscle a tissue is dark on T1, which covers
 * cortical bone, tendon, ligament, and free fluid.
 */
export const T1_THRESHOLDS: Thresholds = {
  noise: 0.2 * MUSCLE,
  low: 0.7 * MUSCLE,
  high: 1.4 * MUSCLE,
  margin: 0.17 * MUSCLE,
};

/**
 * Fat-saturated: `high` is where water begins, at 2.4 times muscle.
 *
 * Edema and an effusion are markedly brighter than muscle, not slightly. At the
 * ninth tenth ordinary tissue reaches 2.1 times muscle on this sequence, so a
 * lower edge paints the whole arm as edema. Below 0.73 times muscle the fat
 * pulse has removed the signal, which is what marks fat.
 */
export const FATSAT_THRESHOLDS: Thresholds = {
  noise: 0.2 * MUSCLE,
  low: 0.73 * MUSCLE,
  high: 2.4 * MUSCLE,
  margin: 0.3 * MUSCLE,
};

/** One sequence cannot separate fat from fluid, so its confidence is halved. */
export const SINGLE_PENALTY = 0.5;

export type Band = "low" | "mid" | "high";

export const BANDS: readonly Band[] = ["low", "mid", "high"];

export interface Cell {
  readonly tissue: TissueClass;
  /** Multiplies the confidence. A cell the rules half-trust scores lower. */
  readonly weight: number;
}

/**
 * The signal table that a radiologist reads, as data.
 *
 * Rows are the T1 band, columns are the fat-saturated band.
 *
 * |          | fat-sat low | fat-sat mid | fat-sat high |
 * | -------- | ----------- | ----------- | ------------ |
 * | T1 low   | cortex      | (none)      | fluid        |
 * | T1 mid   | fat         | muscle      | edema        |
 * | T1 high  | fat         | fat         | (none)       |
 *
 * The left column is fat, on both rows that carry signal. Fat saturation
 * removes fat and nothing else, so a tissue that goes dark under the fat pulse
 * is fat, whatever it did on T1. Reading only the T1 brightness misses the
 * greater part of the subcutaneous rim, because a surface coil makes fat far
 * from the coil no brighter than muscle near it.
 *
 * The two empty cells are real:
 *
 * - Dark on T1 with middling water signal fits no tissue cleanly.
 * - Bright on T1 AND bright after fat saturation is not edema. Edema is water,
 *   and water is never bright on T1. That pair means the fat pulse failed at
 *   that place, or that blood is breaking down there. Painting it as edema put
 *   pink over whole subcutaneous swathes.
 *
 * The table is the single source of truth. `classifyPair` reads it, and the
 * GLSL in `glsl.ts` is generated from it, so the shader and the classifier
 * cannot disagree about a rule or a number.
 */
export const SIGNAL_TABLE: Readonly<Record<Band, Readonly<Record<Band, Cell>>>> = {
  low: {
    low: { tissue: "dark", weight: 1 },
    mid: { tissue: "unknown", weight: 0 },
    high: { tissue: "fluid", weight: 1 },
  },
  mid: {
    low: { tissue: "fat", weight: 0.7 },
    mid: { tissue: "muscle", weight: 1 },
    high: { tissue: "edema", weight: 1 },
  },
  high: {
    low: { tissue: "fat", weight: 1 },
    mid: { tissue: "fat", weight: 0.7 },
    high: { tissue: "unknown", weight: 0 },
  },
};

export function band(value: number, t: Thresholds): Band {
  if (value < t.low) return "low";
  if (value < t.high) return "mid";
  return "high";
}

/** Distance from the nearest band edge, as confidence. */
function margin(value: number, t: Thresholds): number {
  const nearest = Math.min(Math.abs(value - t.low), Math.abs(value - t.high));
  return Math.min(1, nearest / t.margin);
}

/** Classify one voxel from two sequences, through `SIGNAL_TABLE`. */
export function classifyPair(
  signal: Signal,
  t1Bands: Thresholds = T1_THRESHOLDS,
  fatBands: Thresholds = FATSAT_THRESHOLDS,
): Classified {
  const { t1, pdfs } = signal;
  if (t1 === undefined || pdfs === undefined) return classifySingle(signal, t1Bands, fatBands);

  if (t1 < t1Bands.noise && pdfs < fatBands.noise) return { tissue: "background", confidence: 1 };

  const cell = SIGNAL_TABLE[band(t1, t1Bands)][band(pdfs, fatBands)];
  return {
    tissue: cell.tissue,
    confidence: Math.min(margin(t1, t1Bands), margin(pdfs, fatBands)) * cell.weight,
  };
}

/**
 * Classify from one sequence.
 *
 * One sequence cannot separate fat from fluid, so the result is coarse and the
 * confidence is capped. The viewer must say so.
 */
export function classifySingle(
  signal: Signal,
  t1Bands: Thresholds = T1_THRESHOLDS,
  fatBands: Thresholds = FATSAT_THRESHOLDS,
): Classified {
  const fatSat = signal.pdfs !== undefined;
  const value = signal.pdfs ?? signal.t1;
  const t = fatSat ? fatBands : t1Bands;
  if (value === undefined) return { tissue: "unknown", confidence: 0 };
  if (value < t.noise) return { tissue: "background", confidence: 1 };

  const confidence = margin(value, t) * SINGLE_PENALTY;
  // Bright means water on a fat-saturated sequence, and fat on T1.
  if (value >= t.high) return { tissue: fatSat ? "fluid" : "fat", confidence };
  if (value >= t.low) return { tissue: "muscle", confidence };
  return { tissue: "dark", confidence };
}

/** How many voxels fell in each class. Useful for a legend and for a check. */
export function tally(classes: Iterable<TissueClass>): Record<TissueClass, number> {
  const counts: Record<TissueClass, number> = {
    background: 0,
    fat: 0,
    muscle: 0,
    fluid: 0,
    edema: 0,
    dark: 0,
    unknown: 0,
  };
  for (const value of classes) counts[value] += 1;
  return counts;
}
