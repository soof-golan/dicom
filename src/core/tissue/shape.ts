/**
 * Reading the shape of a dark structure, where signal says nothing.
 *
 * Cortical bone, tendon, and ligament all give no signal at the echo times of
 * this study. Their T2* is about 0.4 to 2 ms, and the shortest echo here is
 * 11 ms, so all three have decayed to zero. No threshold can separate them,
 * because the difference is not in the numbers.
 *
 * What is still in the numbers is form. A tendon is a tube. A cortical shell is
 * a plate. The second derivatives of the image say which, and that is what this
 * module measures.
 *
 * The Hessian at a point has three eigenvalues. Sort them by size:
 *
 * - one small, two large: a tube runs along the small one.
 * - two small, one large: a plate lies across the large one.
 * - three large: a blob, which is neither.
 *
 * A dark structure sits at a low point of the field, so its eigenvalues are
 * positive. A negative largest eigenvalue means a bright structure, and this
 * module reports no shape there.
 *
 * CAUTION: the voxels of this study are 0.27 mm across a row and 3.3 mm between
 * slices. Derivatives taken in index steps would count one slice step as equal
 * to one row step, and every structure would come out as a plate across the
 * slice axis. Every derivative here is divided by the millimetres of its own
 * axis, so the eigenvalues belong to the patient, not to the grid.
 */
import type { Volume } from "../volume/build.ts";
import { percentileRange } from "../view/planes.ts";

/** Intensity on a voxel grid, with the millimetre size of one voxel. */
export interface ScalarField {
  readonly dims: readonly [number, number, number];
  /** Millimetres between voxel centres along i, j, and k. */
  readonly spacing: readonly [number, number, number];
  readonly data: Float32Array;
}

export type ShapeKind =
  /** Two directions curve up, one does not. A tendon or a ligament. */
  | "tube"
  /** One direction curves up. A cortical shell. */
  | "sheet"
  /** Every direction curves up. Neither of the two above. */
  | "blob"
  /** No dark structure, or the field is flat. */
  | "none";

export interface Shape {
  readonly kind: ShapeKind;
  /** 0 to 1. Two kinds that score alike leave this near zero. */
  readonly confidence: number;
  /** The sigma in millimetres that answered strongest. 0 for `none`. */
  readonly scale: number;
}

export const NO_SHAPE: Shape = { kind: "none", confidence: 0, scale: 0 };

/**
 * The widths this module looks for, as sigma in millimetres.
 *
 * A collateral ligament is about 2 mm thick and a biceps tendon about 6 mm, so
 * one width cannot answer for both.
 */
export const DEFAULT_SCALES: readonly number[] = [0.7, 1.4, 2.8];

/**
 * Curvature at which a structure counts as clear, after scale normalization.
 *
 * The value is signal per squared sigma, so it does not change with the size of
 * a voxel. It is measured, not chosen: across the dark voxels of the elbow
 * study the largest eigenvalue has a median near 0.042 and a 99th percentile
 * near 0.18. A scale of 0.05 therefore puts the median at about a third of full
 * strength and the clearest tenth above nine tenths.
 */
export const STRUCTURE_SCALE = 0.05;

/**
 * The widest kernel, in voxels.
 *
 * A sigma of 2.8 mm across 0.27 mm voxels wants a radius of 31, and the cost of
 * that over a whole volume is minutes. This radius keeps 96 percent of the
 * kernel weight and the cost stays in seconds.
 */
const MAX_RADIUS = 24;

function offset(dims: readonly [number, number, number], i: number, j: number, k: number): number {
  return (k * dims[1] + j) * dims[0] + i;
}

/** Read a voxel, and repeat the edge value outside the grid. */
function clamped(field: ScalarField, i: number, j: number, k: number): number {
  const [nx, ny, nz] = field.dims;
  const x = Math.min(Math.max(i, 0), nx - 1);
  const y = Math.min(Math.max(j, 0), ny - 1);
  const z = Math.min(Math.max(k, 0), nz - 1);
  return field.data[offset(field.dims, x, y, z)]!;
}

