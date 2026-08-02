/**
 * Anatomical directions in the DICOM patient coordinate system.
 *
 * DICOM uses LPS: +x points to the patient's Left, +y points Posterior, and
 * +z points Superior. Every label in the viewer comes from this one fact.
 */
import { dot, normalize, type Vec3 } from "./vec3.ts";

export type AxisCode = "L" | "R" | "A" | "P" | "S" | "I";

export interface AxisLabel {
  readonly code: AxisCode;
  readonly name: string;
  readonly direction: Vec3;
}

export const AXIS_LABELS: readonly AxisLabel[] = [
  { code: "R", name: "Right", direction: [-1, 0, 0] },
  { code: "L", name: "Left", direction: [1, 0, 0] },
  { code: "A", name: "Anterior", direction: [0, -1, 0] },
  { code: "P", name: "Posterior", direction: [0, 1, 0] },
  { code: "I", name: "Inferior", direction: [0, 0, -1] },
  { code: "S", name: "Superior", direction: [0, 0, 1] },
];

/** The single anatomical direction closest to a vector. */
export function nearestAxis(direction: Vec3): AxisLabel {
  const unit = normalize(direction);
  let best = AXIS_LABELS[0]!;
  let bestScore = -Infinity;
  for (const label of AXIS_LABELS) {
    const score = dot(unit, label.direction);
    if (score > bestScore) {
      bestScore = score;
      best = label;
    }
  }
  return best;
}

/**
 * Spell out a direction, strongest component first.
 *
 * A vector that points mostly to the left and a little superior reads "LS".
 * Components below `threshold` of the strongest one are left out, so a clean
 * axis gives one letter and a corner of the view cube gives three.
 */
export function describeDirection(direction: Vec3, threshold = 0.5): string {
  const unit = normalize(direction);
  const scored = AXIS_LABELS.map((label) => ({
    label,
    score: dot(unit, label.direction),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const strongest = scored[0];
  if (!strongest) return "";
  return scored
    .filter((entry) => entry.score >= strongest.score * threshold)
    .map((entry) => entry.label.code)
    .join("");
}

export type PlaneName = "axial" | "coronal" | "sagittal" | "oblique";

/**
 * Name the plane that a normal defines.
 *
 * A normal within about 25 degrees of an anatomical axis takes that axis's
 * name. Anything else is oblique, which is what the elbow scans are: the
 * patient lies with the arm across the body, so no plane is truly axial.
 */
export function describePlane(normal: Vec3, tolerance = 0.9): PlaneName {
  const unit = normalize(normal);
  if (Math.abs(unit[2]) >= tolerance) return "axial";
  if (Math.abs(unit[1]) >= tolerance) return "coronal";
  if (Math.abs(unit[0]) >= tolerance) return "sagittal";
  return "oblique";
}

/**
 * The four edge labels of an image, clockwise from the top.
 *
 * A radiologist reads these before anything else. They say which way the
 * patient faces, and they are the reason left and right never get confused.
 */
export function edgeLabels(
  rowDirection: Vec3,
  columnDirection: Vec3,
): { top: string; bottom: string; left: string; right: string } {
  const negate = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
  return {
    // The column direction runs down the image, so the top faces the other way.
    top: describeDirection(negate(columnDirection)),
    bottom: describeDirection(columnDirection),
    left: describeDirection(negate(rowDirection)),
    right: describeDirection(rowDirection),
  };
}
