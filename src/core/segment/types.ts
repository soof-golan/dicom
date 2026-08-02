/**
 * The shapes that segmentation works with.
 *
 * A mask is always flat bytes, one byte per pixel, 0 or 1. That keeps every
 * operation in this folder a plain loop, and it keeps the boundary with the
 * worker cheap: a `Uint8Array` transfers, a nested array does not.
 */
import type { Vec3 } from "../geometry/vec3.ts";
import type { PlaneId } from "../view/planes.ts";

/** One click. Coordinates are pixels in the frame that the mask lives in. */
export interface PointPrompt {
  readonly kind: "point";
  readonly x: number;
  readonly y: number;
  /** A positive point pulls the mask in. A negative point pushes it out. */
  readonly positive: boolean;
}

/** One drawn rectangle, in the same pixel coordinates as a point prompt. */
export interface BoxPrompt {
  readonly kind: "box";
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** One noun phrase. Read `docs/segmentation.md` before you trust the result. */
export interface TextPrompt {
  readonly kind: "text";
  readonly text: string;
}

export type Prompt = PointPrompt | BoxPrompt | TextPrompt;

export type SegmentSource = "click" | "box" | "text";

/** A binary image. `data[y * width + x]` is 0 or 1. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * A mask as run lengths.
 *
 * The runs alternate, and the first run is always a run of 0. A run of length 0
 * starts the list when the first pixel is set. The lengths add up to
 * `width * height`.
 */
export interface RleMask {
  readonly width: number;
  readonly height: number;
  readonly runs: Uint32Array;
}

/**
 * Where a pixel grid sits in the patient.
 *
 * `origin` is the middle of the grid, not a corner. `u` points right across the
 * grid and `v` points down it. Both are unit vectors in patient millimeters.
 * `spanX` and `spanY` give the size of the whole grid in millimeters.
 */
export interface MaskFrame {
  readonly width: number;
  readonly height: number;
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly spanX: number;
  readonly spanY: number;
}

/** One result that the user keeps. */
export interface Segment {
  readonly id: string;
  readonly label: string;
  readonly source: SegmentSource;
  /**
   * Run lengths, not bytes. A study can hold many segments at once, and a
   * 1024x1024 mask costs 1 MB flat but only a few hundred bytes as runs.
   */
  readonly mask: RleMask;
  /** A hex colour from `palette.ts`. */
  readonly colour: string;
  /** The model's own estimate of quality, 0 to 1. */
  readonly score: number;
  /** The cut that the user drew on. */
  readonly plane: PlaneId;
  /** Where the mask sits in the patient, so a later view can redraw it. */
  readonly frame: MaskFrame;
}

/** A window transform, the same one the shader uses. */
export interface Window {
  readonly center: number;
  readonly width: number;
}
