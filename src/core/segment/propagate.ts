/**
 * Growing one 2D mask through the slices around it.
 *
 * SAM 2 and SAM 3 can follow an object through a video with a memory encoder
 * and memory attention. The ONNX exports this viewer downloads do not hold
 * those graphs: `onnx-community/sam3-tracker-ONNX` and
 * `onnx-community/sam2.1-hiera-tiny-ONNX` each ship only `vision_encoder` and
 * `prompt_encoder_mask_decoder`, and `Sam3TrackerModel` in transformers.js
 * 4.2.0 is an empty subclass of `Sam2Model` with no video session. Checked on
 * 2026-08-02.
 *
 * So this file does the other thing: it segments the slice the user clicked,
 * then steps outward one slice at a time, and makes the prompt for each new
 * slice out of the mask of the slice before it. Every mask is still a 2D
 * answer to a 2D question, and the model never sees a prompt from a picture it
 * did not read.
 *
 * CAUTION: a walk that never stops draws a confident tube of nothing. The stop
 * rules below are not a refinement. They are the feature.
 */
import { dilate, erode, maskArea, maskBounds, maskCentroid, type MaskBounds } from "./mask.ts";
import type { Mask } from "./types.ts";

/** Why a walk stopped on one side of the seed. */
export type StopCause = "edge" | "vanished" | "collapsed" | "leaked" | "low-score" | "limit";

export interface GrowthLimits {
  /** The most slices one seed may travel on each side. */
  readonly maxSlices: number;
  /** The smallest mask worth keeping, in pixels of the model's frame. */
  readonly minArea: number;
  /** Stop when a slice covers more than this many times the slice before it. */
  readonly growthRatio: number;
  /** Stop when the model rates its own mask below this. */
  readonly minScore: number;
  /** How much wider than the last mask the next box prompt is. */
  readonly boxMargin: number;
}

/**
 * The limits a walk runs with.
 *
 * The numbers come from what goes wrong. A mask that triples between two
 * slices has jumped into the tissue next to it, and a mask under about 24
 * pixels of a 1024-pixel frame is noise. Both are cheap to test and neither
 * needs the user to understand a threshold.
 */
export const DEFAULT_GROWTH: GrowthLimits = {
  maxSlices: 32,
  minArea: 24,
  growthRatio: 2.5,
  minScore: 0.5,
  boxMargin: 0.12,
};

/**
 * Judge one grown slice.
 *
 * Nothing means keep the slice and go on. A cause means drop the slice and
 * stop: a slice that fails one of these tests is not evidence of anything.
 */
export function judgeSlice(
  previousArea: number,
  area: number,
  score: number,
  limits: GrowthLimits,
): StopCause | undefined {
  if (area === 0) return "vanished";
  if (area < limits.minArea) return "collapsed";
  if (previousArea > 0 && area > previousArea * limits.growthRatio) return "leaked";
  if (score < limits.minScore) return "low-score";
  return undefined;
}

const MESSAGES: Record<StopCause, string> = {
  edge: "The walk reached the end of the volume.",
  vanished: "The mask went empty. The structure ends here.",
  collapsed: "The mask became too small to report. The structure ends here.",
  leaked: "The mask jumped into the tissue next to it. The walk stopped and dropped that slice.",
  "low-score": "The model rated its own mask low. The walk stopped and dropped that slice.",
  limit: "The walk reached the slice limit. Click further along to go on.",
};

/** Plain words for a stop, so a user can tell an end from a failure. */
export function stopMessage(cause: StopCause): string {
  return MESSAGES[cause];
}

/**
 * A point well inside a mask, to prompt the next slice with.
 *
 * The middle of area of a ring falls in its hole, so erosion runs first and
 * pulls the point away from the edge. A mask too thin to erode keeps its own
 * pixels, and the nearest set pixel to the middle wins.
 */
export function interiorPoint(mask: Mask): { x: number; y: number } | undefined {
  let deepest = mask;
  for (let round = 0; round < 2; round += 1) {
    const smaller = erode(deepest);
    if (maskArea(smaller) === 0) break;
    deepest = smaller;
  }

  const centre = maskCentroid(deepest);
  if (!centre) return undefined;

  const x = Math.round(centre.x);
  const y = Math.round(centre.y);
  if (deepest.data[y * deepest.width + x] !== 0) return { x, y };

  let best: { x: number; y: number } | undefined;
  let nearest = Infinity;
  for (let py = 0; py < deepest.height; py += 1) {
    for (let px = 0; px < deepest.width; px += 1) {
      if (deepest.data[py * deepest.width + px] === 0) continue;
      const distance = (px - centre.x) ** 2 + (py - centre.y) ** 2;
      if (distance < nearest) {
        nearest = distance;
        best = { x: px, y: py };
      }
    }
  }
  return best;
}

/**
 * The box to prompt the next slice with.
 *
 * The box is the box of this mask, opened by a margin. A structure moves a
 * little between slices, and a box that fits the last slice exactly would cut
 * the next one off.
 */
export function promptBox(mask: Mask, margin: number): MaskBounds | undefined {
  const bounds = maskBounds(mask);
  if (!bounds) return undefined;
  const padX = (bounds.x1 - bounds.x0) * margin;
  const padY = (bounds.y1 - bounds.y0) * margin;
  return {
    x0: Math.max(0, bounds.x0 - padX),
    y0: Math.max(0, bounds.y0 - padY),
    x1: Math.min(mask.width, bounds.x1 + padX),
    y1: Math.min(mask.height, bounds.y1 + padY),
  };
}

/**
 * The depths a walk visits, in order, on one side of the seed.
 *
 * The list stops at the edge of the volume and at the slice limit, so the
 * caller can never ask for a cut that holds no data.
 */
export function growthDepths(
  seed: number,
  step: number,
  direction: 1 | -1,
  maxSlices: number,
  range: { readonly min: number; readonly max: number },
): number[] {
  if (step <= 0) return [];
  const depths: number[] = [];
  for (let index = 1; index <= maxSlices; index += 1) {
    const depth = seed + direction * step * index;
    if (depth < range.min || depth > range.max) break;
    depths.push(depth);
  }
  return depths;
}

/** Smooth a mask a little, so one stray pixel cannot seed the next slice. */
export function tidyMask(mask: Mask): Mask {
  return dilate(erode(mask));
}
