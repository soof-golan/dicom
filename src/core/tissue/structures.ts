/**
 * Naming cortex, tendon, ligament, and vessel by form and by neighbour.
 *
 * `classify.ts` reports all of these as one class, `dark`, and that is correct:
 * their signal is identical and it is zero. Cortical bone has a T2* near
 * 0.4 ms and collagen near 1 to 2 ms, and the shortest echo in this study is
 * 11 ms. Flowing blood adds a fourth: on turbo spin echo it leaves the slice
 * between the pulses and returns no signal at all. No threshold separates any
 * of them, because the difference is not in the numbers.
 *
 * This module does not touch the signal rule. It takes what `classify.ts`
 * already called `dark` and asks two further questions that need no signal.
 *
 * 1. What shape is it? `shape.ts` answers from the Hessian: a tube or a plate.
 * 2. What does each END of it touch? Marrow and muscle are named reliably by
 *    signal, so they can act as landmarks.
 *
 * The ends are what separate the four, and they must be tested apart. A tendon
 * and an artery are both dark tubes in soft tissue, and only the attachment
 * tells them apart:
 *
 * - a plate that wraps marrow is the cortical shell of a bone.
 * - a tube with muscle at one end and bone at the other is a tendon.
 * - a tube with bone at both ends and no muscle is a ligament.
 * - a long tube that reaches bone at neither end, running through fat or
 *   muscle, is a vessel.
 *
 * The shape comes from the T1 series, not from the fat-saturated one. Fat is
 * bright on T1 and a tendon is black, so the edge is strong. Fat saturation
 * removes that surround and leaves a dark structure on a dark field.
 *
 * HONESTY: this is a weaker claim than the fat and fluid classes make. Those
 * read a signal difference that physics puts there. These read form and
 * position, which an injury, a partial volume, or a thick slice can change. A
 * component that fits no rule keeps the name `dark`, and the viewer must show
 * that the two kinds of claim are not the same.
 *
 * LIMIT: an artery and a vein are not separable here. This study has no
 * contrast agent, no time of flight, and no phase contrast, and both can show
 * a flow void. The class is `vessel` and it stays that way.
 *
 * LIMIT: a nerve is not in this module's input. Nerve signal sits close to
 * muscle on both sequences, so `classify.ts` calls it muscle, not dark. To
 * find one needs a texture rule over muscle, which is separate work.
 */
import type { Vec3 } from "../geometry/vec3.ts";
import { applyAffine, invertAffine } from "../geometry/vec3.ts";
import type { Volume } from "../volume/build.ts";
import { classifyPair, type Thresholds, type TissueClass } from "./classify.ts";
import { sharesFrameOfReference, trilinear } from "./resample.ts";
import {
  DEFAULT_SCALES,
  fieldFromVolume,
  prepareScales,
  shapeAt,
  type ScalarField,
  type ShapeKind,
} from "./shape.ts";

export type StructureClass = "dark" | "cortex" | "tendon" | "ligament" | "vessel";

export class StructureError extends Error {
  override readonly name = "StructureError";
}

export interface StructureInfo {
  readonly id: StructureClass;
  readonly name: string;
  readonly covers: string;
  /** sRGB, kept apart from the tissue colors so a reader can see the source. */
  readonly color: readonly [number, number, number];
}

export const STRUCTURE_INFO: Readonly<Record<StructureClass, StructureInfo>> = {
  dark: {
    id: "dark",
    name: "Cortex, tendon, ligament, or vessel",
    covers: "Signal is absent on both sequences, and neither shape nor position named it further.",
    color: [0.42, 0.47, 0.6],
  },
  cortex: {
    id: "cortex",
    name: "Cortical bone",
    covers: "A dark plate around bright marrow. Named by shape and position, not by signal.",
    color: [0.62, 0.72, 0.85],
  },
  tendon: {
    id: "tendon",
    name: "Tendon",
    covers:
      "A dark tube with muscle at one end and bone at the other. Named by shape and position, not by signal.",
    color: [0.55, 0.85, 0.62],
  },
  ligament: {
    id: "ligament",
    name: "Ligament",
    covers:
      "A dark tube with bone at both ends and no muscle. Named by shape and position, not by signal.",
    color: [0.85, 0.62, 0.95],
  },
  vessel: {
    id: "vessel",
    name: "Vessel",
    covers:
      "A long dark tube that reaches no bone. Blood that flows gives no signal. Artery and vein cannot be separated in this study.",
    color: [1.0, 0.6, 0.35],
  },
};

/** `dark` is first, so its label index is 0 and an empty grid means nothing named. */
export const STRUCTURE_ORDER: readonly StructureClass[] = [
  "dark",
  "cortex",
  "tendon",
  "ligament",
  "vessel",
];

