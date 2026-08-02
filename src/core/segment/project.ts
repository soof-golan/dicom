/**
 * Moving between a mask's pixel grid and the patient.
 *
 * A mask is a flat 2D image. The cut it was drawn on is an arbitrary plane in
 * patient millimeters. Every question the segmentation feature asks reduces to
 * one of two steps: from a pixel to a point in the patient, or back.
 *
 * A `MaskFrame` holds the plane, so a mask keeps its meaning after the user
 * pans, zooms, or resizes the window. The frame never changes after a mask is
 * made. To draw the mask again, resample it into the frame of the new view.
 */
import { applyAffine, cross, dot, invertAffine, normalize, type Vec3 } from "../geometry/vec3.ts";
import type { CutPlane } from "../view/planes.ts";
import type { Volume } from "../volume/build.ts";
import { emptyMask } from "./mask.ts";
import type { Mask, MaskFrame, Window } from "./types.ts";

/** A point in a frame: pixel coordinates plus the distance off the plane. */
export interface FramePoint {
  readonly x: number;
  readonly y: number;
  /** Millimeters along the frame normal. 0 means the point is on the plane. */
  readonly depth: number;
}

export function frameNormal(frame: MaskFrame): Vec3 {
  return normalize(cross(frame.u, frame.v));
}

/**
 * The millimeters that a pane shows.
 *
 * A pane is a rectangle of pixels and the plane is a rectangle of millimeters.
 * The two rarely share an aspect ratio, so the view grows along one axis until
 * the whole plane fits. This is the same rule the renderer uses.
 */
export function fitSpan(
  planeSize: readonly [number, number],
  paneWidth: number,
  paneHeight: number,
  zoom: number,
): [number, number] {
  const paneAspect = paneWidth / Math.max(paneHeight, 1);
  const planeAspect = planeSize[0] / Math.max(planeSize[1], 1e-6);
  const fitted: [number, number] =
    planeAspect > paneAspect
      ? [planeSize[0], planeSize[0] / paneAspect]
      : [planeSize[1] * paneAspect, planeSize[1]];
  return [fitted[0] / zoom, fitted[1] / zoom];
}

/** The frame that a pane on screen covers, in its own pixels. */
export function paneFrame(
  plane: CutPlane,
  paneWidth: number,
  paneHeight: number,
  zoom: number,
): MaskFrame {
  const [spanX, spanY] = fitSpan(plane.size, paneWidth, paneHeight, zoom);
  return {
    width: Math.max(Math.round(paneWidth), 1),
    height: Math.max(Math.round(paneHeight), 1),
    origin: plane.origin,
    u: plane.u,
    v: plane.v,
    spanX,
    spanY,
  };
}

/**
 * The frame that the model reads.
 *
 * This covers the whole cut and ignores the pane, so panning and zooming leave
 * it alone. That matters: the vision encoder runs once per frame and takes
 * seconds, while a pan happens many times a second.
 *
 * The pitch is half the finest voxel spacing. Half, not one, because a mask
 * pixel must map back to a voxel index within half a voxel. A pixel of the
 * frame rounds to the nearest whole pixel, which costs up to 0.71 of a pitch
 * on an oblique cut, where the plane axes do not line up with the grid.
 */
export function sliceFrame(volume: Volume, plane: CutPlane, maxSide: number): MaskFrame {
  const pitch = Math.min(...volume.spacing) / 2;
  const wanted = [plane.size[0] / pitch, plane.size[1] / pitch];
  const shrink = Math.min(1, maxSide / Math.max(wanted[0]!, wanted[1]!, 1));
  return {
    width: Math.max(Math.round(wanted[0]! * shrink), 1),
    height: Math.max(Math.round(wanted[1]! * shrink), 1),
    origin: plane.origin,
    u: plane.u,
    v: plane.v,
    spanX: plane.size[0],
    spanY: plane.size[1],
  };
}

/**
 * Patient coordinates of the middle of one pixel.
 *
 * Pixel (0, 0) covers the top left corner of the frame, so its middle sits half
 * a pixel inside it.
 */
export function framePixelToPatient(frame: MaskFrame, x: number, y: number, depth = 0): Vec3 {
  const su = ((x + 0.5) / frame.width - 0.5) * frame.spanX;
  const sv = ((y + 0.5) / frame.height - 0.5) * frame.spanY;
  const n = frameNormal(frame);
  return [
    frame.origin[0] + frame.u[0] * su + frame.v[0] * sv + n[0] * depth,
    frame.origin[1] + frame.u[1] * su + frame.v[1] * sv + n[1] * depth,
    frame.origin[2] + frame.u[2] * su + frame.v[2] * sv + n[2] * depth,
  ];
}

