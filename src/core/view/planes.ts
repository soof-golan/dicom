/**
 * The cut planes that the viewer shows.
 *
 * A plane is defined in patient millimeters, not in voxels. That is what lets
 * the viewer cut at any angle: the shader walks from a screen pixel to a point
 * in the patient, and only then to a voxel. Nothing is resampled first.
 */
import { describeDirection } from "../geometry/anatomy.ts";
import {
  add,
  applyAffine,
  cross,
  dot,
  normalize,
  scale,
  subtract,
  type Vec3,
} from "../geometry/vec3.ts";
import type { Volume } from "../volume/build.ts";

export type PlaneId = "axial" | "coronal" | "sagittal";

export const PLANE_IDS: readonly PlaneId[] = ["axial", "coronal", "sagittal"];

export interface EdgeLabels {
  readonly top: string;
  readonly bottom: string;
  readonly left: string;
  readonly right: string;
}

export interface CutPlane {
  readonly id: PlaneId;
  readonly label: string;
  /** Patient coordinates of the center of the view. */
  readonly origin: Vec3;
  /** Unit vector that points right on screen. */
  readonly u: Vec3;
  /** Unit vector that points down on screen. */
  readonly v: Vec3;
  readonly normal: Vec3;
  /** Width and height of the view, in millimeters. */
  readonly size: readonly [number, number];
  readonly edges: EdgeLabels;
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly center: Vec3;
  readonly size: Vec3;
  /** Longest diagonal, in millimeters. */
  readonly diagonal: number;
}

/**
 * The box in patient space that holds every voxel.
 *
 * The volume is a rotated box, so its patient-aligned bounds come from the
 * eight corners, not from the dimensions.
 */
export function patientBounds(volume: Volume): Bounds {
  const [nx, ny, nz] = volume.dims;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const i of [-0.5, nx - 0.5]) {
    for (const j of [-0.5, ny - 0.5]) {
      for (const k of [-0.5, nz - 0.5]) {
        const corner = applyAffine(volume.voxelToPatient, [i, j, k]);
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis]!, corner[axis]!);
          max[axis] = Math.max(max[axis]!, corner[axis]!);
        }
      }
    }
  }

  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size,
    diagonal: Math.hypot(size[0], size[1], size[2]),
  };
}

/**
 * Screen axes for the three standard views, in DICOM patient coordinates.
 *
 * These follow radiological convention. The patient's left appears on the right
 * of the screen in the axial and coronal views. The sagittal view looks at the
 * patient from their left side.
 */
const STANDARD: Record<PlaneId, { u: Vec3; v: Vec3; label: string }> = {
  // Looking from the feet: right to left across, anterior to posterior down.
  axial: { u: [1, 0, 0], v: [0, 1, 0], label: "Axial" },
  // Looking from the front: right to left across, superior to inferior down.
  coronal: { u: [1, 0, 0], v: [0, 0, -1], label: "Coronal" },
  // Looking from the left: anterior to posterior across, superior down.
  sagittal: { u: [0, 1, 0], v: [0, 0, -1], label: "Sagittal" },
};

function labelsFor(u: Vec3, v: Vec3): EdgeLabels {
  const flip = (w: Vec3): Vec3 => [-w[0], -w[1], -w[2]];
  return {
    right: describeDirection(u),
    left: describeDirection(flip(u)),
    bottom: describeDirection(v),
    top: describeDirection(flip(v)),
  };
}

/** Size a view so the whole volume fits, whatever angle the plane sits at. */
function fitSize(bounds: Bounds, u: Vec3, v: Vec3): [number, number] {
  const project = (axis: Vec3): number =>
    Math.abs(axis[0] * bounds.size[0]) +
    Math.abs(axis[1] * bounds.size[1]) +
    Math.abs(axis[2] * bounds.size[2]);
  return [project(u), project(v)];
}

/** No shift of the view inside its own plane. */
export const NO_PAN: readonly [number, number] = [0, 0];

/**
 * One standard view.
 *
 * The cursor decides the depth of the cut and nothing else. Where the view sits
 * inside its own plane comes from the middle of the volume, plus the pan that
 * the user set.
 *
 * Keeping these apart is what makes clicking predictable. If the cursor also
 * decided the middle of the view, every click would recenter the image under
 * the pointer, and a drag would make the image chase the pointer.
 */
export function standardPlane(
  volume: Volume,
  id: PlaneId,
  cursor: Vec3,
  pan: readonly [number, number] = NO_PAN,
): CutPlane {
  const bounds = patientBounds(volume);
  const { u, v, label } = STANDARD[id];
  const [width, height] = fitSize(bounds, u, v);
  const normal = normalize(cross(u, v));

  // Take the middle of the volume, drop its depth, then put the cursor depth on.
  const middle = bounds.center;
  const inPlane = subtract(middle, scale(normal, dot(middle, normal)));
  const origin = add(
    add(inPlane, scale(normal, dot(cursor, normal))),
    add(scale(u, pan[0]), scale(v, pan[1])),
  );

  return {
    id,
    label,
    origin,
    u,
    v,
    normal,
    size: [width, height],
    edges: labelsFor(u, v),
  };
}

