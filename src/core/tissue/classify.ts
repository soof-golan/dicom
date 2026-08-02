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
 * CAUTION: this is signal logic, not a diagnosis. It cannot tell a tendon from
 * cortical bone, because both give no signal on both sequences. It reports that
 * pair as one class, `dark`, and never guesses between them.
 */

export type TissueClass =
  | "background"
  | "fat"
  | "marrow"
  | "muscle"
  | "fluid"
  | "edema"
  | "dark"
  | "unknown";

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
    name: "Fat",
    covers: "Subcutaneous fat and fat between muscles.",
    color: [0.96, 0.85, 0.55],
  },
  marrow: {
    id: "marrow",
    name: "Marrow",
    covers: "Fatty bone marrow inside the humerus, radius, and ulna.",
    color: [0.99, 0.93, 0.78],
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

export const TISSUE_ORDER: readonly TissueClass[] = [
  "dark",
  "muscle",
  "fat",
  "marrow",
  "fluid",
  "edema",
];

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

export interface Thresholds {
  /** Below this on every sequence, the voxel is outside the body. */
  readonly noise: number;
  readonly low: number;
  readonly high: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { noise: 0.08, low: 0.32, high: 0.62 };

/**
 * T1 above this, in fat, reads as marrow instead.
 *
 * Marrow is fat inside bone. Its signal is the same fat signal, so nothing but
 * a bone mask separates the two. The brightest fat is reported as marrow.
 */
export const MARROW_T1 = 0.82;

/** How far a value must sit from a band edge before confidence reaches 1. */
export const MARGIN_SPAN = 0.15;

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
 * | T1 mid   | muscle      | muscle      | edema        |
 * | T1 high  | fat, marrow | fat         | edema        |
 *
 * The table is the single source of truth. `classifyPair` reads it, and the
 * GLSL in `glsl.ts` is generated from it, so the shader and the classifier
 * cannot disagree about a rule or a number.
 *
 * The empty cell is real. Dark on T1 with middling water signal fits no tissue
 * cleanly, so the classifier says `unknown` instead of guessing.
 */
export const SIGNAL_TABLE: Readonly<Record<Band, Readonly<Record<Band, Cell>>>> = {
  low: {
    low: { tissue: "dark", weight: 1 },
    mid: { tissue: "unknown", weight: 0 },
    high: { tissue: "fluid", weight: 1 },
  },
  mid: {
    low: { tissue: "muscle", weight: 1 },
    mid: { tissue: "muscle", weight: 1 },
    high: { tissue: "edema", weight: 1 },
  },
  high: {
    low: { tissue: "fat", weight: 1 },
    mid: { tissue: "fat", weight: 0.7 },
    high: { tissue: "edema", weight: 1 },
  },
};

export function band(value: number, t: Thresholds = DEFAULT_THRESHOLDS): Band {
  if (value < t.low) return "low";
  if (value < t.high) return "mid";
  return "high";
}

/** Distance from the nearest band edge, as confidence. */
function margin(value: number, t: Thresholds): number {
  const nearest = Math.min(Math.abs(value - t.low), Math.abs(value - t.high));
  return Math.min(1, nearest / MARGIN_SPAN);
}

/**
 * Classify one voxel from two sequences.
 *
 * The answer comes from `SIGNAL_TABLE`, with one refinement: the brightest fat
 * is reported as marrow.
 */
export function classifyPair(signal: Signal, t: Thresholds = DEFAULT_THRESHOLDS): Classified {
  const { t1, pdfs } = signal;
  if (t1 === undefined || pdfs === undefined) return classifySingle(signal, t);

  if (t1 < t.noise && pdfs < t.noise) return { tissue: "background", confidence: 1 };

  const cell = SIGNAL_TABLE[band(t1, t)][band(pdfs, t)];
  const confidence = Math.min(margin(t1, t), margin(pdfs, t)) * cell.weight;
  const marrow = cell.tissue === "fat" && cell.weight === 1 && t1 > MARROW_T1;
  return { tissue: marrow ? "marrow" : cell.tissue, confidence };
}

/**
 * Classify from one sequence.
 *
 * One sequence cannot separate fat from fluid, so the result is coarse and the
 * confidence is capped. The viewer must say so.
 */
export function classifySingle(signal: Signal, t: Thresholds = DEFAULT_THRESHOLDS): Classified {
  const value = signal.pdfs ?? signal.t1;
  if (value === undefined) return { tissue: "unknown", confidence: 0 };
  if (value < t.noise) return { tissue: "background", confidence: 1 };

  const confidence = margin(value, t) * SINGLE_PENALTY;
  if (signal.pdfs !== undefined) {
    // On a fat-saturated sequence, bright means water.
    if (value >= t.high) return { tissue: "fluid", confidence };
    if (value >= t.low) return { tissue: "muscle", confidence };
    return { tissue: "dark", confidence };
  }
  // On T1, bright means fat.
  if (value >= t.high) return { tissue: "fat", confidence };
  if (value >= t.low) return { tissue: "muscle", confidence };
  return { tissue: "dark", confidence };
}

/** How many voxels fell in each class. Useful for a legend and for a check. */
export function tally(classes: Iterable<TissueClass>): Record<TissueClass, number> {
  const counts: Record<TissueClass, number> = {
    background: 0,
    fat: 0,
    marrow: 0,
    muscle: 0,
    fluid: 0,
    edema: 0,
    dark: 0,
    unknown: 0,
  };
  for (const value of classes) counts[value] += 1;
  return counts;
}
