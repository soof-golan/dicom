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
import { classifyPair, DEFAULT_THRESHOLDS, type Thresholds, type TissueClass } from "./classify.ts";
import { createSampler, sharesFrameOfReference } from "./resample.ts";
import {
  DEFAULT_SCALES,
  fieldFromVolume,
  prepareScales,
  shapeAt,
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
}

export interface StructureOptions {
  readonly rules?: StructureRules;
  readonly thresholds?: Thresholds;
  readonly scales?: readonly number[];
  /** How far to look out from a component, in millimetres. */
  readonly reach?: number;
}

/** Three millimetres reaches past a fat plane into the muscle behind it. */
export const DEFAULT_REACH = 3;

/** The share of a component's length that counts as one end. */
const END_SHARE = 0.3;

const DARK = 6;

const TISSUE_INDEX: Readonly<Record<TissueClass, number>> = {
  background: 0,
  fat: 1,
  marrow: 2,
  muscle: 3,
  fluid: 4,
  edema: 5,
  dark: DARK,
  unknown: 7,
};

const MARROW = TISSUE_INDEX.marrow;
const MUSCLE = TISSUE_INDEX.muscle;
const FAT = TISSUE_INDEX.fat;

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
  if (!sharesFrameOfReference(t1, fatsat)) {
    throw new StructureError("the two series are in different frames of reference");
  }

  const rules = options.rules ?? DEFAULT_STRUCTURE_RULES;
  const warnings: string[] = [];
  const anisotropy = Math.max(...t1.spacing) / Math.min(...t1.spacing);
  if (anisotropy > 4) {
    warnings.push(
      `Voxels are ${anisotropy.toFixed(0)} times longer between slices than across them. ` +
        `Shape read through the thick direction is unreliable.`,
    );
  }

  const tissue = classifyGrid(t1, fatsat, options.thresholds ?? DEFAULT_THRESHOLDS);
  const shapes = readShapes(t1, tissue, options.scales ?? DEFAULT_SCALES);
  const groups = groupByShape(t1.dims, t1.spacing, tissue, shapes.kinds, shapes.confidence);
  const contacts = measureContacts(t1, tissue, groups, options.reach ?? DEFAULT_REACH);

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
      // The component's confidence, scaled by how sure the shape was here. A
      // voxel at a blurred end of a tendon must not claim what its middle does.
      const local = named.confidence * shapes.confidence[index]!;
      if (local < MIN_STRUCTURE_CONFIDENCE) continue;
      labels[index] = label;
      confidence[index] = Math.round(Math.min(1, local) * 255);
      namedVoxels += 1;
    }
  }

  let darkVoxels = 0;
  for (const value of tissue) if (value === DARK) darkVoxels += 1;

  return {
    dims: t1.dims,
    spacing: t1.spacing,
    patientToVoxel: invertAffine(t1.voxelToPatient),
    labels,
    confidence,
    components,
    darkVoxels,
    namedVoxels,
    warnings,
  };
}

/** The tissue class of every voxel of the T1 grid, from both sequences. */
export function classifyGrid(t1: Volume, fatsat: Volume, thresholds: Thresholds): Uint8Array {
  const [nx, ny, nz] = t1.dims;
  const partner = createSampler(fatsat);
  const { min, max } = t1.valueRange;
  const span = max - min || 1;
  const out = new Uint8Array(nx * ny * nz);

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const index = (k * ny + j) * nx + i;
        const point: Vec3 = applyAffine(t1.voxelToPatient, [i, j, k]);
        const own = (t1.data[index]! - min) / span;
        const other = partner.normalizedAt(point);
        out[index] = TISSUE_INDEX[classifyPair({ t1: own, pdfs: other }, thresholds).tissue];
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
function readShapes(volume: Volume, tissue: Uint8Array, scales: readonly number[]): Shapes {
  const [nx, ny, nz] = volume.dims;
  const prepared = prepareScales(fieldFromVolume(volume), scales);
  const kinds = new Uint8Array(tissue.length);
  const confidence = new Float32Array(tissue.length);

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const index = (k * ny + j) * nx + i;
        if (tissue[index] !== DARK) continue;
        const shape = shapeAt(prepared, i, j, k);
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
    if (kind === 0) continue;

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
  const length = splitEnds(voxels, dims, spacing, bucket);

  return {
    id,
    voxels,
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
): number {
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
  return length;
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
 */
function measureContacts(
  volume: Volume,
  tissue: Uint8Array,
  groups: Groups,
  reach: number,
): Map<number, Contacts> {
  const [nx, ny, nz] = volume.dims;
  const steps: readonly (readonly [number, number, number, number])[] = [
    [1, 0, 0, volume.spacing[0]],
    [-1, 0, 0, volume.spacing[0]],
    [0, 1, 0, volume.spacing[1]],
    [0, -1, 0, volume.spacing[1]],
    [0, 0, 1, volume.spacing[2]],
    [0, 0, -1, volume.spacing[2]],
  ];

  const tally = new Map<number, [Counts, Counts, Counts]>();
  for (const group of groups.list) {
    tally.set(group.id, [emptyCounts(), emptyCounts(), emptyCounts()]);
  }

  for (let index = 0; index < tissue.length; index += 1) {
    const id = groups.owner[index]!;
    if (id === -1) continue;
    const buckets = tally.get(id)!;
    const counts = buckets[groups.bucket[index]! as 0 | 1 | 2];
    const k = Math.floor(index / (nx * ny));
    const j = Math.floor((index - k * nx * ny) / nx);
    const i = index - k * nx * ny - j * nx;

    for (const [di, dj, dk, step] of steps) {
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