/** The pixel that holds a patient point, and how far the point sits off the plane. */
export function patientToFramePixel(frame: MaskFrame, point: Vec3): FramePoint {
  const offset: Vec3 = [
    point[0] - frame.origin[0],
    point[1] - frame.origin[1],
    point[2] - frame.origin[2],
  ];
  return {
    x: (dot(offset, frame.u) / frame.spanX + 0.5) * frame.width - 0.5,
    y: (dot(offset, frame.v) / frame.spanY + 0.5) * frame.height - 0.5,
    depth: dot(offset, frameNormal(frame)),
  };
}

/** The voxel index under one pixel of a frame. The index may be fractional. */
export function frameToVoxel(
  volume: Volume,
  frame: MaskFrame,
  x: number,
  y: number,
  depth = 0,
): Vec3 {
  return applyAffine(invertAffine(volume.voxelToPatient), framePixelToPatient(frame, x, y, depth));
}

/** The pixel of a frame that a voxel index falls in. */
export function voxelToFrame(volume: Volume, frame: MaskFrame, voxel: Vec3): FramePoint {
  return patientToFramePixel(frame, applyAffine(volume.voxelToPatient, voxel));
}

/**
 * How thick a voxel is along a direction.
 *
 * A cut has no thickness of its own, so a mask needs the depth of the voxels it
 * crosses before it can report a volume. A voxel is a box, and this is the
 * width of that box measured along the direction.
 */
export function voxelExtentAlong(volume: Volume, direction: Vec3): number {
  const unit = normalize(direction);
  let extent = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    extent += Math.abs(dot(volume.axes[axis]!, unit)) * volume.spacing[axis]!;
  }
  return extent;
}

/** The volume that a mask covers, in cubic millimeters. */
export function maskVolumeCubicMillimeters(
  frame: MaskFrame,
  mask: Mask,
  thickness: number,
): number {
  let set = 0;
  for (const value of mask.data) {
    if (value !== 0) set += 1;
  }
  const pixelArea = (frame.spanX / frame.width) * (frame.spanY / frame.height);
  return set * pixelArea * thickness;
}

/**
 * The voxels that a mask covers.
 *
 * The result holds flat indices into `volume.data`, sorted and without repeats.
 * A frame is usually finer than the grid, so many pixels land on one voxel.
 */
export function maskVoxelIndices(volume: Volume, frame: MaskFrame, mask: Mask): Int32Array {
  const [nx, ny, nz] = volume.dims;
  const found = new Set<number>();
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] === 0) continue;
      const voxel = frameToVoxel(volume, frame, x, y);
      const i = Math.round(voxel[0]);
      const j = Math.round(voxel[1]);
      const k = Math.round(voxel[2]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      found.add(k * nx * ny + j * nx + i);
    }
  }
  return Int32Array.from([...found].sort((a, b) => a - b));
}

/**
 * Draw a mask into a different frame.
 *
 * Both frames must lie on the same plane. The depth is ignored, because a mask
 * has no thickness. The caller decides whether the two cuts are close enough
 * for the mask to still apply.
 */
export function resampleMask(mask: Mask, from: MaskFrame, to: MaskFrame): Mask {
  const result = emptyMask(to.width, to.height);
  for (let y = 0; y < to.height; y += 1) {
    for (let x = 0; x < to.width; x += 1) {
      const source = patientToFramePixel(from, framePixelToPatient(to, x, y));
      const sx = Math.round(source.x);
      const sy = Math.round(source.y);
      if (sx < 0 || sy < 0 || sx >= from.width || sy >= from.height) continue;
      result.data[y * to.width + x] = mask.data[sy * from.width + sx] ?? 0;
    }
  }
  return result;
}

/**
 * Read one cut out of the volume as 8-bit gray.
 *
 * The model was trained on photographs, so it needs the picture a radiologist
 * sees, not the stored values. Apply the window first, exactly as the shader
 * does. Anything outside the volume reads as black.
 */
export function sampleSliceGray(volume: Volume, frame: MaskFrame, window: Window): Uint8Array {
  const gray = new Uint8Array(frame.width * frame.height);
  const patientToVoxel = invertAffine(volume.voxelToPatient);
  const [nx, ny, nz] = volume.dims;
  const low = window.center - window.width / 2;
  const span = Math.max(window.width, 1e-6);

  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const voxel = applyAffine(patientToVoxel, framePixelToPatient(frame, x, y));
      const i = Math.round(voxel[0]);
      const j = Math.round(voxel[1]);
      const k = Math.round(voxel[2]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const stored = volume.data[k * nx * ny + j * nx + i] ?? 0;
      const value = stored * volume.rescaleSlope + volume.rescaleIntercept;
      const level = Math.min(Math.max((value - low) / span, 0), 1);
      gray[y * frame.width + x] = Math.round(level * 255);
    }
  }
  return gray;
}
