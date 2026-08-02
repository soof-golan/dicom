/**
 * The segmentation session: several objects, each built from many cuts.
 *
 * Every function here takes a session and returns a new one. Nothing touches
 * the DOM, the GPU or the network, so the whole interaction model has tests
 * without a browser.
 *
 * Two rules hold the model together. A prompt is a point in patient
 * millimetres, so it survives every view change. A mask belongs to the one cut
 * its prompts were placed on, because the model reads one 2D image at a time.
 * An object is therefore a set of 2D masks on known cuts, and never a guess
 * about the slices between them.
 */
import { dot, type Vec3 } from "../geometry/vec3.ts";
import type { PlaneId } from "../view/planes.ts";
import type { Volume } from "../volume/build.ts";
import { decodeRle } from "./mask.ts";
import { nextColour } from "./palette.ts";
import { maskVoxelIndices } from "./project.ts";
import type { StopCause } from "./propagate.ts";
import { onCut, planeNormal, promptOpacity, sameCut, sliceKey } from "./slice.ts";
import type { MaskFrame, RleMask } from "./types.ts";

/** How many user actions the session can take back. */
export const UNDO_DEPTH = 32;

/** One click, kept where the user put it: in the patient. */
export interface Anchor {
  readonly patient: Vec3;
  /** A positive click pulls the mask in. A negative click pushes it out. */
  readonly positive: boolean;
}

/** One drawn rectangle, by two opposite corners in patient millimetres. */
export interface BoxAnchor {
  readonly start: Vec3;
  readonly end: Vec3;
}

/** What the model returned for one cut. */
export interface MaskPart {
  readonly frame: MaskFrame;
  readonly mask: RleMask;
  /** The model's own estimate of quality, 0 to 1. */
  readonly score: number;
}

/**
 * Who put a mask on a slice.
 *
 * A slice the user clicked and a slice a walk inferred are different claims.
 * The interface must never show them the same way.
 */
export type CutOrigin = "user" | "grown";

/** Every prompt that one object has on one cut, and the mask they made. */
export interface PromptCut {
  readonly key: string;
  readonly plane: PlaneId;
  readonly seriesUid: string;
  /** Millimetres along the plane normal. This is what names the slice. */
  readonly depth: number;
  readonly origin: CutOrigin;
  readonly points: readonly Anchor[];
  readonly box: BoxAnchor | undefined;
  /** Nothing while the model runs, or after a prompt changed. */
  readonly part: MaskPart | undefined;
}

/** What one walk through the slices did, and why it stopped. */
export interface Growth {
  readonly plane: PlaneId;
  readonly seedDepth: number;
  /** How many grown slices the walk kept, over both sides. */
  readonly kept: number;
  /** How far the object reaches through the slices, in millimetres. */
  readonly reachMillimetres: number;
  readonly up: StopCause;
  readonly down: StopCause;
}

/** One thing the user is building. The user names it; nothing else does. */
export interface SegmentObject {
  readonly id: string;
  readonly label: string;
  readonly colour: string;
  readonly hidden: boolean;
  readonly cuts: readonly PromptCut[];
  /** The last walk through the slices, or nothing when none ran. */
  readonly growth: Growth | undefined;
}

/** The cut whose mask the shell must ask the model for. */
export interface PromptTarget {
  readonly objectId: string;
  readonly cutKey: string;
}

/** Where a click landed, in the patient and on a pane. */
export interface PromptPlace {
  readonly plane: PlaneId;
  readonly seriesUid: string;
  readonly depth: number;
  readonly patient: Vec3;
}

interface Step {
  readonly objects: readonly SegmentObject[];
  readonly activeId: string | undefined;
}

export interface Session {
  readonly objects: readonly SegmentObject[];
  /** New clicks go to this object. */
  readonly activeId: string | undefined;
  /** The cut that needs a mask, or nothing when the model is up to date. */
  readonly pending: PromptTarget | undefined;
  readonly counter: number;
  readonly past: readonly Step[];
}

export function emptySession(): Session {
  return { objects: [], activeId: undefined, pending: undefined, counter: 0, past: [] };
}

export function activeObject(session: Session): SegmentObject | undefined {
  return session.objects.find((object) => object.id === session.activeId);
}

