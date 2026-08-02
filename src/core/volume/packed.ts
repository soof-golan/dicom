/**
 * Reading a volume that `scripts/pack_volume.py` wrote.
 *
 * The packed form exists because a browser should not parse 164 DICOM files to
 * see one study. A series arrives as one block of raw voxels, and a JSON
 * sidecar says what the block means.
 *
 * The block has no header. It is stored values, little endian, in the order
 * that `buildVolume` keeps them:
 *
 *     offset(i, j, k) = (k * rows * columns + j * columns + i) * bytesPerVoxel
 *
 * `docs/demo-dataset.md` writes the layout out in full.
 */
import type { PixelArray } from "../dicom/pixels.ts";
import type { Mat4, Vec3 } from "../geometry/vec3.ts";
import type { Volume } from "./build.ts";

/** Everything about one grid except the voxels themselves. */
export interface PackedSidecar {
  /** Name of the voxel file, relative to the manifest. */
  readonly url: string;
  readonly bytes: number;
  readonly dataType: "uint16" | "int16";
  readonly dims: readonly [number, number, number];
  readonly spacing: readonly [number, number, number];
  readonly origin: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly voxelToPatient: Mat4;
  readonly valueRange: { readonly min: number; readonly max: number };
  readonly rescaleSlope: number;
  readonly rescaleIntercept: number;
  readonly windowCenter?: number;
  readonly windowWidth?: number;
  readonly description: string;
  readonly modality: string;
  readonly seriesInstanceUid: string;
  /** Series that share this UID share one patient coordinate system. */
  readonly frameOfReferenceUid: string;
  readonly warnings: readonly string[];
}

/** One series at two resolutions. The preview is halved in plane. */
export interface PackedSeries {
  readonly name: string;
  readonly seriesNumber: number;
  readonly full: PackedSidecar;
  readonly preview: PackedSidecar;
}

export interface PackedManifest {
  readonly format: string;
  readonly series: readonly PackedSeries[];
}

export class PackedFormatError extends Error {
  override readonly name = "PackedFormatError";
}

/** The only format this module reads. */
export const PACKED_FORMAT = "dicom-viewer/packed-volume@1";

const BYTES_PER_VOXEL = 2;