export function structureIndex(id: StructureClass): number {
  return STRUCTURE_ORDER.indexOf(id);
}

/**
 * The lowest confidence this module will report.
 *
 * Below it the answer falls back to `dark`. A faint color that a reader cannot
 * judge is worse than no color.
 */
export const MIN_STRUCTURE_CONFIDENCE = 0.15;

/**
 * Shape confidence a voxel needs before it can START a component.
 *
 * Every dark structure in an elbow touches its neighbour. If a weak voxel could
 * start a piece, one flood fill would return the whole skeleton as a single
 * blob, because weak voxels lie everywhere and bridge everything.
 */
export const SEED_VOXEL_SHAPE = 0.25;

/**
 * Shape confidence a voxel needs before it can JOIN a component.
 *
 * A tendon fades where a slice cuts it at an angle, so a bar high enough to
 * keep noise out would also cut real structures into pieces. Growing from a
 * strong seed through weaker voxels keeps a structure whole without letting
 * noise begin one. A voxel below this bar stays out and acts as a wall.
 */
export const GROW_VOXEL_SHAPE = 0.08;

/**
 * The least a voxel keeps of its component's confidence.
 *
 * A voxel whose own shape was faint still belongs to the component that the
 * evidence named. It reports less certainty, not none.
 */
export const VOXEL_FADE = 0.6;

export interface StructureRules {
  /** A component smaller than this is noise. */
  readonly minVoxels: number;
  /** How much of the dark tissue around a component must read the same shape. */
  readonly minShapeAgreement: number;
  /** Marrow around a plate, before it counts as a cortical shell. */
  readonly cortexMarrow: number;
  /** Marrow at one end, before that end counts as attached to bone. */
  readonly endBone: number;
  /** Muscle at one end, before that end counts as attached to muscle. */
  readonly endMuscle: number;
  /** A vessel runs a long way. A short tube in fat is not enough. */
  readonly vesselMinLength: number;
  /** Fat and muscle around a vessel, together. */
  readonly vesselSoftTissue: number;
}

export const DEFAULT_STRUCTURE_RULES: StructureRules = {
  minVoxels: 12,
  minShapeAgreement: 0.55,
  cortexMarrow: 0.04,
  endBone: 0.06,
  endMuscle: 0.1,
  vesselMinLength: 15,
  vesselSoftTissue: 0.5,
};

/** What one end of a component runs into, as a share of its readings. */
export interface EndContact {
  readonly marrow: number;
  readonly muscle: number;
}

/** What the naming rule reads. Nothing else about a component matters. */
export interface ComponentEvidence {
  readonly kind: ShapeKind;
  readonly voxels: number;
  /** How much of the dark tissue beside the component reads the same shape. */
  readonly shapeAgreement: number;
  /** Mean shape confidence over the component. */
  readonly shapeConfidence: number;
  /** Share of the whole neighbourhood that is marrow. */
  readonly marrowContact: number;
  /** Share of the whole neighbourhood that is muscle. */
  readonly muscleContact: number;
  /** Share of the whole neighbourhood that is fat. */
  readonly fatContact: number;
  /** The two ends of the long axis, tested apart. */
  readonly ends: readonly [EndContact, EndContact];
  /** Length along the long axis, in millimetres. */
  readonly lengthMillimetres: number;
}

export interface NamedComponent {
  readonly structure: StructureClass;
  /** 0 to 1. Always 0 for `dark`. */
  readonly confidence: number;
  /** Why the rule answered as it did. */
  readonly reason: string;
}

const UNNAMED = (reason: string): NamedComponent => ({
  structure: "dark",
  confidence: 0,
  reason,
});

/** How far past a threshold a value sits, from 0 to 1. */
function past(value: number, threshold: number, span: number): number {
  return Math.min(1, Math.max(0, (value - threshold) / span));
}

/**
 * Name one component from its shape and its neighbours.
 *
 * This is the whole decision, and it reads nothing but `evidence`. Every path
 * that cannot answer returns `dark`, because a wrong name here is worse than
 * no name.
 */
