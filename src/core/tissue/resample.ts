/**
 * Reading one series at the coordinates of another.
 *
 * The four series of a study sit in different grids. They point different ways,
 * and their voxels are different sizes. What they share is the patient: every
 * series records where each voxel sits in the same frame of reference.
 *
 * So to compare sequences, go through patient millimeters. Nothing has to be
 * resampled onto a common grid first, and no registration step is needed while
 * the patient held still between the scans.
 */
import { applyAffine, invertAffine, type Mat4, type Vec3 } from "../geometry/vec3.ts";
import type { Volume } from "../volume/build.ts";

export interface Sampler {
  readonly volume: Volume;
  readonly patientToVoxel: Mat4;
  /** Signal at a point in patient millimeters, or `undefined` outside. */
  at(point: Vec3): number | undefined;
  /** The same, mapped onto 0 to 1 across the volume's own value range. */
  normalizedAt(point: Vec3): number | undefined;
}

/** Trilinear read at a voxel coordinate. Returns `undefined` outside the grid. */
export function trilinear(volume: Volume, voxel: Vec3): number | undefined {
  const [nx, ny, nz] = volume.dims;
  const [x, y, z] = voxel;
  if (x < -0.5 || y < -0.5 || z < -0.5) return undefined;
  if (x > nx - 0.5 || y > ny - 0.5 || z > nz - 0.5) return undefined;

  const clamp = (value: number, limit: number): number => Math.min(Math.max(value, 0), limit - 1);

  const x0 = Math.floor(clamp(x, nx));
  const y0 = Math.floor(clamp(y, ny));
  const z0 = Math.floor(clamp(z, nz));
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const z1 = Math.min(z0 + 1, nz - 1);

  const fx = clamp(x, nx) - x0;
  const fy = clamp(y, ny) - y0;
  const fz = clamp(z, nz) - z0;

  const { data } = volume;
  const at = (i: number, j: number, k: number): number => data[k * nx * ny + j * nx + i] ?? 0;

  const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
  const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
  const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
  const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;

  const c0 = c00 * (1 - fy) + c10 * fy;
  const c1 = c01 * (1 - fy) + c11 * fy;
  return c0 * (1 - fz) + c1 * fz;
}

export function createSampler(volume: Volume): Sampler {
  const patientToVoxel = invertAffine(volume.voxelToPatient);
  const { min, max } = volume.valueRange;
  const span = max - min || 1;

  const at = (point: Vec3): number | undefined =>
    trilinear(volume, applyAffine(patientToVoxel, point));

  return {
    volume,
    patientToVoxel,
    at,
    normalizedAt: (point) => {
      const value = at(point);
      return value === undefined ? undefined : (value - min) / span;
    },
  };
}

/**
 * Whether two series were taken in the same frame of reference.
 *
 * Two series of one study normally share it, and then their patient
 * coordinates line up without any registration. When they do not share it, the
 * coordinates mean different things and comparing them is wrong.
 */
export function sharesFrameOfReference(a: Volume, b: Volume): boolean {
  return a.frameOfReferenceUid !== "" && a.frameOfReferenceUid === b.frameOfReferenceUid;
}

/** Do the two volumes cover any of the same space? */
export function overlaps(a: Sampler, b: Sampler, samples = 512): boolean {
  const [nx, ny, nz] = a.volume.dims;
  let hits = 0;
  for (let i = 0; i < samples; i += 1) {
    // A fixed lattice, so the answer does not change between runs.
    const t = (i + 0.5) / samples;
    const voxel: Vec3 = [
      t * (nx - 1),
      (((i * 7) % samples) / samples) * (ny - 1),
      (((i * 13) % samples) / samples) * (nz - 1),
    ];
    const point = applyAffine(a.volume.voxelToPatient, voxel);
    if (b.at(point) !== undefined) hits += 1;
  }
  return hits > samples / 20;
}