/**
 * True when the host stores the low byte of a 16-bit word first.
 *
 * Every browser and every phone runs little endian today, so the common path
 * casts the buffer and copies nothing. The check costs one word and keeps the
 * module honest on a machine that does not.
 */
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function fail(what: string): never {
  throw new PackedFormatError(what);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  return value;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where} must be a number`);
  return value;
}

function optionalCount(value: unknown, where: string): number | undefined {
  return value === undefined ? undefined : count(value, where);
}

function numbers(value: unknown, length: number, where: string): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    fail(`${where} must be an array of ${length} numbers`);
  }
  return value.map((item, index) => count(item, `${where}[${index}]`));
}

function triple(value: unknown, where: string): [number, number, number] {
  const [x, y, z] = numbers(value, 3, where);
  return [x!, y!, z!];
}

function dataType(value: unknown): "uint16" | "int16" {
  const name = text(value, "dataType");
  if (name !== "uint16" && name !== "int16") fail(`unknown dataType: ${name}`);
  return name;
}

/**
 * Read one sidecar out of parsed JSON.
 *
 * @throws {PackedFormatError} when a field is missing or has the wrong shape.
 */
export function parseSidecar(json: unknown): PackedSidecar {
  const source = record(json, "sidecar");
  const range = record(source.valueRange, "valueRange");
  const axes = source.axes;
  if (!Array.isArray(axes) || axes.length !== 3) fail("axes must hold 3 vectors");

  return {
    url: text(source.url, "url"),
    bytes: count(source.bytes, "bytes"),
    dataType: dataType(source.dataType),
    dims: triple(source.dims, "dims"),
    spacing: triple(source.spacing, "spacing"),
    origin: triple(source.origin, "origin"),
    axes: [triple(axes[0], "axes[0]"), triple(axes[1], "axes[1]"), triple(axes[2], "axes[2]")],
    voxelToPatient: numbers(source.voxelToPatient, 16, "voxelToPatient") as unknown as Mat4,
    valueRange: {
      min: count(range.min, "valueRange.min"),
      max: count(range.max, "valueRange.max"),
    },
    rescaleSlope: count(source.rescaleSlope, "rescaleSlope"),
    rescaleIntercept: count(source.rescaleIntercept, "rescaleIntercept"),
    windowCenter: optionalCount(source.windowCenter, "windowCenter"),
    windowWidth: optionalCount(source.windowWidth, "windowWidth"),
    description: text(source.description, "description"),
    modality: text(source.modality, "modality"),
    seriesInstanceUid: text(source.seriesInstanceUid, "seriesInstanceUid"),
    frameOfReferenceUid: text(source.frameOfReferenceUid, "frameOfReferenceUid"),
    warnings: (source.warnings ?? []) as readonly string[],
  };
}

/**
 * Read the study manifest, which holds one entry per series.
 *
 * @throws {PackedFormatError} for an unknown format or a malformed entry.
 */
export function parseManifest(json: unknown): PackedManifest {
  const source = record(json, "manifest");
  const format = text(source.format, "format");
  if (format !== PACKED_FORMAT) fail(`unknown packed format: ${format}`);
  if (!Array.isArray(source.series)) fail("manifest.series must be an array");

  return {
    format,
    series: source.series.map((entry, index) => {
      const item = record(entry, `series[${index}]`);
      return {
        name: text(item.name, `series[${index}].name`),
        seriesNumber: count(item.seriesNumber, `series[${index}].seriesNumber`),
        full: parseSidecar(item.full),
        preview: parseSidecar(item.preview),
      };
    }),
  };
}

/** Cast the block to 16-bit words, swapping bytes only on a big endian host. */
function readVoxels(sidecar: PackedSidecar, voxels: ArrayBuffer): PixelArray {
  const bytes = new Uint8Array(voxels);
  const ordered = HOST_IS_LITTLE_ENDIAN ? bytes : swapPairs(bytes);
  const { buffer, byteOffset, length } = ordered;
  return sidecar.dataType === "int16"
    ? new Int16Array(buffer, byteOffset, length / BYTES_PER_VOXEL)
    : new Uint16Array(buffer, byteOffset, length / BYTES_PER_VOXEL);
}

function swapPairs(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1]!;
    out[i + 1] = bytes[i]!;
  }
  return out;
}

/**
 * Build a volume from a sidecar and its block of voxels.
 *
 * The result is the same `Volume` that `buildVolume` makes from the DICOM
 * files of the same series. `packed.test.ts` asserts that, which is the only
 * thing that keeps the packer and this reader in step.
 *
 * @throws {PackedFormatError} when the block does not hold `dims` voxels.
 */
export function volumeFromPacked(sidecar: PackedSidecar, voxels: ArrayBuffer): Volume {
  const [nx, ny, nz] = sidecar.dims;
  const expected = nx * ny * nz * BYTES_PER_VOXEL;
  if (voxels.byteLength !== expected) {
    throw new PackedFormatError(
      `${sidecar.url} holds ${voxels.byteLength} bytes, but ${nx}x${ny}x${nz} needs ${expected}`,
    );
  }

  return {
    dims: sidecar.dims,
    spacing: sidecar.spacing,
    origin: sidecar.origin,
    axes: sidecar.axes,
    voxelToPatient: sidecar.voxelToPatient,
    data: readVoxels(sidecar, voxels),
    signed: sidecar.dataType === "int16",
    rescaleSlope: sidecar.rescaleSlope,
    rescaleIntercept: sidecar.rescaleIntercept,
    valueRange: sidecar.valueRange,
    windowCenter: sidecar.windowCenter,
    windowWidth: sidecar.windowWidth,
    description: sidecar.description,
    modality: sidecar.modality,
    seriesInstanceUid: sidecar.seriesInstanceUid,
    frameOfReferenceUid: sidecar.frameOfReferenceUid,
    warnings: sidecar.warnings,
  };
}