export function nameComponent(
  evidence: ComponentEvidence,
  rules: StructureRules = DEFAULT_STRUCTURE_RULES,
): NamedComponent {
  const { kind, voxels, shapeAgreement, shapeConfidence } = evidence;

  if (voxels < rules.minVoxels) return UNNAMED(`only ${voxels} voxels, too few to trust`);
  if (kind === "none") return UNNAMED("no shape could be read");
  if (kind === "blob") return UNNAMED("the shape is a blob, neither a tube nor a plate");
  if (shapeAgreement < rules.minShapeAgreement) {
    return UNNAMED(`the dark tissue beside it reads a different shape`);
  }

  const base = shapeAgreement * shapeConfidence;
  const answer = (structure: StructureClass, support: number, reason: string): NamedComponent => {
    const confidence = Math.min(1, base * support);
    if (confidence < MIN_STRUCTURE_CONFIDENCE) {
      return UNNAMED(`${reason}, but the confidence is too low`);
    }
    return { structure, confidence, reason };
  };

  if (kind === "sheet") {
    if (evidence.marrowContact < rules.cortexMarrow) {
      return UNNAMED("a plate, but it wraps no marrow");
    }
    return answer(
      "cortex",
      past(evidence.marrowContact, rules.cortexMarrow, 0.1),
      "a plate around marrow",
    );
  }

  const [first, second] = evidence.ends;
  const boneFirst = first.marrow >= rules.endBone;
  const boneSecond = second.marrow >= rules.endBone;
  const muscleFirst = first.muscle >= rules.endMuscle;
  const muscleSecond = second.muscle >= rules.endMuscle;

  if (boneFirst && boneSecond && !muscleFirst && !muscleSecond) {
    return answer(
      "ligament",
      past(Math.min(first.marrow, second.marrow), rules.endBone, 0.1),
      "a tube with bone at both ends and no muscle",
    );
  }

  if ((muscleFirst && boneSecond) || (muscleSecond && boneFirst)) {
    return answer(
      "tendon",
      past(Math.max(first.muscle, second.muscle), rules.endMuscle, 0.2),
      "a tube with muscle at one end and bone at the other",
    );
  }

  const soft = evidence.fatContact + evidence.muscleContact;
  if (
    !boneFirst &&
    !boneSecond &&
    evidence.lengthMillimetres >= rules.vesselMinLength &&
    soft >= rules.vesselSoftTissue
  ) {
    return answer(
      "vessel",
      past(soft, rules.vesselSoftTissue, 0.3),
      "a long tube through soft tissue that reaches no bone",
    );
  }

  return UNNAMED("a tube, but its ends name neither a tendon, a ligament, nor a vessel");
}

export interface ComponentReport extends ComponentEvidence, NamedComponent {
  readonly id: number;
}

export interface StructureField {
  readonly dims: readonly [number, number, number];
  readonly spacing: readonly [number, number, number];
  /** Patient millimetres to a voxel of this grid. */
  readonly patientToVoxel: readonly number[];
  /** An index into `STRUCTURE_ORDER`. 0 means the class stays `dark`. */
  readonly labels: Uint8Array;
  /** 0 to 255. Always 0 where the label is 0. */
  readonly confidence: Uint8Array;
  readonly components: readonly ComponentReport[];
  readonly darkVoxels: number;
  readonly namedVoxels: number;
  /** Facts a reader must know before trusting the labels. */
  readonly warnings: readonly string[];
}

export interface SequenceVolumes {
  readonly t1: Volume;
  readonly fatsat: Volume;
  /**
   * The volume whose grid carries the shape and the labels. Defaults to `t1`.
   *
   * A fused volume with cubic voxels belongs here. Shape needs equal steps
   * along every axis, and the signal rule does not: it reads one voxel at a
   * time, so it can sample the two sequences wherever this grid puts them.
   */
  readonly shapeVolume?: Volume;
}

export interface StructureOptions {
  readonly rules?: StructureRules;
  /** Band edges for the T1 sequence. Defaults to the classifier's own. */
  readonly t1Bands?: Thresholds;
  /** Band edges for the fat-saturated sequence. */
  readonly fatBands?: Thresholds;
  readonly scales?: readonly number[];
  /** How far to look out from a component, in millimetres. */
  readonly reach?: number;
}

/**
 * How far a ray looks for a named tissue, in millimetres.
 *
 * A ligament ends on cortical bone, and cortical bone is dark as well, so the
 * ray must cross the whole shell before marrow answers. Three millimetres stops
 * inside the shell and reports nothing. Eight reaches the marrow behind it.
 */
export const DEFAULT_REACH = 8;

/** The share of a component's length that counts as one end. */
const END_SHARE = 0.3;

const DARK = 6;

const TISSUE_INDEX: Readonly<Record<TissueClass, number>> = {
  background: 0,
  fat: 1,
  muscle: 3,
  fluid: 4,
  edema: 5,
  dark: DARK,
  unknown: 7,
};

