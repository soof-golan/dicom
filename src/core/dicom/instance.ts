/**
 * One image, described in the terms the viewer needs.
 *
 * This is where the DICOM tag layout stops and the geometry starts. Everything
 * after this module works with vectors, not tags.
 */
import { getNumber, getNumbers, getString } from "./access.ts";
import { cross, normalize, type Vec3 } from "../geometry/vec3.ts";
import type { DicomDataSet } from "./parse.ts";
import { frameCount } from "./pixels.ts";
import { Tag } from "./tags.ts";

export interface Instance {
  readonly dataSet: DicomDataSet;
  readonly sopInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly studyInstanceUid: string;
  /** Series that share this identifier also share a patient coordinate system. */
  readonly frameOfReferenceUid: string;
  readonly modality: string;
  readonly seriesNumber: number;
  readonly instanceNumber: number;
  readonly seriesDescription: string;
  readonly rows: number;
  readonly columns: number;
  readonly frames: number;
  /** Patient coordinates of the center of the first voxel, in millimeters. */
  readonly position: Vec3;
  /** Unit vector along a row, in the direction of rising column index. */
  readonly rowDirection: Vec3;
  /** Unit vector along a column, in the direction of rising row index. */
  readonly columnDirection: Vec3;
  /** Unit normal of the image plane. */
  readonly normal: Vec3;
  /** Millimeters between the centers of two rows. */
  readonly rowSpacing: number;
  /** Millimeters between the centers of two columns. */
  readonly columnSpacing: number;
  readonly sliceThickness?: number;
  readonly spacingBetweenSlices?: number;
}

export class InstanceError extends Error {
  override readonly name = "InstanceError";
}

const DEFAULT_ROW_DIRECTION: Vec3 = [1, 0, 0];
const DEFAULT_COLUMN_DIRECTION: Vec3 = [0, 1, 0];

function vec3(values: readonly number[], at: number): Vec3 | undefined {
  const [x, y, z] = [values[at], values[at + 1], values[at + 2]];
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return [x, y, z];
}

/**
 * Read one image into the viewer's own shape.
 *
 * A file with no geometry still loads. It gets an identity orientation and sits
 * at the origin, so a viewer can show it as a flat image.
 *
 * @throws {InstanceError} if the image has no Rows or Columns.
 */
export function readInstance(dataSet: DicomDataSet): Instance {
  const rows = getNumber(dataSet, Tag.Rows);
  const columns = getNumber(dataSet, Tag.Columns);
  if (!rows || !columns) {
    throw new InstanceError("image has no Rows or Columns and cannot be placed");
  }

  const orientation = getNumbers(dataSet, Tag.ImageOrientationPatient);
  const rowDirection = normalize(vec3(orientation, 0) ?? DEFAULT_ROW_DIRECTION);
  const columnDirection = normalize(vec3(orientation, 3) ?? DEFAULT_COLUMN_DIRECTION);
  const position = vec3(getNumbers(dataSet, Tag.ImagePositionPatient), 0) ?? [0, 0, 0];

  const spacing = getNumbers(dataSet, Tag.PixelSpacing);

  return {
    dataSet,
    sopInstanceUid: getString(dataSet, Tag.SopInstanceUid) ?? "",
    seriesInstanceUid: getString(dataSet, Tag.SeriesInstanceUid) ?? "",
    studyInstanceUid: getString(dataSet, Tag.StudyInstanceUid) ?? "",
    frameOfReferenceUid: getString(dataSet, Tag.FrameOfReferenceUid) ?? "",
    modality: getString(dataSet, Tag.Modality) ?? "OT",
    seriesNumber: getNumber(dataSet, Tag.SeriesNumber) ?? 0,
    instanceNumber: getNumber(dataSet, Tag.InstanceNumber) ?? 0,
    seriesDescription:
      getString(dataSet, Tag.SeriesDescription) ?? getString(dataSet, Tag.ProtocolName) ?? "",
    rows,
    columns,
    frames: frameCount(dataSet),
    position,
    rowDirection,
    columnDirection,
    normal: normalize(cross(rowDirection, columnDirection)),
    // PixelSpacing is [between rows, between columns], in that order.
    rowSpacing: spacing[0] ?? 1,
    columnSpacing: spacing[1] ?? spacing[0] ?? 1,
    sliceThickness: getNumber(dataSet, Tag.SliceThickness),
    spacingBetweenSlices: getNumber(dataSet, Tag.SpacingBetweenSlices),
  };
}