export function standardPlanes(
  volume: Volume,
  cursor: Vec3,
  pan?: Readonly<Record<PlaneId, readonly [number, number]>>,
): CutPlane[] {
  return PLANE_IDS.map((id) => standardPlane(volume, id, cursor, pan?.[id]));
}

/**
 * Where the cursor sits inside a view, as a fraction of the view from its
 * middle. The crosshair is drawn at this point.
 */
export function cursorInPlane(plane: CutPlane, cursor: Vec3): { x: number; y: number } {
  const offset = subtract(cursor, plane.origin);
  return {
    x: dot(offset, plane.u) / plane.size[0],
    y: dot(offset, plane.v) / plane.size[1],
  };
}

/**
 * Turn a plane into the four numbers a clipping test needs.
 *
 * The result is `[nx, ny, nz, d]`, so a point is on the hidden side when
 * `dot(n, point) + d > 0`.
 */
export function clipEquation(plane: CutPlane, flipped: boolean): [number, number, number, number] {
  const sign = flipped ? -1 : 1;
  const n: Vec3 = [plane.normal[0] * sign, plane.normal[1] * sign, plane.normal[2] * sign];
  return [n[0], n[1], n[2], -dot(n, plane.origin)];
}

/** Keep a point inside the volume's box. */
export function clampToBounds(bounds: Bounds, point: Vec3): Vec3 {
  return [
    Math.min(Math.max(point[0], bounds.min[0]), bounds.max[0]),
    Math.min(Math.max(point[1], bounds.min[1]), bounds.max[1]),
    Math.min(Math.max(point[2], bounds.min[2]), bounds.max[2]),
  ];
}

/**
 * Pick a window that shows the whole volume.
 *
 * A DICOM file carries a suggested window, but the scanner computes it per
 * slice. The first slice of a stack is usually mostly noise, so its suggestion
 * blows out the middle of the scan. This reads the data instead.
 *
 * The window runs from the 1st to the 99.5th percentile of the voxels. The top
 * half percent is dropped because a few very bright voxels, from fat or from a
 * flow artifact, would otherwise darken everything else.
 */
/**
 * Where most of the signal sits, as a fraction of the stored range.
 *
 * MRI signal is not calibrated. One sequence can peak at 900 and another at
 * 4000 for the same tissue, and both carry a thin bright tail from noise and
 * flowing blood. So the lowest and highest stored values say almost nothing
 * about where tissue sits, and anything scaled by them lands too low.
 *
 * The percentiles say it instead. The result is 0 to 1 across the stored
 * range, which is the same unit the GPU texture holds, so the shader can use
 * it without any further conversion.
 */
export function percentileRange(
  volume: Volume,
  lowFraction = 0.01,
  highFraction = 0.995,
  sampleStride = 7,
): { low: number; high: number } {
  const { min, max } = volume.valueRange;
  const span = max - min;
  if (span <= 0) return { low: 0, high: 1 };

  const BINS = 1024;
  const histogram = new Uint32Array(BINS);
  const scale = (BINS - 1) / span;
  let counted = 0;
  for (let i = 0; i < volume.data.length; i += sampleStride) {
    histogram[Math.round((volume.data[i]! - min) * scale)]! += 1;
    counted += 1;
  }

  const at = (fraction: number): number => {
    let target = counted * fraction;
    for (let bin = 0; bin < BINS; bin += 1) {
      target -= histogram[bin]!;
      if (target <= 0) return bin / (BINS - 1);
    }
    return 1;
  };

  const low = at(lowFraction);
  const high = at(highFraction);
  return { low, high: Math.max(high, low + 1e-4) };
}

export function autoWindow(volume: Volume, sampleStride = 7): { center: number; width: number } {
  const { min, max } = volume.valueRange;
  const span = max - min;
  if (span <= 0) return { center: min, width: 1 };

  const fraction = percentileRange(volume, 0.01, 0.995, sampleStride);
  const toValue = (normalized: number): number =>
    (min + normalized * span) * volume.rescaleSlope + volume.rescaleIntercept;
  const width = Math.max(toValue(fraction.high) - toValue(fraction.low), 1);
  return { center: toValue(fraction.low) + width / 2, width };
}

/**
 * The window to open a volume with.
 *
 * The measured window wins when the file's own suggestion would clip most of
 * the data. A suggestion that covers less than a third of the measured range
 * usually came from a slice of pure noise.
 */
export function defaultWindow(volume: Volume): { center: number; width: number } {
  const measured = autoWindow(volume);
  const { windowCenter, windowWidth } = volume;
  if (windowCenter === undefined || windowWidth === undefined) return measured;
  if (windowWidth < measured.width / 3) return measured;
  return { center: windowCenter, width: windowWidth };
}