/**
 * Marrow, which the signal rule no longer reports on its own.
 *
 * `classify.ts` calls marrow `fat`, and correctly: both are fat, and their
 * signal is the same. But this module needs bone as a landmark, and fat that
 * lies inside a bone is the only sign of bone that signal offers.
 *
 * So marrow is recovered by geometry instead. See `markMarrow`.
 */
const MARROW = 2;

const MUSCLE = TISSUE_INDEX.muscle;
const FAT = TISSUE_INDEX.fat;

/** A pocket of fat smaller than this is noise, not a medullary cavity. */
const MIN_MARROW_VOXELS = 200;

/**
 * Enclosed fat below this leaves bone too weak to act as a landmark.
 *
 * The three bones of an elbow hold tens of thousands of voxels of marrow at
 * this resolution. A tenth of that means the shell leaked.
 */
const MIN_MARROW_FOR_BONE = 20_000;

/**
 * Find the fat that lies inside a bone, and mark it as marrow.
 *
 * Subcutaneous fat and the fat between muscles all join up and reach the
 * outside of the arm. Medullary fat does not: a cortical shell encloses it.
 *
 * So a flood fill started from every edge of the volume, travelling through
 * everything EXCEPT dark tissue, reaches all the fat outside bone and none of
 * the fat inside it. Only a dark wall stops the fill, and a cortical shell is
 * the only dark wall that closes around fat. What the fill never reaches is
 * marrow.
 *
 * The fill must cross air and muscle, not only fat. The edge of the volume is
 * air, so a fill that moved through fat alone would start nowhere and would
 * call every fat voxel in the arm marrow.
 *
 * This is geometry, not signal, and the same caution applies: a shell with a
 * gap leaks, and then the marrow behind it joins the outside and is not marked.
 *
 * MEASURED, AND IT DOES NOT WORK ON THIS STUDY. The signal rule that this
 * replaced found 27 cm3 of marrow. Enclosure finds 1.2 cm3, which is a
 * twentieth of it, so the wall leaks nearly everywhere.
 *
 * A grid with cubic voxels does not repair it. On the fused volume enclosure
 * finds NOTHING at all, and growing the dark wall by one or two voxels does not
 * help on either grid. It makes the native result worse, from 1.2 to 0.3 cm3,
 * because the growth eats the thin pockets it was meant to seal.
 *
 * The reason is that no fusion can add what was never measured. The study holds
 * three fat-saturated orientations but only ONE T1, and `dark` needs both
 * sequences to be low. So the dark class carries the 3.3 mm step of the T1
 * everywhere, whatever grid it is read on. Reading that T1 at 0.71 mm only
 * interpolates a ramp across the cortex, and the middle of the ramp is not
 * dark, which opens the wall in every direction at once.
 *
 * Closing the wall needs a second T1 orientation, or a sequence that resolves
 * cortex through the slice. This study has neither.
 */
export function markMarrow(dims: readonly [number, number, number], tissue: Uint8Array): number {
  const [nx, ny, nz] = dims;
  const wall = closedDarkWall(dims, tissue);
  const reached = new Uint8Array(tissue.length);
  const stack: number[] = [];

  const consider = (i: number, j: number, k: number): void => {
    const index = (k * ny + j) * nx + i;
    if (reached[index] === 1 || wall[index] === 1) return;
    reached[index] = 1;
    stack.push(index);
  };

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const onEdge =
          i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
        if (onEdge) consider(i, j, k);
      }
    }
  }

  while (stack.length > 0) {
    const index = stack.pop()!;
    const k = Math.floor(index / (nx * ny));
    const j = Math.floor((index - k * nx * ny) / nx);
    const i = index - k * nx * ny - j * nx;
    for (const [di, dj, dk] of NEIGHBOURS) {
      const x = i + di;
      const y = j + dj;
      const z = k + dk;
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      consider(x, y, z);
    }
  }

  // Every pocket of fat the fill missed. Small pockets are noise, so each one
  // is measured before it counts.
  const owner = new Int32Array(tissue.length).fill(-1);
  let marrowVoxels = 0;
  for (let start = 0; start < tissue.length; start += 1) {
    if (tissue[start] !== FAT || reached[start] === 1 || owner[start] !== -1) continue;
    const pocket: number[] = [start];
    owner[start] = start;
    const walk: number[] = [start];
    while (walk.length > 0) {
      const index = walk.pop()!;
      const k = Math.floor(index / (nx * ny));
      const j = Math.floor((index - k * nx * ny) / nx);
      const i = index - k * nx * ny - j * nx;
      for (const [di, dj, dk] of NEIGHBOURS) {
        const x = i + di;
        const y = j + dj;
        const z = k + dk;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const next = (z * ny + y) * nx + x;
        if (tissue[next] !== FAT || reached[next] === 1 || owner[next] !== -1) continue;
        owner[next] = start;
        pocket.push(next);
        walk.push(next);
      }
    }
    if (pocket.length < MIN_MARROW_VOXELS) continue;
    for (const index of pocket) tissue[index] = MARROW;
    marrowVoxels += pocket.length;
  }
  return marrowVoxels;
}

