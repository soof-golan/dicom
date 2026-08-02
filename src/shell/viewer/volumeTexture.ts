/**
 * Uploading a volume to the GPU.
 *
 * The texture holds normalized stored values as half floats. Half float is the
 * smallest format that the hardware can filter, so trilinear interpolation
 * costs one texture read instead of eight. The scale and bias that undo the
 * normalization travel to the shader as uniforms, so no precision is lost in
 * the numbers the viewer reports.
 */
import { Data3DTexture, FloatType, LinearFilter, RedFormat, HalfFloatType } from "three";
import type { Volume } from "../../core/volume/build.ts";
import { invertAffine, type Mat4 } from "../../core/geometry/vec3.ts";
import { muscleRange } from "../../core/tissue/scale.ts";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/**
 * Convert a float in [0, 1] to its half-float bits.
 *
 * Subnormal results flush to zero. The smallest normal half float is about
 * 6e-5, far below one step of a 16-bit scan, so nothing visible is lost.
 */
function toHalf(value: number): number {
  f32[0] = value;
  const bits = u32[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((bits & 0x7fffff) >>> 13);
}

export interface VolumeTexture {
  readonly texture: Data3DTexture;
  /** Undoes the normalization: `stored = normalized * scale + bias`. */
  readonly storedScale: number;
  readonly storedBias: number;
  /**
   * Where tissue sits in this texture, from 0 to 1.
   *
   * The tissue classifier needs it, and it costs a pass over the data, so it is
   * measured once here rather than every time the active series changes.
   */
  readonly signalRange: { readonly low: number; readonly high: number };
  readonly patientToVoxel: Mat4;
  readonly volume: Volume;
  dispose(): void;
}

export function createVolumeTexture(volume: Volume): VolumeTexture {
  const [nx, ny, nz] = volume.dims;
  const { min, max } = volume.valueRange;
  const span = max - min || 1;
  const inverseSpan = 1 / span;

  const source = volume.data;
  const half = new Uint16Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    half[i] = toHalf((source[i]! - min) * inverseSpan);
  }

  const texture = new Data3DTexture(half, nx, ny, nz);
  texture.format = RedFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return {
    texture,
    storedScale: span,
    storedBias: min,
    signalRange: muscleRange(volume),
    patientToVoxel: invertAffine(volume.voxelToPatient),
    volume,
    dispose: () => texture.dispose(),
  };
}

/** Half float is enough for display. This is here so the choice stays visible. */
export const TEXTURE_TYPE = HalfFloatType satisfies typeof HalfFloatType | typeof FloatType;