export function findObject(session: Session, id: string): SegmentObject | undefined {
  return session.objects.find((object) => object.id === id);
}

export function findCut(object: SegmentObject, key: string): PromptCut | undefined {
  return object.cuts.find((cut) => cut.key === key);
}

/** How many clicks and boxes an object holds, across every cut. */
export function promptCount(object: SegmentObject): number {
  return object.cuts.reduce((total, cut) => total + cut.points.length + (cut.box ? 1 : 0), 0);
}

export function canUndo(session: Session): boolean {
  return session.past.length > 0;
}

/** Remember the state before a user action, so undo can return to it. */
function remember(session: Session): readonly Step[] {
  const step: Step = { objects: session.objects, activeId: session.activeId };
  return [...session.past, step].slice(-UNDO_DEPTH);
}

/** Take back the last user action. A mask from the model is not one. */
export function undo(session: Session): Session {
  const step = session.past.at(-1);
  if (!step) return session;
  return {
    ...session,
    objects: step.objects,
    activeId: step.activeId,
    pending: undefined,
    past: session.past.slice(0, -1),
  };
}

export function addObject(session: Session, label?: string): Session {
  const counter = session.counter + 1;
  const object: SegmentObject = {
    id: `object-${counter}`,
    label: label ?? `Object ${session.objects.length + 1}`,
    colour: nextColour(session.objects.map((entry) => entry.colour)),
    hidden: false,
    cuts: [],
    growth: undefined,
  };
  return {
    ...session,
    past: remember(session),
    objects: [...session.objects, object],
    activeId: object.id,
    pending: undefined,
    counter,
  };
}

export function selectObject(session: Session, id: string): Session {
  if (!findObject(session, id)) return session;
  return { ...session, past: remember(session), activeId: id, pending: undefined };
}

export function renameObject(session: Session, id: string, label: string): Session {
  const clean = label.trim();
  if (clean.length === 0) return session;
  return edit(session, id, (object) => ({ ...object, label: clean }));
}

export function setObjectHidden(session: Session, id: string, hidden: boolean): Session {
  return edit(session, id, (object) => ({ ...object, hidden }));
}

export function removeObject(session: Session, id: string): Session {
  const objects = session.objects.filter((object) => object.id !== id);
  if (objects.length === session.objects.length) return session;
  const activeId = session.activeId === id ? objects.at(-1)?.id : session.activeId;
  return { ...session, past: remember(session), objects, activeId, pending: undefined };
}

function edit(
  session: Session,
  id: string,
  change: (object: SegmentObject) => SegmentObject,
): Session {
  if (!findObject(session, id)) return session;
  return {
    ...session,
    past: remember(session),
    objects: session.objects.map((object) => (object.id === id ? change(object) : object)),
  };
}

/** The cut of an object that a click joins, or nothing when it opens a new one. */
function cutFor(
  object: SegmentObject,
  place: PromptPlace,
  thickness: number,
): PromptCut | undefined {
  return object.cuts.find(
    (cut) =>
      cut.plane === place.plane &&
      cut.seriesUid === place.seriesUid &&
      sameCut(cut.depth, place.depth, thickness),
  );
}

function emptyCut(place: PromptPlace, origin: CutOrigin): PromptCut {
  return {
    key: sliceKey(place),
    plane: place.plane,
    seriesUid: place.seriesUid,
    depth: place.depth,
    origin,
    points: [],
    box: undefined,
    part: undefined,
  };
}

/**
 * Put a prompt on the active object.
 *
 * The mask of the cut that changed goes away at once. A mask that no longer
 * matches its prompts must never stay on screen: the user would read it as the
 * answer to a question they have already changed.
 */
function withPrompt(
  session: Session,
  place: PromptPlace,
  thickness: number,
  change: (cut: PromptCut) => PromptCut,
): Session {
  const started = session.activeId === undefined ? addObject(session) : session;
  const object = activeObject(started)!;
  const existing = cutFor(object, place, thickness);
  const base = existing ?? emptyCut(place, "user");
  // A click on a grown slice takes it over. The user has corrected the walk,
  // and the slice now carries a claim they made themselves.
  const updated: PromptCut = { ...change(base), origin: "user", part: undefined };
  const cuts = existing
    ? object.cuts.map((cut) => (cut.key === existing.key ? updated : cut))
    : [...object.cuts, updated];

  return {
    ...started,
    // A new object already remembered the state before it. Adding another step
    // would make undo need two presses to take back one click.
    past: session.activeId === undefined ? started.past : remember(session),
    objects: started.objects.map((entry) => (entry.id === object.id ? { ...entry, cuts } : entry)),
    pending: { objectId: object.id, cutKey: updated.key },
  };
}