/**
 * The dark mask, with one-voxel holes closed.
 *
 * A cortical shell is one to two voxels thick in places, and a partial volume
 * at a slice edge can leave a hole in it. One hole lets the fill through, and
 * then the whole medullary cavity reads as outside fat.
 *
 * So a voxel counts as wall when it is dark, or when dark lies on BOTH sides of
 * it along any axis. That plugs a one-voxel gap and leaves an open gap open.
 */
function closedDarkWall(dims: readonly [number, number, number], tissue: Uint8Array): Uint8Array {
  const [nx, ny, nz] = dims;
  const wall = new Uint8Array(tissue.length);
  const dark = (i: number, j: number, k: number): boolean => {
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
    return tissue[(k * ny + j) * nx + i] === DARK;
  };

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const index = (k * ny + j) * nx + i;
        if (tissue[index] === DARK) {
          wall[index] = 1;
          continue;
        }
        const pinched =
          (dark(i - 1, j, k) && dark(i + 1, j, k)) ||
          (dark(i, j - 1, k) && dark(i, j + 1, k)) ||
          (dark(i, j, k - 1) && dark(i, j, k + 1));
        if (pinched) wall[index] = 1;
      }
    }
  }
  return wall;
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Name the dark structures of one T1 and fat-saturated pair.
 *
 * @throws {StructureError} when the two series are in different frames of
 * reference. Their patient coordinates would then mean different things.
 */
export function findStructures(
  pair: SequenceVolumes,
  options: StructureOptions = {},
): StructureField {
  const { t1, fatsat } = pair;
  const grid = pair.shapeVolume ?? t1;
  for (const volume of [fatsat, grid]) {
    if (!sharesFrameOfReference(t1, volume)) {
      throw new StructureError("the series are in different frames of reference");
    }
  }

  const rules = options.rules ?? DEFAULT_STRUCTURE_RULES;
  const warnings: string[] = [...grid.warnings];
  const anisotropy = Math.max(...grid.spacing) / Math.min(...grid.spacing);
  if (anisotropy > 4) {
    warnings.push(
      `Voxels are ${anisotropy.toFixed(0)} times longer between slices than across them. ` +
        `Shape read through the thick direction is unreliable.`,
    );
  }

  const signal = fieldFromVolume(grid);
  const tissue = classifyGrid(grid, t1, fatsat, options.t1Bands, options.fatBands);
  const marrowVoxels = markMarrow(grid.dims, tissue);
  // Bone is the landmark that names cortex, tendon, and ligament. The signal
  // rule reports marrow as fat, so this module recovers it by enclosure. When
  // little is enclosed, the cortical shell has gaps and those three go unnamed.
  if (marrowVoxels < MIN_MARROW_FOR_BONE) {
    warnings.push(
      `Only ${marrowVoxels} voxels of fat lie enclosed by bone, so bone is a weak landmark here. ` +
        `Cortex, tendon, and ligament will mostly stay unnamed.`,
    );
  }
  const shapes = readShapes(signal, tissue, options.scales ?? DEFAULT_SCALES);
  const groups = groupByShape(grid.dims, grid.spacing, tissue, shapes.kinds, shapes.confidence);
  const contacts = measureContacts(grid, tissue, groups, options.reach ?? DEFAULT_REACH);

  const labels = new Uint8Array(tissue.length);
  const confidence = new Uint8Array(tissue.length);
  const components: ComponentReport[] = [];
  let namedVoxels = 0;

  for (const group of groups.list) {
    const evidence: ComponentEvidence = { ...group.evidence, ...contacts.get(group.id)! };
    const named = nameComponent(evidence, rules);
    components.push({ id: group.id, ...evidence, ...named });
    if (named.structure === "dark") continue;

    const label = structureIndex(named.structure);
    for (const index of group.voxels) {
      // The component already earned its confidence, and that score already
      // holds the mean shape confidence. Multiplying by the voxel's own shape
      // confidence again would count the same doubt twice, and almost every
      // voxel would fall under the floor. So the voxel keeps the component's
      // score, faded where its own shape was less clear than the seed bar.
      const clarity = Math.min(1, shapes.confidence[index]! / SEED_VOXEL_SHAPE);
      const local = named.confidence * (VOXEL_FADE + (1 - VOXEL_FADE) * clarity);
      labels[index] = label;
      confidence[index] = Math.round(Math.min(1, local) * 255);
      namedVoxels += 1;
    }
  }

  let darkVoxels = 0;
  for (const value of tissue) if (value === DARK) darkVoxels += 1;

  return {
    dims: grid.dims,
    spacing: grid.spacing,
    patientToVoxel: invertAffine(grid.voxelToPatient),
    labels,
    confidence,
    components,
    darkVoxels,
    namedVoxels,
    warnings,
  };
}

