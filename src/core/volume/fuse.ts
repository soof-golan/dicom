/**
 * Combining several series into one volume with cubic voxels.
 *
 * An MRI series is not a cube of data. Pixels inside a slice are close
 * together, about 0.27 mm here, and the slices themselves are far apart, about
 * 3.3 mm. A cut taken across the slices therefore stretches 12 pixels' worth of
 * detail over one step, and it looks streaked. No interpolation repairs this,
 * because the detail was never measured.
 *
 * A second series measures it. A study that holds an axial, a coronal, and a
 * sagittal acquisition has fine detail along every axis, only spread across
 * three files: each series is sharp in its own plane and blurred through it,
 * and their planes are at right angles.
 *
 * So the detail can be put back together. Every series records where each voxel
 * sits in the same patient, and the three here share one frame of reference, so
 * no registration step is needed and nothing has to be aligned first.
 *
 * CAUTION: the result is a derived image. It is built from measurements, it is
 * not itself a measurement, and it carries a warning that says so.
 */
import { affineFromAxes, applyAffine, invertAffine, type Vec3 } from "../geometry/vec3.ts";
import type { Volume } from "./build.ts";
import { percentileRange } from "./statistics.ts";

export class FusionError extends Error {
  override readonly name = "FusionError";
}

export interface FusionOptions {
  /**
   * The most voxels the result may hold.
   *
   * The grid is cubic, so halving the step multiplies the count by eight. A
   * budget keeps a whole-body study from asking for memory the browser will
   * refuse. 16 million voxels is 32 MB as 16-bit data.
   */
  readonly voxelBudget?: number;
  /** Force this step in millimeters instead of deriving one from the budget. */
  readonly spacing?: number;
}

export interface FusionGrid {
  readonly dims: readonly [number, number, number];
  readonly spacing: readonly [number, number, number];
  /** Patient coordinates of the center of voxel (0, 0, 0). */
  readonly origin: Vec3;
}

const DEFAULT_BUDGET = 16_000_000;

/**
 * Can these series be compared without a registration step?
 *
 * Only a shared frame of reference answers this. Two series that name
 * different frames hold coordinates that mean different things, and combining
 * them would produce a confident blur of two places.
 */
export function shareFrameOfReference(volumes: readonly Volume[]): boolean {
  const first = volumes[0];
  if (!first || volumes.length < 2) return false;
  if (first.frameOfReferenceUid === "") return false;
  return volumes.every((volume) => volume.frameOfReferenceUid === first.frameOfReferenceUid);
}

/** The eight corners of a volume, in patient millimeters. */
function corners(volume: Volume): Vec3[] {
  const [nx, ny, nz] = volume.dims;
  const found: Vec3[] = [];
  for (const i of [-0.5, nx - 0.5]) {
    for (const j of [-0.5, ny - 0.5]) {
      for (const k of [-0.5, nz - 0.5]) {
        found.push(applyAffine(volume.voxelToPatient, [i, j, k]));
      }
    }
  }
  return found;
}

/**
 * Choose the grid that the result will sit on.
 *
 * The axes are the patient's own axes, so the fused volume needs no rotation
 * to read and its cuts land square. The box covers every series, because a
 * series that reaches further than the others still holds real signal there.
 *
 * The step starts at the finest in-plane step of any series, which is the
 * finest detail the study actually measured. It grows until the count fits the
 * budget, because a step below the budget cannot be stored.
 */
export function planFusion(volumes: readonly Volume[], options: FusionOptions = {}): FusionGrid {
  if (volumes.length === 0) throw new FusionError("no series to fuse");

  const points = volumes.flatMap(corners);
  const low: number[] = [Infinity, Infinity, Infinity];
  const high: number[] = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis]!, point[axis]!);
      high[axis] = Math.max(high[axis]!, point[axis]!);
    }
  }
  const extent = [0, 1, 2].map((axis) => Math.max(high[axis]! - low[axis]!, 1e-3));

  const budget = options.voxelBudget ?? DEFAULT_BUDGET;
  let step = options.spacing ?? Math.min(...volumes.flatMap((v) => [...v.spacing]));
  if (options.spacing === undefined) {
    // Grow the step until the count fits. Each pass adds a tenth, so the loop
    // ends quickly and the step stays close to the finest one that fits.
    for (let guard = 0; guard < 1000; guard += 1) {
      const count = extent.reduce((total, size) => total * Math.max(1, Math.ceil(size / step)), 1);
      if (count <= budget) break;
      step *= 1.1;
    }
  }

  const dims = extent.map((size) => Math.max(1, Math.ceil(size / step))) as unknown as readonly [
    number,
    number,
    number,
  ];

  return {
    dims,
    spacing: [step, step, step],
    origin: [low[0]!, low[1]!, low[2]!],
  };
}

/** One series, ready to be read at any point in the patient. */
interface Source {
  readonly volume: Volume;
  readonly patientToVoxel: ReturnType<typeof invertAffine>;
  /** Maps a stored value onto 0 to 1 across this series' own signal range. */
  readonly offset: number;
  readonly scale: number;
  /** Millimeters between slices, which is the direction this series blurs. */
  readonly sliceStep: number;
}