export function addPoint(
  session: Session,
  place: PromptPlace,
  positive: boolean,
  thickness: number,
): Session {
  return withPrompt(session, place, thickness, (cut) => ({
    ...cut,
    points: [...cut.points, { patient: place.patient, positive }],
  }));
}

export function setBox(
  session: Session,
  place: PromptPlace,
  start: Vec3,
  end: Vec3,
  thickness: number,
): Session {
  return withPrompt(session, place, thickness, (cut) => ({ ...cut, box: { start, end } }));
}

/** Take back the newest prompt of one cut, and leave the cut when it is empty. */
export function clearCut(session: Session, objectId: string, cutKey: string): Session {
  const object = findObject(session, objectId);
  if (!object || !findCut(object, cutKey)) return session;
  return {
    ...edit(session, objectId, (entry) => ({
      ...entry,
      cuts: entry.cuts.filter((cut) => cut.key !== cutKey),
    })),
    pending: undefined,
  };
}

/**
 * Record the mask that the model made for one cut.
 *
 * This is not a user action, so it does not join the undo history. A user who
 * presses undo wants their click back, not the mask that followed it.
 */
export function attachPart(
  session: Session,
  objectId: string,
  cutKey: string,
  part: MaskPart,
): Session {
  const object = findObject(session, objectId);
  if (!object || !findCut(object, cutKey)) return session;
  const pending =
    session.pending?.objectId === objectId && session.pending.cutKey === cutKey
      ? undefined
      : session.pending;
  return {
    ...session,
    pending,
    objects: session.objects.map((entry) =>
      entry.id !== objectId
        ? entry
        : {
            ...entry,
            cuts: entry.cuts.map((cut) => (cut.key === cutKey ? { ...cut, part } : cut)),
          },
    ),
  };
}

/**
 * Put a mask on a slice that a walk reached, not the user.
 *
 * The slice carries no prompt, so nothing waits for the model. A walk that
 * reaches the same slice twice replaces what it left there before.
 */
export function addGrown(
  session: Session,
  objectId: string,
  place: PromptPlace,
  part: MaskPart,
): Session {
  const object = findObject(session, objectId);
  if (!object) return session;
  const cut: PromptCut = { ...emptyCut(place, "grown"), part };
  const existing = object.cuts.find((entry) => entry.key === cut.key);
  const cuts = existing
    ? object.cuts.map((entry) => (entry.key === cut.key ? cut : entry))
    : [...object.cuts, cut];
  return {
    ...session,
    objects: session.objects.map((entry) => (entry.id === objectId ? { ...entry, cuts } : entry)),
  };
}

/** Take away every slice a walk made, and keep every slice the user clicked. */
export function clearGrown(session: Session, objectId: string): Session {
  return edit(session, objectId, (object) => ({
    ...object,
    cuts: object.cuts.filter((cut) => cut.origin === "user"),
    growth: undefined,
  }));
}

/** Record what a walk did, so the panel can say why it stopped. */
export function setGrowth(session: Session, objectId: string, growth: Growth): Session {
  return edit(session, objectId, (object) => ({ ...object, growth }));
}

/** How many slices of an object the user clicked, and how many a walk made. */
export function cutCounts(object: SegmentObject): { user: number; grown: number } {
  let user = 0;
  let grown = 0;
  for (const cut of object.cuts) {
    if (cut.origin === "user") user += 1;
    else grown += 1;
  }
  return { user, grown };
}

export interface VisiblePart {
  readonly objectId: string;
  readonly colour: string;
  readonly active: boolean;
  readonly origin: CutOrigin;
  readonly part: MaskPart;
}

/**
 * The masks to draw on one cut, in the order to draw them.
 *
 * The order is the order the objects were made in, so where two objects
 * overlap the newer one covers the older one. That rule is simple to state and
 * matches the order of the list in the panel.
 */