/**
 * The tissue class at every voxel of a grid, read from both sequences.
 *
 * The grid need not be either series. Every reading goes through patient
 * millimetres, which is the one thing the series share.
 *
 * Both sequences go onto their own percentile scale first, the same scale the
 * shader uses. MRI signal is not calibrated the way a CT number is, so the two
 * share no unit. Dividing by the brightest voxel instead would divide by noise,
 * and then all the tissue lands near zero and reads as dark.
 */
export function classifyGrid(
  grid: Volume,
  t1: Volume,
  fatsat: Volume,
  t1Bands?: Thresholds,
  fatBands?: Thresholds,
): Uint8Array {
  const [nx, ny, nz] = grid.dims;
  const sequences = [t1, fatsat].map((volume) => ({
    field: fieldFromVolume(volume),
    patientToVoxel: invertAffine(volume.voxelToPatient),
  }));
  const out = new Uint8Array(nx * ny * nz);

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const index = (k * ny + j) * nx + i;
        const point: Vec3 = applyAffine(grid.voxelToPatient, [i, j, k]);
        const [own, other] = sequences.map((sequence) =>
          trilinear(sequence.field, applyAffine(sequence.patientToVoxel, point)),
        );
        out[index] = TISSUE_INDEX[classifyPair({ t1: own, pdfs: other }, t1Bands, fatBands).tissue];
      }
    }
  }
  return out;
}

interface Shapes {
  readonly kinds: Uint8Array;
  readonly confidence: Float32Array;
}

const KIND_INDEX: Readonly<Record<ShapeKind, number>> = { none: 0, tube: 1, sheet: 2, blob: 3 };
const KIND_OF: readonly ShapeKind[] = ["none", "tube", "sheet", "blob"];

/** The shape at every dark voxel. A voxel of any other class is left as `none`. */
function readShapes(signal: ScalarField, tissue: Uint8Array, scales: readonly number[]): Shapes {
  const [nx, ny, nz] = signal.dims;
  const prepared = prepareScales(signal, scales);
  const kinds = new Uint8Array(tissue.length);
  const confidence = new Float32Array(tissue.length);

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const index = (k * ny + j) * nx + i;
        if (tissue[index] !== DARK) continue;
        const shape = shapeAt(prepared, i, j, k);
        if (shape.confidence < GROW_VOXEL_SHAPE) continue;
        kinds[index] = KIND_INDEX[shape.kind];
        confidence[index] = shape.confidence;
      }
    }
  }
  return { kinds, confidence };
}

interface Group {
  readonly id: number;
  readonly voxels: number[];
  /** Unit direction from end 0 to end 2, in millimetre space. */
  readonly axis: Vec3;
  readonly evidence: Omit<
    ComponentEvidence,
    "marrowContact" | "muscleContact" | "fatContact" | "ends"
  >;
}

interface Groups {
  readonly list: readonly Group[];
  readonly owner: Int32Array;
  readonly bucket: Uint8Array;
}

/**
 * Split the dark voxels into pieces that agree about shape.
 *
 * Every dark structure in an elbow touches its neighbour, so one flood fill
 * over the dark mask returns one piece that holds the whole skeleton. Growing
 * only through voxels of the same shape breaks it where a tendon meets its
 * insertion, which is where the anatomy changes too.
 */
