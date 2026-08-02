/**
 * Where a prompt sits in the patient, and which cut it belongs to.
 *
 * A click is a point in patient millimetres, never a pixel and never a slice
 * number. Millimetres survive a pan, a zoom, a rotation, a window change and a
 * change of series, because none of those move the patient.
 *
 * One number then names the cut a click was made on: the distance along the
 * normal of the pane. Two clicks belong to one cut while they sit inside one
 * voxel slab, and the model reads that cut once for both.
 */
import { dot, scale, type Vec3 } from "../geometry/vec3.ts";
import {
  NO_PAN,
  patientBounds,
  standardPlane,
  type Bounds,
  type CutPlane,
  type PlaneId,
} from "../view/planes.ts";
import type { Volume } from "../volume/build.ts";
import { voxelExtentAlong } from "./project.ts";

const ORIGIN: Vec3 = [0, 0, 0];

/**
 * How far a mark stays on screen after the cut leaves it, in millimetres.
 *
 * A user must see what they already told the model. A mark from a nearby slice
 * therefore stays visible and fades, and only a mark from far away goes.
 */
export const PROMPT_FADE_MM = 20;

/** The unit normal of a standard pane. */
export function planeNormal(volume: Volume, id: PlaneId): Vec3 {
  return standardPlane(volume, id, ORIGIN).normal;
}

/** How far a patient point sits along the normal of a standard pane. */
export function depthOf(volume: Volume, id: PlaneId, patient: Vec3): number {
  return dot(patient, planeNormal(volume, id));
}

/**
 * The cut at a depth, with no pan.
 *
 * Pan moves the view and not the patient, so a stored prompt must rebuild the
 * same cut whatever the user panned to. If pan came in here, every drag would
 * make a new cut and the vision encoder would run again for seconds.
 */
export function cutAtDepth(volume: Volume, id: PlaneId, depth: number): CutPlane {
  return standardPlane(volume, id, scale(planeNormal(volume, id), depth), NO_PAN);
}

/** How thick the voxel slab under a standard pane is, in millimetres. */
export function sliceThickness(volume: Volume, id: PlaneId): number {
  return voxelExtentAlong(volume, planeNormal(volume, id));
}

/**
 * The depths of a pane that hold data.
 *
 * The volume is a rotated box, so the ends come from its eight corners and not
 * from its dimensions. A walk that leaves this range reads only black.
 */
export function depthRange(volume: Volume, id: PlaneId): { min: number; max: number } {
  const normal = planeNormal(volume, id);
  const bounds = patientBounds(volume);
  let min = Infinity;
  let max = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const depth = dot([x, y, z], normal);
        min = Math.min(min, depth);
        max = Math.max(max, depth);
      }
    }
  }
  return { min, max };
}

/** Two depths name one cut while they sit inside one voxel slab. */
export function sameCut(a: number, b: number, thickness: number): boolean {
  return Math.abs(a - b) <= thickness / 2 + 1e-9;
}

/** A cut runs through a slab when it is inside half a voxel of it. */
export function onCut(sliceDepth: number, cutDepth: number, thickness: number): boolean {
  return sameCut(sliceDepth, cutDepth, thickness);
}

export interface SliceId {
  readonly seriesUid: string;
  readonly plane: PlaneId;
  readonly depth: number;
}

/**
 * A stable name for one cut of one series.
 *
 * The series is part of the name because the model reads an image, and two
 * series give different images of the same millimetres.
 */
export function sliceKey(id: SliceId): string {
  return `${id.seriesUid}|${id.plane}|${id.depth.toFixed(3)}`;
}

export interface CutGroup<T extends { readonly plane: PlaneId; readonly depth: number }> {
  readonly plane: PlaneId;
  readonly depth: number;
  readonly members: readonly T[];
}

/**
 * Collect prompts that share a cut.
 *
 * The first member of a group fixes the depth of the group. A later member
 * never moves it, so a long chain of near clicks cannot drift off the slice.
 */
export function groupByCut<T extends { readonly plane: PlaneId; readonly depth: number }>(
  items: readonly T[],
  thickness: number,
): readonly CutGroup<T>[] {
  const groups: { plane: PlaneId; depth: number; members: T[] }[] = [];
  for (const item of items) {
    const found = groups.find(
      (group) => group.plane === item.plane && sameCut(group.depth, item.depth, thickness),
    );
    if (found) found.members.push(item);
    else groups.push({ plane: item.plane, depth: item.depth, members: [item] });
  }
  return groups;
}

/**
 * How strongly to draw a mark, from its distance off the current cut.
 *
 * A mark on its own slab draws in full. Past the slab it fades to nothing
 * across the fade range, which tells the user the click is real but elsewhere.
 */
export function promptOpacity(offset: number, thickness: number): number {
  const distance = Math.abs(offset);
  const near = thickness / 2;
  if (distance <= near) return 1;
  if (distance >= PROMPT_FADE_MM) return 0;
  return (PROMPT_FADE_MM - distance) / (PROMPT_FADE_MM - near);
}

/** True when a click landed outside the box that holds every voxel. */
export function outsideVolume(bounds: Bounds, patient: Vec3): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (patient[axis]! < bounds.min[axis]! || patient[axis]! > bounds.max[axis]!) return true;
  }
  return false;
}
