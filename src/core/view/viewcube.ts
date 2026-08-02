/**
 * The view cube.
 *
 * CAD software puts a small labelled cube in a corner of the 3D view. You drag
 * it to turn the model and click a face, an edge, or a corner to jump to that
 * view. This module holds the 26 targets and the camera angles they mean. It
 * draws nothing.
 */
import { describeDirection } from "../geometry/anatomy.ts";
import { normalize, type Vec3 } from "../geometry/vec3.ts";

export type CubeRegionKind = "face" | "edge" | "corner";

export interface CubeRegion {
  readonly id: string;
  readonly kind: CubeRegionKind;
  /** Direction from the middle of the cube, in patient coordinates. */
  readonly direction: Vec3;
  /** Anatomical letters, for example `A`, `AS`, or `RAS`. */
  readonly label: string;
  readonly title: string;
}

export interface CameraAngles {
  readonly azimuth: number;
  readonly elevation: number;
}

const AXIS_NAMES: Record<string, string> = {
  R: "Right",
  L: "Left",
  A: "Anterior",
  P: "Posterior",
  S: "Superior",
  I: "Inferior",
};

function titleFor(label: string): string {
  return label
    .split("")
    .map((letter) => AXIS_NAMES[letter] ?? letter)
    .join(" ");
}

/**
 * Every region of the cube.
 *
 * A cube has 6 faces, 12 edges, and 8 corners. Each one is the direction of one
 * combination of -1, 0, and +1, apart from the middle.
 */
export const CUBE_REGIONS: readonly CubeRegion[] = (() => {
  const regions: CubeRegion[] = [];
  const steps = [-1, 0, 1];
  for (const x of steps) {
    for (const y of steps) {
      for (const z of steps) {
        const count = Math.abs(x) + Math.abs(y) + Math.abs(z);
        if (count === 0) continue;
        const kind: CubeRegionKind = count === 1 ? "face" : count === 2 ? "edge" : "corner";
        const direction: Vec3 = [x, y, z];
        const label = describeDirection(direction, 0.99);
        regions.push({
          id: `${x},${y},${z}`,
          kind,
          direction,
          label,
          title: titleFor(label),
        });
      }
    }
  }
  return regions;
})();

export const CUBE_FACES = CUBE_REGIONS.filter((region) => region.kind === "face");

/**
 * The camera angles that look at a direction.
 *
 * The camera sits along `direction` and looks back at the middle. Azimuth turns
 * about the superior axis. Elevation rises above the axial plane.
 */
export function anglesFor(direction: Vec3): CameraAngles {
  const [x, y, z] = normalize(direction);
  const flat = Math.hypot(x, y);
  return {
    // The renderer places the camera at (sin a, -cos a, sin e), so the azimuth
    // that produces a given horizontal direction is atan2(x, -y).
    azimuth: flat < 1e-6 ? 0 : Math.atan2(x, -y),
    elevation: Math.atan2(z, flat),
  };
}

/** Camera position for a direction, at a distance, around a middle point. */
export function cameraPosition(angles: CameraAngles, center: Vec3, distance: number): Vec3 {
  const { azimuth, elevation } = angles;
  return [
    center[0] + distance * Math.cos(elevation) * Math.sin(azimuth),
    center[1] - distance * Math.cos(elevation) * Math.cos(azimuth),
    center[2] + distance * Math.sin(elevation),
  ];
}

/** The region a camera is closest to, for highlighting the cube. */
export function regionFacing(angles: CameraAngles): CubeRegion {
  const direction = cameraPosition(angles, [0, 0, 0], 1);
  let best = CUBE_REGIONS[0]!;
  let bestScore = -Infinity;
  for (const region of CUBE_REGIONS) {
    const unit = normalize(region.direction);
    const score = unit[0] * direction[0] + unit[1] * direction[1] + unit[2] * direction[2];
    // Faces win ties, then edges. A reader expects a plain view, not a corner.
    const bias = region.kind === "face" ? 0.06 : region.kind === "edge" ? 0.03 : 0;
    if (score + bias > bestScore) {
      bestScore = score + bias;
      best = region;
    }
  }
  return best;
}

/**
 * Turn the camera by one quarter turn.
 *
 * The arrows around the cube use this. Turning is easier to follow than
 * dragging when a reader wants exactly 90 degrees.
 */
export function turn(
  angles: CameraAngles,
  direction: "left" | "right" | "up" | "down",
): CameraAngles {
  const quarter = Math.PI / 2;
  const limit = quarter - 0.01;
  switch (direction) {
    case "left":
      return { ...angles, azimuth: angles.azimuth - quarter };
    case "right":
      return { ...angles, azimuth: angles.azimuth + quarter };
    case "up":
      return { ...angles, elevation: Math.min(limit, angles.elevation + quarter) };
    case "down":
      return { ...angles, elevation: Math.max(-limit, angles.elevation - quarter) };
  }
}
