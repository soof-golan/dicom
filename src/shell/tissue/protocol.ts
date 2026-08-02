/**
 * What the main thread and the structure worker say to each other.
 *
 * The labels travel as raw arrays, not as a `StructureField`, because the
 * voxel lists inside a component report would double the size of the message
 * and the viewer never reads them.
 */
import type { StructureClass } from "../../core/tissue/structures.ts";
import type { ShapeKind } from "../../core/tissue/shape.ts";
import type { Volume } from "../../core/volume/build.ts";

export interface ToStructureWorker {
  readonly t1: Volume;
  readonly fatsat: Volume;
  /** A volume with cubic voxels, when the study has one. */
  readonly shapeVolume?: Volume;
}

/** One component, small enough for the panel to list. */
export interface StructureSummary {
  readonly id: number;
  readonly structure: StructureClass;
  readonly confidence: number;
  readonly reason: string;
  readonly voxels: number;
  readonly kind: ShapeKind;
}

export interface StructureResult {
  readonly type: "structures";
  readonly dims: readonly [number, number, number];
  readonly patientToVoxel: readonly number[];
  readonly labels: Uint8Array;
  readonly confidence: Uint8Array;
  readonly darkVoxels: number;
  readonly namedVoxels: number;
  readonly components: readonly StructureSummary[];
  readonly warnings: readonly string[];
}

export interface StructureFailure {
  readonly type: "failed";
  readonly reason: string;
}

export type FromStructureWorker = StructureResult | StructureFailure;