function groupByShape(
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  tissue: Uint8Array,
  kinds: Uint8Array,
  shapeConfidence: Float32Array,
): Groups {
  const [nx, ny, nz] = dims;
  const owner = new Int32Array(tissue.length).fill(-1);
  const bucket = new Uint8Array(tissue.length);
  const list: Group[] = [];
  const stack: number[] = [];

  for (let start = 0; start < tissue.length; start += 1) {
    if (owner[start] !== -1 || tissue[start] !== DARK) continue;
    const kind = kinds[start]!;
    // Only a voxel sure of its shape may start a piece. Weaker voxels can join
    // one, so a structure stays whole, but they cannot begin one.
    if (kind === 0 || shapeConfidence[start]! < SEED_VOXEL_SHAPE) continue;

    const id = list.length;
    const voxels: number[] = [];
    owner[start] = id;
    stack.push(start);

    while (stack.length > 0) {
      const index = stack.pop()!;
      voxels.push(index);
      const k = Math.floor(index / (nx * ny));
      const j = Math.floor((index - k * nx * ny) / nx);
      const i = index - k * nx * ny - j * nx;

      for (let dk = -1; dk <= 1; dk += 1) {
        for (let dj = -1; dj <= 1; dj += 1) {
          for (let di = -1; di <= 1; di += 1) {
            const x = i + di;
            const y = j + dj;
            const z = k + dk;
            if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
            const next = (z * ny + y) * nx + x;
            if (owner[next] !== -1 || tissue[next] !== DARK || kinds[next] !== kind) continue;
            owner[next] = id;
            stack.push(next);
          }
        }
      }
    }
    list.push(describe(id, kind, voxels, dims, spacing, kinds, tissue, shapeConfidence, bucket));
  }
  return { list, owner, bucket };
}

function describe(
  id: number,
  kind: number,
  voxels: number[],
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  kinds: Uint8Array,
  tissue: Uint8Array,
  shapeConfidence: Float32Array,
  bucket: Uint8Array,
): Group {
  let sum = 0;
  for (const index of voxels) sum += shapeConfidence[index]!;
  const { length, axis } = splitEnds(voxels, dims, spacing, bucket);

  return {
    id,
    voxels,
    axis,
    evidence: {
      kind: KIND_OF[kind]!,
      voxels: voxels.length,
      shapeAgreement: neighbourAgreement(voxels, kinds, tissue, kind),
      shapeConfidence: sum / Math.max(voxels.length, 1),
      lengthMillimetres: length,
    },
  };
}

/**
 * Mark the two ends of a component, and measure its length in millimetres.
 *
 * The long axis runs from the middle of the component to the voxel farthest
 * from it. For a tube that is the direction the tube runs, which is the only
 * direction whose two ends mean anything.
 *
 * Every distance is in millimetres, so a 3.3 mm slice step counts for what it
 * is. In voxel steps the slice axis would look 12 times shorter than it is, and
 * a tendon that runs through the slices would read as a stub.
 */
export function splitEnds(
  voxels: readonly number[],
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  bucket: Uint8Array,
): { length: number; axis: Vec3 } {
  const [nx, ny] = dims;
  const [sx, sy, sz] = spacing;
  const at = (index: number): Vec3 => {
    const k = Math.floor(index / (nx * ny));
    const j = Math.floor((index - k * nx * ny) / nx);
    return [(index - k * nx * ny - j * nx) * sx, j * sy, k * sz];
  };

  const centre: [number, number, number] = [0, 0, 0];
  for (const index of voxels) {
    const p = at(index);
    centre[0] += p[0];
    centre[1] += p[1];
    centre[2] += p[2];
  }
  for (let axis = 0; axis < 3; axis += 1) centre[axis]! /= voxels.length;

  let farthest = voxels[0]!;
  let best = -1;
  for (const index of voxels) {
    const p = at(index);
    const distance = (p[0] - centre[0]) ** 2 + (p[1] - centre[1]) ** 2 + (p[2] - centre[2]) ** 2;
    if (distance > best) {
      best = distance;
      farthest = index;
    }
  }

  const tip = at(farthest);
  const axis: Vec3 = [tip[0] - centre[0], tip[1] - centre[1], tip[2] - centre[2]];
  const size = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const along = (index: number): number => {
    const p = at(index);
    return (
      ((p[0] - centre[0]) * axis[0] + (p[1] - centre[1]) * axis[1] + (p[2] - centre[2]) * axis[2]) /
      size
    );
  };

  let low = Infinity;
  let high = -Infinity;
  for (const index of voxels) {
    const t = along(index);
    if (t < low) low = t;
    if (t > high) high = t;
  }

  const length = high - low;
  const edge = length * END_SHARE;
  for (const index of voxels) {
    const t = along(index);
    bucket[index] = t <= low + edge ? 0 : t >= high - edge ? 2 : 1;
  }
  // Bucket 2 lies toward the tip, so the unit axis points from end 0 to end 2.
  return { length, axis: [axis[0] / size, axis[1] / size, axis[2] / size] };
}

/**
 * How much the dark tissue around a group reads as the same shape.
 *
 * A true tendon is a tube for its whole length, so the dark voxels beside it
 * read as tubes too. A group that only its own voxels support sits on noise.
 */