export function visibleParts(
  session: Session,
  plane: PlaneId,
  cutDepth: number,
  thickness: number,
): readonly VisiblePart[] {
  const found: VisiblePart[] = [];
  for (const object of session.objects) {
    if (object.hidden) continue;
    for (const cut of object.cuts) {
      if (cut.plane !== plane || !cut.part) continue;
      if (!onCut(cut.depth, cutDepth, thickness)) continue;
      found.push({
        objectId: object.id,
        colour: object.colour,
        active: object.id === session.activeId,
        origin: cut.origin,
        part: cut.part,
      });
    }
  }
  return found;
}

export interface PromptMark {
  readonly objectId: string;
  readonly colour: string;
  readonly active: boolean;
  readonly patient: Vec3;
  readonly positive: boolean;
  /** 1 on the cut the click was made on, less as the cut moves away. */
  readonly opacity: number;
}

export interface BoxMark {
  readonly objectId: string;
  readonly colour: string;
  readonly active: boolean;
  readonly box: BoxAnchor;
  readonly opacity: number;
}

/** Every click to draw on one cut, with how strongly to draw it. */
export function promptMarks(
  session: Session,
  plane: PlaneId,
  cutDepth: number,
  thickness: number,
): readonly PromptMark[] {
  const marks: PromptMark[] = [];
  for (const object of session.objects) {
    if (object.hidden) continue;
    for (const cut of object.cuts) {
      if (cut.plane !== plane) continue;
      const opacity = promptOpacity(cut.depth - cutDepth, thickness);
      if (opacity === 0) continue;
      for (const point of cut.points) {
        marks.push({
          objectId: object.id,
          colour: object.colour,
          active: object.id === session.activeId,
          patient: point.patient,
          positive: point.positive,
          opacity,
        });
      }
    }
  }
  return marks;
}

/** Every box to draw on one cut, with how strongly to draw it. */
export function boxMarks(
  session: Session,
  plane: PlaneId,
  cutDepth: number,
  thickness: number,
): readonly BoxMark[] {
  const marks: BoxMark[] = [];
  for (const object of session.objects) {
    if (object.hidden) continue;
    for (const cut of object.cuts) {
      if (cut.plane !== plane || !cut.box) continue;
      const opacity = promptOpacity(cut.depth - cutDepth, thickness);
      if (opacity === 0) continue;
      marks.push({
        objectId: object.id,
        colour: object.colour,
        active: object.id === session.activeId,
        box: cut.box,
        opacity,
      });
    }
  }
  return marks;
}

/**
 * The voxels that an object covers.
 *
 * The masks are flat, and they lie on cuts that can cross each other. A union
 * of the voxels under them counts a shared voxel once, which no sum of areas
 * can do.
 */
export function objectVoxelIndices(volume: Volume, object: SegmentObject): Int32Array {
  const found = new Set<number>();
  for (const cut of object.cuts) {
    if (!cut.part) continue;
    for (const index of maskVoxelIndices(volume, cut.part.frame, decodeRle(cut.part.mask))) {
      found.add(index);
    }
  }
  return Int32Array.from([...found].sort((a, b) => a - b));
}

/**
 * How much of the patient an object covers, in cubic millimetres.
 *
 * This counts only the slices the user prompted on. It says nothing about the
 * slices between them, because the model was never asked about those.
 */
export function objectVolumeCubicMillimeters(volume: Volume, object: SegmentObject): number {
  const voxel = volume.spacing[0] * volume.spacing[1] * volume.spacing[2];
  return objectVoxelIndices(volume, object).length * voxel;
}

/** The cuts of an object, newest first, for a list the user can jump from. */
export function cutsOf(session: Session): readonly { object: SegmentObject; cut: PromptCut }[] {
  return session.objects.flatMap((object) => object.cuts.map((cut) => ({ object, cut })));
}

/** Where a cut of an object sits, as a point the cursor can move to. */
export function cutCursor(volume: Volume, cut: PromptCut, cursor: Vec3): Vec3 {
  const normal = planeNormal(volume, cut.plane);
  const along = dot(cursor, normal);
  return [
    cursor[0] + normal[0] * (cut.depth - along),
    cursor[1] + normal[1] * (cut.depth - along),
    cursor[2] + normal[2] * (cut.depth - along),
  ];
}