/** A normalized Gaussian kernel for a sigma given in voxels. */
function kernel(sigmaVoxels: number): Float64Array {
  const radius = Math.min(MAX_RADIUS, Math.max(1, Math.ceil(3 * sigmaVoxels)));
  const weights = new Float64Array(2 * radius + 1);
  const denominator = 2 * sigmaVoxels * sigmaVoxels;
  let total = 0;
  for (let t = -radius; t <= radius; t += 1) {
    const weight = Math.exp(-(t * t) / denominator);
    weights[t + radius] = weight;
    total += weight;
  }
  for (let index = 0; index < weights.length; index += 1) weights[index]! /= total;
  return weights;
}

/**
 * Blur a field by a sigma in millimetres.
 *
 * Each axis gets its own kernel, because each axis has its own voxel size. One
 * millimetre covers four voxels across a row and a third of a voxel between
 * slices, and the blur must respect that.
 */
export function smooth(field: ScalarField, sigmaMillimetres: number): ScalarField {
  const [nx, ny, nz] = field.dims;
  // Two scratch buffers, used in turn. The field the caller gave is never written.
  const buffers = [new Float32Array(field.data.length), new Float32Array(field.data.length)];
  let source = field.data;
  let written = 0;

  for (let axis = 0; axis < 3; axis += 1) {
    const target = buffers[written % 2]!;
    const sigmaVoxels = sigmaMillimetres / field.spacing[axis]!;
    // Below a third of a voxel the kernel is one tap, so the pass changes nothing.
    if (sigmaVoxels < 0.05) continue;
    const weights = kernel(sigmaVoxels);
    const radius = (weights.length - 1) / 2;
    const limit = field.dims[axis]!;
    const step = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;

    for (let k = 0; k < nz; k += 1) {
      for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
          const here = offset(field.dims, i, j, k);
          const position = axis === 0 ? i : axis === 1 ? j : k;
          let sum = 0;
          for (let t = -radius; t <= radius; t += 1) {
            const at = Math.min(Math.max(position + t, 0), limit - 1);
            sum += weights[t + radius]! * source[here + (at - position) * step]!;
          }
          target[here] = sum;
        }
      }
    }
    source = target;
    written += 1;
  }

  return { dims: field.dims, spacing: field.spacing, data: source };
}

/**
 * Eigenvalues of the Hessian at one voxel, sorted by size, smallest first.
 *
 * The units are signal per squared millimetre. The grid axes are a rotation of
 * the patient axes, and a rotation does not change an eigenvalue, so dividing
 * each derivative by its own spacing is enough to reach patient units.
 */
export function hessianEigenvalues(
  field: ScalarField,
  i: number,
  j: number,
  k: number,
): [number, number, number] {
  const [nx, ny, nz] = field.dims;
  if (i < 1 || j < 1 || k < 1 || i > nx - 2 || j > ny - 2 || k > nz - 2) return [0, 0, 0];

  const [sx, sy, sz] = field.spacing;
  const centre = clamped(field, i, j, k);
  const read = (di: number, dj: number, dk: number): number =>
    clamped(field, i + di, j + dj, k + dk);

  const xx = (read(1, 0, 0) + read(-1, 0, 0) - 2 * centre) / (sx * sx);
  const yy = (read(0, 1, 0) + read(0, -1, 0) - 2 * centre) / (sy * sy);
  const zz = (read(0, 0, 1) + read(0, 0, -1) - 2 * centre) / (sz * sz);
  const xy = (read(1, 1, 0) - read(1, -1, 0) - read(-1, 1, 0) + read(-1, -1, 0)) / (4 * sx * sy);
  const xz = (read(1, 0, 1) - read(1, 0, -1) - read(-1, 0, 1) + read(-1, 0, -1)) / (4 * sx * sz);
  const yz = (read(0, 1, 1) - read(0, 1, -1) - read(0, -1, 1) + read(0, -1, -1)) / (4 * sy * sz);

  return symmetricEigenvalues(xx, yy, zz, xy, xz, yz);
}