function prepare(volume: Volume): Source {
  const { min, max } = volume.valueRange;
  const span = max - min || 1;
  const fraction = percentileRange(volume);
  // The percentiles arrive as a fraction of the stored range, so they are
  // turned back into stored values here.
  const low = min + fraction.low * span;
  const high = min + fraction.high * span;
  return {
    volume,
    patientToVoxel: invertAffine(volume.voxelToPatient),
    offset: low,
    scale: 1 / Math.max(high - low, 1e-6),
    sliceStep: volume.spacing[2] || 1,
  };
}

/** Read inside one slice, where the samples are close together and reliable. */
function bilinearInSlice(volume: Volume, x: number, y: number, k: number): number {
  const [nx, ny] = volume.dims;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const fx = x - x0;
  const fy = y - y0;
  const base = k * nx * ny;
  const at = (i: number, j: number): number => volume.data[base + j * nx + i] ?? 0;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * How much to trust one series at one point.
 *
 * A series measured its slices at whole values of k. Halfway between two of
 * them, every value is a guess, and that is where the through-plane blur is
 * worst. So a sample taken near a measured slice counts for more.
 *
 * The weight halves at half a slice away, which is the furthest a point can
 * be. Nothing is thrown away, because a distant sample is still real signal,
 * and a point that only one series reaches must still be filled.
 */
function sliceWeight(k: number): number {
  const distance = Math.abs(k - Math.round(k));
  return Math.pow(0.5, distance * 2);
}

/**
 * Build one volume with cubic voxels from several series.
 *
 * Each output voxel is read from every series that covers it, in patient
 * millimeters. The readings are put on a common scale first, because MRI signal
 * is not calibrated and two series of the same tissue can differ by a factor of
 * four from receive gain alone.
 */
export function fuseVolumes(volumes: readonly Volume[], options: FusionOptions = {}): Volume {
  if (volumes.length < 2) throw new FusionError("fusion needs two or more series");
  if (!shareFrameOfReference(volumes)) {
    throw new FusionError("the series do not share a frame of reference, so they cannot be fused");
  }

  const grid = planFusion(volumes, options);
  const [nx, ny, nz] = grid.dims;
  const step = grid.spacing[0];
  const sources = volumes.map(prepare);

  const data = new Uint16Array(nx * ny * nz);
  const FULL = 4095;
  let min = FULL;
  let max = 0;

  for (let k = 0; k < nz; k += 1) {
    const z = grid.origin[2] + k * step;
    for (let j = 0; j < ny; j += 1) {
      const y = grid.origin[1] + j * step;
      let index = k * nx * ny + j * nx;
      for (let i = 0; i < nx; i += 1, index += 1) {
        const point: Vec3 = [grid.origin[0] + i * step, y, z];

        let total = 0;
        let weight = 0;
        for (const source of sources) {
          const voxel = applyAffine(source.patientToVoxel, point);
          const [vx, vy, vz] = voxel;
          const [sx, sy, sz] = source.volume.dims;
          if (vx < 0 || vy < 0 || vz < -0.5) continue;
          if (vx > sx - 1 || vy > sy - 1 || vz > sz - 0.5) continue;

          // Read inside the two nearest slices, then blend between them. This
          // keeps the sharp direction sharp and only guesses across the gap.
          const k0 = Math.max(0, Math.min(sz - 1, Math.floor(vz)));
          const k1 = Math.min(k0 + 1, sz - 1);
          const between = Math.max(0, Math.min(1, vz - k0));
          const near = bilinearInSlice(source.volume, vx, vy, k0);
          const far = bilinearInSlice(source.volume, vx, vy, k1);
          const stored = near * (1 - between) + far * between;

          const signal = (stored - source.offset) * source.scale;
          const w = sliceWeight(vz);
          total += Math.max(0, Math.min(1, signal)) * w;
          weight += w;
        }

        if (weight <= 0) continue;
        const value = Math.round((total / weight) * FULL);
        data[index] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
  }

  if (max < min) {
    min = 0;
    max = 0;
  }

  const first = volumes[0]!;
  const sizes = volumes.map((v) => `${v.dims[0]}x${v.dims[1]}x${v.dims[2]}`).join(", ");

  return {
    dims: grid.dims,
    spacing: grid.spacing as readonly [number, number, number],
    origin: grid.origin,
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    voxelToPatient: affineFromAxes([step, 0, 0], [0, step, 0], [0, 0, step], grid.origin),
    data,
    signed: false,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    valueRange: { min, max },
    description: `Fused (${volumes.length} series: ${sizes})`,
    modality: first.modality,
    seriesInstanceUid: `fused:${volumes
      .map((v) => v.seriesInstanceUid)
      .slice()
      .sort()
      .join("+")}`,
    frameOfReferenceUid: first.frameOfReferenceUid,
    warnings: [
      "This volume is derived. It was combined from several series and is not scanner data.",
      "Signal was put on a common scale, so its values do not match any one series.",
    ],
  };
}