function neighbourAgreement(
  voxels: readonly number[],
  kinds: Uint8Array,
  tissue: Uint8Array,
  kind: number,
): number {
  let same = 0;
  let all = 0;
  for (const index of voxels) {
    for (const step of [-1, 1]) {
      const next = index + step;
      if (next < 0 || next >= tissue.length || tissue[next] !== DARK) continue;
      all += 1;
      if (kinds[next] === kind) same += 1;
    }
  }
  return all === 0 ? 0 : same / all;
}

type Contacts = Pick<ComponentEvidence, "marrowContact" | "muscleContact" | "fatContact" | "ends">;

interface Counts {
  marrow: number;
  muscle: number;
  fat: number;
  total: number;
}

const emptyCounts = (): Counts => ({ marrow: 0, muscle: 0, fat: 0, total: 0 });

/**
 * What each group runs into, for the whole group and for each end apart.
 *
 * From every voxel, walk outward along the six axis directions. Keep walking
 * while the tissue stays dark, and record the first named tissue reached. This
 * asks what a structure abuts, which is the question the rules need, and it
 * costs far less than growing the whole group outward.
 *
 * At an end, only the rays that leave along the long axis count. What lies
 * BESIDE a tendon is not what it attaches to: at the elbow, muscle lies beside
 * a collateral ligament for its whole length, and counting that muscle would
 * name every ligament a tendon. What lies BEYOND the tip is the attachment.
 */
function measureContacts(
  volume: Volume,
  tissue: Uint8Array,
  groups: Groups,
  reach: number,
): Map<number, Contacts> {
  const [nx, ny, nz] = volume.dims;
  const [sx, sy, sz] = volume.spacing;
  const steps: readonly (readonly [number, number, number, number])[] = [
    [1, 0, 0, sx],
    [-1, 0, 0, sx],
    [0, 1, 0, sy],
    [0, -1, 0, sy],
    [0, 0, 1, sz],
    [0, 0, -1, sz],
  ];
  // A ray counts as leaving along the axis when it is within 70 degrees of it.
  // A narrower cone leaves an end with one ray out of six, and one ray that
  // happens to stop in dark tissue then reports nothing at all.
  const ALONG_AXIS = 0.3;

  const tally = new Map<number, [Counts, Counts, Counts]>();
  const axes = new Map<number, Vec3>();
  for (const group of groups.list) {
    tally.set(group.id, [emptyCounts(), emptyCounts(), emptyCounts()]);
    axes.set(group.id, group.axis);
  }

  for (let index = 0; index < tissue.length; index += 1) {
    const id = groups.owner[index]!;
    if (id === -1) continue;
    const buckets = tally.get(id)!;
    const bucket = groups.bucket[index]! as 0 | 1 | 2;
    const counts = buckets[bucket];
    const axis = axes.get(id)!;
    const k = Math.floor(index / (nx * ny));
    const j = Math.floor((index - k * nx * ny) / nx);
    const i = index - k * nx * ny - j * nx;

    for (const [di, dj, dk, step] of steps) {
      if (bucket !== 1) {
        // End 0 lies against the axis, end 2 along it. One step along an index
        // axis is one unit along the same axis in millimetre space, so the two
        // vectors compare directly.
        const outward = bucket === 2 ? 1 : -1;
        const alignment = (di * axis[0] + dj * axis[1] + dk * axis[2]) * outward;
        if (alignment < ALONG_AXIS) continue;
      }
      const limit = Math.max(1, Math.floor(reach / step));
      for (let t = 1; t <= limit; t += 1) {
        const x = i + di * t;
        const y = j + dj * t;
        const z = k + dk * t;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) break;
        const at = tissue[(z * ny + y) * nx + x]!;
        if (at === DARK) continue;
        counts.total += 1;
        if (at === MARROW) counts.marrow += 1;
        if (at === MUSCLE) counts.muscle += 1;
        if (at === FAT) counts.fat += 1;
        break;
      }
    }
  }

  const share = (counts: Counts): EndContact => ({
    marrow: counts.marrow / Math.max(counts.total, 1),
    muscle: counts.muscle / Math.max(counts.total, 1),
  });

  const result = new Map<number, Contacts>();
  for (const [id, buckets] of tally) {
    const whole = buckets.reduce<Counts>(
      (sum, counts) => ({
        marrow: sum.marrow + counts.marrow,
        muscle: sum.muscle + counts.muscle,
        fat: sum.fat + counts.fat,
        total: sum.total + counts.total,
      }),
      emptyCounts(),
    );
    const total = Math.max(whole.total, 1);
    result.set(id, {
      marrowContact: whole.marrow / total,
      muscleContact: whole.muscle / total,
      fatContact: whole.fat / total,
      ends: [share(buckets[0]), share(buckets[2])],
    });
  }
  return result;
}