/**
 * Eigenvalues of a symmetric 3 by 3 matrix, in closed form.
 *
 * The matrix is real and symmetric, so all three eigenvalues are real and the
 * trigonometric solution applies. It needs no iteration and no library.
 */
export function symmetricEigenvalues(
  xx: number,
  yy: number,
  zz: number,
  xy: number,
  xz: number,
  yz: number,
): [number, number, number] {
  const offDiagonal = xy * xy + xz * xz + yz * yz;
  const trace = (xx + yy + zz) / 3;

  if (offDiagonal < 1e-24) return bySize(xx, yy, zz);

  const spread =
    (xx - trace) * (xx - trace) +
    (yy - trace) * (yy - trace) +
    (zz - trace) * (zz - trace) +
    2 * offDiagonal;
  const radius = Math.sqrt(spread / 6);

  // The determinant of the matrix, shifted to a zero trace and scaled to unit size.
  const a = (xx - trace) / radius;
  const b = (yy - trace) / radius;
  const c = (zz - trace) / radius;
  const p = xy / radius;
  const q = xz / radius;
  const r = yz / radius;
  const determinant = a * (b * c - r * r) - p * (p * c - r * q) + q * (p * r - b * q);

  const angle = Math.acos(Math.min(Math.max(determinant / 2, -1), 1)) / 3;
  const first = trace + 2 * radius * Math.cos(angle);
  const third = trace + 2 * radius * Math.cos(angle + (2 * Math.PI) / 3);
  return bySize(first, 3 * trace - first - third, third);
}

function bySize(a: number, b: number, c: number): [number, number, number] {
  const sorted = [a, b, c].sort((x, y) => Math.abs(x) - Math.abs(y));
  return [sorted[0]!, sorted[1]!, sorted[2]!];
}

/**
 * Samples to keep across one sigma.
 *
 * Two samples per sigma hold every detail a blur of that width can carry.
 * Anything finer costs time and adds nothing.
 */
const SAMPLES_PER_SIGMA = 2;

/** Block sizes that bring each axis near the detail a sigma can carry. */
export function blockFor(
  spacing: readonly [number, number, number],
  sigma: number,
): [number, number, number] {
  const per = (step: number): number => Math.max(1, Math.floor(sigma / (SAMPLES_PER_SIGMA * step)));
  return [per(spacing[0]), per(spacing[1]), per(spacing[2])];
}

/**
 * Average blocks of voxels into single voxels.
 *
 * The spacing of the result grows by the block size, so the millimetres stay
 * right and `hessianEigenvalues` needs no change.
 */
export function coarsen(field: ScalarField, block: readonly [number, number, number]): ScalarField {
  if (block[0] === 1 && block[1] === 1 && block[2] === 1) return field;

  const [nx, ny, nz] = field.dims;
  const dims: [number, number, number] = [
    Math.max(1, Math.floor(nx / block[0])),
    Math.max(1, Math.floor(ny / block[1])),
    Math.max(1, Math.floor(nz / block[2])),
  ];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);

  for (let k = 0; k < dims[2]; k += 1) {
    for (let j = 0; j < dims[1]; j += 1) {
      for (let i = 0; i < dims[0]; i += 1) {
        let sum = 0;
        let count = 0;
        for (let dk = 0; dk < block[2]; dk += 1) {
          const z = k * block[2] + dk;
          if (z >= nz) break;
          for (let dj = 0; dj < block[1]; dj += 1) {
            const y = j * block[1] + dj;
            if (y >= ny) break;
            for (let di = 0; di < block[0]; di += 1) {
              const x = i * block[0] + di;
              if (x >= nx) break;
              sum += field.data[(z * ny + y) * nx + x]!;
              count += 1;
            }
          }
        }
        data[(k * dims[1] + j) * dims[0] + i] = count === 0 ? 0 : sum / count;
      }
    }
  }

  return {
    dims,
    spacing: [
      field.spacing[0] * block[0],
      field.spacing[1] * block[1],
      field.spacing[2] * block[2],
    ],
    data,
  };
}

