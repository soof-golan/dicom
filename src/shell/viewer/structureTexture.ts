/**
 * Uploading the structure labels to the GPU.
 *
 * Two bytes per voxel: the label in red and the confidence in green. Nearest
 * filtering is not a choice about quality. A label is a name, and the average
 * of `cortex` and `tendon` is not a tissue.
 */
import { Data3DTexture, NearestFilter, RGFormat, UnsignedByteType } from "three";
import type { StructureResult } from "../tissue/protocol.ts";

export interface StructureTexture {
  readonly texture: Data3DTexture;
  readonly dims: readonly [number, number, number];
  readonly patientToVoxel: readonly number[];
  dispose(): void;
}

export function createStructureTexture(result: StructureResult): StructureTexture {
  const [nx, ny, nz] = result.dims;
  const packed = new Uint8Array(nx * ny * nz * 2);
  for (let index = 0; index < result.labels.length; index += 1) {
    packed[index * 2] = result.labels[index]!;
    packed[index * 2 + 1] = result.confidence[index]!;
  }

  const texture = new Data3DTexture(packed, nx, ny, nz);
  texture.format = RGFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return {
    texture,
    dims: result.dims,
    patientToVoxel: result.patientToVoxel,
    dispose: () => texture.dispose(),
  };
}
