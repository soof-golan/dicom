/**
 * Turning a sorted series into one 3D grid.
 *
 * Index order is `i` across a row, `j` down a column, `k` through the slices.
 * The data is stored as `data[k * rows * columns + j * columns + i]`, so one
 * slice stays contiguous and uploads to the GPU without a copy.
 */
import { decodeFrame, storedValueRange, type PixelArray } from "../dicom/pixels.ts";
import type { Instance } from "../dicom/instance.ts";
import {
  affineFromAxes,
  applyAffine,
  dot,
  scale,
  subtract,
  type Mat4,
  type Vec3,
} from "../geometry/vec3.ts";
import type { Series } from "./series.ts";
import { sortAlongNormal } from "./series.ts";

export interface Volume {
  /** Voxel counts along i, j, and k. */
  readonly dims: readonly [number, number, number];
  /** Millimeters between voxel centers along i, j, and k. */
  readonly spacing: readonly [number, number, number];
  /** Patient coordinates of the center of voxel (0, 0, 0). */
  readonly origin: Vec3;
  /** Unit direction of i, j, and k in patient space. */
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly voxelToPatient: Mat4;
  readonly data: PixelArray;
  readonly signed: boolean;
  readonly rescaleSlope: number;
  readonly rescaleIntercept: number;
  readonly valueRange: { readonly min: number; readonly max: number };
  readonly windowCenter?: number;
  readonly windowWidth?: number;
  readonly description: string;
  readonly modality: string;
  readonly seriesInstanceUid: string;
  /** Facts that a reader must know before trusting the geometry. */
  readonly warnings: readonly string[];
}

export class VolumeError extends Error {
  override readonly name = "VolumeError";
}

const SPACING_TOLERANCE = 0.01;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The step between slices, and a warning when the steps are uneven. */
function measureSliceSpacing(
  sorted: readonly Instance[],
  normal: Vec3,
  warnings: string[],
): number {
  const first = sorted[0]!;
  if (sorted.length < 2) {
    return first.spacingBetweenSlices ?? first.sliceThickness ?? 1;
  }

  const gaps: number[] = [];
  for (let k = 1; k < sorted.length; k += 1) {
    gaps.push(dot(sorted[k]!.position, normal) - dot(sorted[k - 1]!.position, normal));
  }

  const step = median(gaps);
  if (step <= 0) {
    warnings.push("Slice positions do not advance. The slice spacing fell back to 1 mm.");
    return first.spacingBetweenSlices ?? first.sliceThickness ?? 1;
  }

  const uneven = gaps.filter((gap) => Math.abs(gap - step) > SPACING_TOLERANCE);
  if (uneven.length > 0) {
    warnings.push(
      `Slice spacing is uneven in ${uneven.length} of ${gaps.length} gaps. ` +
        `The volume uses the median step of ${step.toFixed(3)} mm.`,
    );
  }
  return step;
}

/** Warn when a slice sits off the axis that the first slice defines. */
function checkForShear(
  sorted: readonly Instance[],
  normal: Vec3,
  origin: Vec3,
  warnings: string[],
): void {
  for (const instance of sorted) {
    const offset = subtract(instance.position, origin);
    const alongNormal = scale(normal, dot(offset, normal));
    const sideways = Math.hypot(
      offset[0] - alongNormal[0],
      offset[1] - alongNormal[1],
      offset[2] - alongNormal[2],
    );
    if (sideways > 0.5) {
      warnings.push(
        "Slices are offset sideways, not only along the normal. " +
          "The scan has a gantry tilt or a moving table, and the 3D view is approximate.",
      );
      return;
    }
  }
}

function checkOrientation(sorted: readonly Instance[], normal: Vec3, warnings: string[]): void {
  for (const instance of sorted) {
    if (Math.abs(dot(instance.normal, normal)) < 0.999) {
      warnings.push(
        "Slices do not share one orientation. The series mixes planes, and the 3D view is approximate.",
      );
      return;
    }
  }
}

function allocate(signed: boolean, length: number): PixelArray {
  return signed ? new Int16Array(length) : new Uint16Array(length);
}

/**
 * Build a volume from the slices of one series.
 *
 * @throws {VolumeError} for an empty series, or for slices of unequal size.
 */
export function buildVolume(instances: readonly Instance[]): Volume {
  if (instances.length === 0) {
    throw new VolumeError("cannot build a volume: the series has no slices");
  }

  const sorted = sortAlongNormal(instances);
  const first = sorted[0]!;
  const { rows, columns } = first;

  for (const instance of sorted) {
    if (instance.rows !== rows || instance.columns !== columns) {
      throw new VolumeError(
        `slices differ in size: ${columns}x${rows} and ${instance.columns}x${instance.rows}`,
      );
    }
  }

  const warnings: string[] = [];
  const { normal } = first;
  checkOrientation(sorted, normal, warnings);
  checkForShear(sorted, normal, first.position, warnings);
  const sliceSpacing = measureSliceSpacing(sorted, normal, warnings);

  const head = decodeFrame(first.dataSet, 0);
  const sliceLength = rows * columns;
  const data = allocate(head.signed, sliceLength * sorted.length);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  sorted.forEach((instance, k) => {
    const frame = decodeFrame(instance.dataSet, 0);
    if (frame.samplesPerPixel !== 1) {
      throw new VolumeError(
        `a volume needs single-sample images, but a slice has ${frame.samplesPerPixel} samples`,
      );
    }
    data.set(frame.pixels as unknown as ArrayLike<number>, k * sliceLength);
    const range = storedValueRange(frame);
    if (range.min < min) min = range.min;
    if (range.max > max) max = range.max;
  });

  // i runs across a row, so it steps by the column spacing.
  const axisI = first.rowDirection;
  const axisJ = first.columnDirection;
  const spacing: readonly [number, number, number] = [
    first.columnSpacing,
    first.rowSpacing,
    sliceSpacing,
  ];

  return {
    dims: [columns, rows, sorted.length],
    spacing,
    origin: first.position,
    axes: [axisI, axisJ, normal],
    voxelToPatient: affineFromAxes(
      scale(axisI, spacing[0]),
      scale(axisJ, spacing[1]),
      scale(normal, spacing[2]),
      first.position,
    ),
    data,
    signed: head.signed,
    rescaleSlope: head.rescaleSlope,
    rescaleIntercept: head.rescaleIntercept,
    valueRange: { min, max },
    windowCenter: head.windowCenter,
    windowWidth: head.windowWidth,
    description: first.seriesDescription,
    modality: first.modality,
    seriesInstanceUid: first.seriesInstanceUid,
    warnings,
  };
}

export function buildVolumeFromSeries(series: Series): Volume {
  return buildVolume(series.instances);
}

/** Patient coordinates of a voxel index, in millimeters. */
export function voxelToPatient(volume: Volume, voxel: Vec3): Vec3 {
  return applyAffine(volume.voxelToPatient, voxel);
}

/** The stored value at a voxel, or `undefined` outside the grid. */
export function sampleNearest(volume: Volume, voxel: Vec3): number | undefined {
  const [i, j, k] = [Math.round(voxel[0]), Math.round(voxel[1]), Math.round(voxel[2])];
  const [nx, ny, nz] = volume.dims;
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return undefined;
  return volume.data[k * nx * ny + j * nx + i];
}

/** The size of the volume in millimeters, along each axis. */
export function extentMillimeters(volume: Volume): Vec3 {
  return [
    volume.dims[0] * volume.spacing[0],
    volume.dims[1] * volume.spacing[1],
    volume.dims[2] * volume.spacing[2],
  ];
}