export interface ScaleField {
  readonly sigma: number;
  readonly field: ScalarField;
  /** Block size this scale was coarsened by, so a caller can map its indices. */
  readonly block: readonly [number, number, number];
}

/**
 * Blur once per width, each on a grid that suits it.
 *
 * A wide blur on the finest grid reads the same numbers many times over. Each
 * width therefore gets its own coarser grid, which is the standard scale-space
 * pyramid. The cost per width then stops growing with the width.
 */
export function prepareScales(
  field: ScalarField,
  scales: readonly number[] = DEFAULT_SCALES,
): readonly ScaleField[] {
  return scales.map((sigma) => {
    const block = blockFor(field.spacing, sigma);
    return { sigma, field: smooth(coarsen(field, block), sigma), block };
  });
}

/**
 * Name the shape at one voxel from three eigenvalues.
 *
 * The three scores add up to one, so the gap between the best and the second
 * best is a fair measure of how clear the answer is.
 */
export function shapeFromEigenvalues(
  eigenvalues: readonly [number, number, number],
  scale: number,
): Shape {
  const largest = eigenvalues[2];
  if (largest <= 0) return NO_SHAPE;

  // A direction that curves down belongs to no dark structure, so it counts as
  // zero. The smallest eigenvalue keeps its size, because a large one of either
  // sign means the point is not on a tube.
  const middle = Math.max(eigenvalues[1], 0) / largest;
  const smallest = Math.abs(eigenvalues[0]) / largest;

  const tube = middle * (1 - smallest);
  const sheet = 1 - middle;
  const blob = smallest;

  const strength = 1 - Math.exp(-(largest * largest) / (2 * STRUCTURE_SCALE * STRUCTURE_SCALE));

  // A middle eigenvalue that curves DOWN makes the point a saddle, not a dark
  // plate. Without this penalty a saddle scores a perfect sheet, because its
  // middle ratio is zero, and noise fills the volume with sheets.
  const saddle = Math.max(0, -eigenvalues[1]) / largest;

  const scores: readonly (readonly [ShapeKind, number])[] = [
    ["tube", tube],
    ["sheet", sheet],
    ["blob", blob],
  ];
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const margin = ranked[0]![1] - ranked[1]![1];
  const confidence = Math.min(1, Math.max(0, margin * strength * (1 - saddle)));
  if (confidence <= 0) return NO_SHAPE;
  return { kind: ranked[0]![0], confidence, scale };
}

/**
 * The shape at one voxel, over every prepared width.
 *
 * The width that reports the strongest curvature wins. Multiplying by the
 * squared sigma is what makes the widths comparable: without it the smallest
 * blur always answers loudest.
 */
export function shapeAt(scales: readonly ScaleField[], i: number, j: number, k: number): Shape {
  let best = NO_SHAPE;
  let strongest = 0;

  for (const { sigma, field, block } of scales) {
    const raw = hessianEigenvalues(
      field,
      Math.floor(i / block[0]),
      Math.floor(j / block[1]),
      Math.floor(k / block[2]),
    );
    const gamma = sigma * sigma;
    const scaled: [number, number, number] = [raw[0] * gamma, raw[1] * gamma, raw[2] * gamma];
    if (scaled[2] <= strongest) continue;
    strongest = scaled[2];
    best = shapeFromEigenvalues(scaled, sigma);
  }
  return best;
}

/**
 * A volume as a field from 0 to 1.
 *
 * The scale is the percentile scale that the classifier uses, so a curvature
 * measured here means the same thing as a signal band there.
 */
export function fieldFromVolume(volume: Volume): ScalarField {
  const { min, max } = volume.valueRange;
  const span = max - min || 1;
  const { low, high } = percentileRange(volume);
  const width = Math.max(high - low, 1e-6);

  const data = new Float32Array(volume.data.length);
  for (let index = 0; index < data.length; index += 1) {
    const normalized = (volume.data[index]! - min) / span;
    data[index] = Math.min(Math.max((normalized - low) / width, 0), 1);
  }
  return { dims: volume.dims, spacing: volume.spacing, data };
}
