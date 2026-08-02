import { describe, expect, it } from "vite-plus/test";
import { readSeries } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { dot } from "../geometry/vec3.ts";
import { patientBounds, type PlaneId } from "../view/planes.ts";
import { buildVolume } from "../volume/build.ts";
import { encodeRle } from "./mask.ts";
import { SEGMENT_COLOURS } from "./palette.ts";
import { framePixelToPatient, sliceFrame } from "./project.ts";
import {
  activeObject,
  addGrown,
  addObject,
  addPoint,
  attachPart,
  canUndo,
  clearGrown,
  emptySession,
  findCut,
  objectVolumeCubicMillimeters,
  promptMarks,
  removeObject,
  renameObject,
  selectObject,
  setBox,
  setGrowth,
  setObjectHidden,
  undo,
  UNDO_DEPTH,
  visibleParts,
  type MaskPart,
  type PromptPlace,
  type Session,
} from "./session.ts";
import { cutAtDepth, depthOf, planeNormal, sliceThickness } from "./slice.ts";
import type { Mask } from "./types.ts";

const volume = buildVolume(
  readSeries("pd_tse_fs_cor_DRB").map((bytes) => readInstance(parseDicom(bytes))),
);
const SERIES = volume.seriesInstanceUid;
const THICK = sliceThickness(volume, "axial");
const CENTRE = patientBounds(volume).center;

/** A depth that is offset from the middle of the volume, in millimetres. */
function depthAt(plane: PlaneId, offset = 0): number {
  return dot(CENTRE, planeNormal(volume, plane)) + offset;
}

/** A click on a real cut of a real series, at a fraction across the frame. */
function place(plane: PlaneId, offset = 0, across = 0.5): PromptPlace {
  const frame = sliceFrame(volume, cutAtDepth(volume, plane, depthAt(plane, offset)), 64);
  const patient = framePixelToPatient(
    frame,
    Math.round(frame.width * across),
    Math.round(frame.height * across),
  );
  return { plane, seriesUid: SERIES, depth: depthOf(volume, plane, patient), patient };
}

/** A filled square in the middle of a cut, as the model would return one. */
function square(plane: PlaneId, offset = 0, side = 6): MaskPart {
  const frame = sliceFrame(volume, cutAtDepth(volume, plane, depthAt(plane, offset)), 64);
  const mask: Mask = {
    width: frame.width,
    height: frame.height,
    data: new Uint8Array(frame.width * frame.height),
  };
  const x0 = Math.round(frame.width / 2) - side;
  const y0 = Math.round(frame.height / 2) - side;
  for (let y = y0; y < y0 + side * 2; y += 1) {
    for (let x = x0; x < x0 + side * 2; x += 1) mask.data[y * frame.width + x] = 1;
  }
  return { frame, mask: encodeRle(mask), score: 0.9 };
}

/** Put a click on the active object and give back the cut it landed in. */
function click(session: Session = emptySession(), spot = place("axial"), positive = true) {
  const next = addPoint(session, spot, positive, THICK);
  return { session: next, cutKey: next.pending!.cutKey, objectId: next.pending!.objectId };
}

/** A click and the mask that the model returned for it. */
function clickWithMask(
  session: Session = emptySession(),
  plane: PlaneId = "axial",
  offset = 0,
  across = 0.5,
): Session {
  const made = click(session, place(plane, offset, across));
  return attachPart(made.session, made.objectId, made.cutKey, square(plane, offset));
}

describe("addObject", () => {
  it("makes the new object the active one", () => {
    const session = addObject(addObject(emptySession()));
    expect(session.objects).toHaveLength(2);
    expect(session.activeId).toBe(session.objects[1]!.id);
  });

  it("gives every object its own colour", () => {
    let session = emptySession();
    for (let i = 0; i < SEGMENT_COLOURS.length; i += 1) session = addObject(session);
    expect(new Set(session.objects.map((object) => object.colour)).size).toBe(
      SEGMENT_COLOURS.length,
    );
  });

  it("numbers the objects it names", () => {
    const session = addObject(addObject(emptySession()));
    expect(session.objects.map((object) => object.label)).toEqual(["Object 1", "Object 2"]);
  });

  it("takes a name from the caller", () => {
    expect(addObject(emptySession(), "Lesion").objects[0]!.label).toBe("Lesion");
  });
});

describe("addPoint", () => {
  it("starts an object when none is active", () => {
    const { session } = click();
    expect(session.objects).toHaveLength(1);
    expect(activeObject(session)!.cuts[0]!.points).toHaveLength(1);
  });

  it("sends a click to the active object only", () => {
    let session = addObject(emptySession(), "first");
    session = addObject(session, "second");
    session = click(session).session;
    expect(session.objects[0]!.cuts).toHaveLength(0);
    expect(session.objects[1]!.cuts).toHaveLength(1);
  });

  it("keeps two clicks on one cut together", () => {
    const first = click();
    const second = click(first.session, place("axial", 0, 0.4));
    expect(second.cutKey).toBe(first.cutKey);
    expect(activeObject(second.session)!.cuts).toHaveLength(1);
    expect(activeObject(second.session)!.cuts[0]!.points).toHaveLength(2);
  });

  it("opens a second cut for a click on another slice", () => {
    const first = click();
    const second = click(first.session, place("axial", 40));
    expect(second.cutKey).not.toBe(first.cutKey);
    expect(activeObject(second.session)!.cuts).toHaveLength(2);
  });

  it("opens a second cut for a click in another pane", () => {
    const first = click();
    const second = click(first.session, place("coronal"));
    expect(activeObject(second.session)!.cuts.map((cut) => cut.plane)).toEqual([
      "axial",
      "coronal",
    ]);
  });

  it("keeps the patient point, so no click depends on the view", () => {
    const spot = place("sagittal", 8);
    const { session } = click(emptySession(), spot);
    expect(activeObject(session)!.cuts[0]!.points[0]!.patient).toEqual(spot.patient);
  });

  it("records a negative click apart from a positive one", () => {
    const first = click();
    const second = click(first.session, place("axial", 0, 0.55), false);
    expect(activeObject(second.session)!.cuts[0]!.points.map((point) => point.positive)).toEqual([
      true,
      false,
    ]);
  });

  it("names the cut that the shell must run again", () => {
    const { session, cutKey } = click();
    expect(session.pending).toEqual({ objectId: session.activeId, cutKey });
  });

  it("drops the mask of the cut it changed, so no stale mask stays on screen", () => {
    const session = clickWithMask();
    const key = session.objects[0]!.cuts[0]!.key;
    expect(findCut(session.objects[0]!, key)!.part).toBeDefined();
    const second = click(session, place("axial", 0, 0.45));
    expect(findCut(activeObject(second.session)!, key)!.part).toBeUndefined();
  });

  it("leaves the mask of every other cut alone", () => {
    const session = clickWithMask();
    const next = click(session, place("coronal")).session;
    expect(next.objects[0]!.cuts[0]!.part).toBeDefined();
  });
});

describe("setBox", () => {
  it("puts a box on the cut it was drawn on", () => {
    const spot = place("coronal");
    const corner = place("coronal", 0, 0.7);
    const session = setBox(emptySession(), spot, spot.patient, corner.patient, THICK);
    const cut = activeObject(session)!.cuts[0]!;
    expect(cut.box).toEqual({ start: spot.patient, end: corner.patient });
    expect(session.pending!.cutKey).toBe(cut.key);
  });

  it("replaces the box that the cut already had", () => {
    const spot = place("coronal");
    const first = setBox(
      emptySession(),
      spot,
      spot.patient,
      place("coronal", 0, 0.7).patient,
      THICK,
    );
    const second = setBox(first, spot, spot.patient, place("coronal", 0, 0.6).patient, THICK);
    expect(activeObject(second)!.cuts).toHaveLength(1);
    expect(activeObject(second)!.cuts[0]!.box!.end).not.toEqual(
      activeObject(first)!.cuts[0]!.box!.end,
    );
  });
});

describe("attachPart", () => {
  it("puts the mask on the cut that asked for it", () => {
    expect(clickWithMask().objects[0]!.cuts[0]!.part!.score).toBe(0.9);
  });

  it("clears the pending cut once its mask arrives", () => {
    expect(clickWithMask().pending).toBeUndefined();
  });

  it("ignores a mask for an object that is gone", () => {
    const { session, cutKey } = click();
    expect(attachPart(session, "no-such-object", cutKey, square("axial"))).toBe(session);
  });

  it("cannot be undone, because the model made it and not the user", () => {
    const session = clickWithMask(addObject(emptySession()));
    expect(undo(session).objects[0]!.cuts).toHaveLength(0);
  });
});

describe("undo", () => {
  it("takes back the last click", () => {
    const first = click();
    const second = click(first.session, place("axial", 0, 0.4));
    expect(activeObject(undo(second.session))!.cuts[0]!.points).toHaveLength(1);
  });

  it("takes back a new object", () => {
    const session = addObject(addObject(emptySession()));
    expect(undo(session).objects).toHaveLength(1);
    expect(undo(session).activeId).toBe(session.objects[0]!.id);
  });

  it("brings back an object that was deleted, with its masks", () => {
    const session = clickWithMask();
    const removed = removeObject(session, session.objects[0]!.id);
    expect(removed.objects).toHaveLength(0);
    expect(undo(removed).objects[0]!.cuts[0]!.part).toBeDefined();
  });

  it("does nothing on a session with no history", () => {
    const session = emptySession();
    expect(undo(session)).toBe(session);
    expect(canUndo(session)).toBe(false);
  });

  it("keeps a bounded history, so a long session cannot grow without end", () => {
    let session = emptySession();
    for (let i = 0; i < UNDO_DEPTH * 3; i += 1) session = addObject(session);
    expect(session.past.length).toBe(UNDO_DEPTH);
  });
});

describe("renameObject", () => {
  it("renames the object it names", () => {
    const session = addObject(emptySession());
    expect(renameObject(session, session.objects[0]!.id, "Bone chip").objects[0]!.label).toBe(
      "Bone chip",
    );
  });

  it("refuses an empty name, so no object loses its handle", () => {
    const session = addObject(emptySession());
    expect(renameObject(session, session.objects[0]!.id, "   ").objects[0]!.label).toBe("Object 1");
  });
});

describe("setObjectHidden", () => {
  it("hides and shows one object", () => {
    const session = addObject(emptySession());
    const id = session.objects[0]!.id;
    const gone = setObjectHidden(session, id, true);
    expect(gone.objects[0]!.hidden).toBe(true);
    expect(setObjectHidden(gone, id, false).objects[0]!.hidden).toBe(false);
  });
});

describe("selectObject", () => {
  it("moves the clicks to the object the user picked", () => {
    let session = addObject(emptySession(), "first");
    const firstId = session.objects[0]!.id;
    session = addObject(session, "second");
    session = click(selectObject(session, firstId)).session;
    expect(session.objects[0]!.cuts).toHaveLength(1);
    expect(session.objects[1]!.cuts).toHaveLength(0);
  });

  it("ignores an object that is not there", () => {
    const session = addObject(emptySession());
    expect(selectObject(session, "ghost").activeId).toBe(session.activeId);
  });
});

describe("removeObject", () => {
  it("picks another object to be active", () => {
    let session = addObject(emptySession(), "first");
    session = addObject(session, "second");
    const next = removeObject(session, session.activeId!);
    expect(next.activeId).toBe(next.objects[0]!.id);
  });

  it("leaves no active object when the last one goes", () => {
    const session = addObject(emptySession());
    expect(removeObject(session, session.activeId!).activeId).toBeUndefined();
  });
});

describe("visibleParts", () => {
  it("returns nothing for a cut that runs nowhere near the mask", () => {
    expect(visibleParts(clickWithMask(), "axial", depthAt("axial", 200), THICK)).toHaveLength(0);
  });

  it("returns a mask when the cut runs through it", () => {
    const session = clickWithMask();
    const found = visibleParts(session, "axial", depthAt("axial"), THICK);
    expect(found).toHaveLength(1);
    expect(found[0]!.colour).toBe(session.objects[0]!.colour);
  });

  it("leaves out a hidden object", () => {
    const session = clickWithMask();
    const gone = setObjectHidden(session, session.objects[0]!.id, true);
    expect(visibleParts(gone, "axial", depthAt("axial"), THICK)).toHaveLength(0);
  });

  it("leaves out a mask from another pane", () => {
    expect(visibleParts(clickWithMask(), "coronal", depthAt("coronal"), THICK)).toHaveLength(0);
  });

  it("draws the newer object last, so it wins where two overlap", () => {
    let session = clickWithMask();
    session = addObject(session);
    session = clickWithMask(session, "axial", 0, 0.52);
    expect(
      visibleParts(session, "axial", depthAt("axial"), THICK).map((entry) => entry.objectId),
    ).toEqual([session.objects[0]!.id, session.objects[1]!.id]);
  });

  it("keeps one mask per pane when an object spans two panes", () => {
    let session = clickWithMask();
    session = clickWithMask(session, "coronal");
    expect(visibleParts(session, "axial", depthAt("axial"), THICK)).toHaveLength(1);
    expect(visibleParts(session, "coronal", depthAt("coronal"), THICK)).toHaveLength(1);
  });
});

describe("promptMarks", () => {
  it("shows a click made on this very cut at full strength", () => {
    const marks = promptMarks(click().session, "axial", depthAt("axial"), THICK);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.opacity).toBe(1);
    expect(marks[0]!.active).toBe(true);
  });

  it("fades a click made on another slice, and keeps it on screen", () => {
    const first = click();
    const second = click(first.session, place("axial", 6));
    const faded = promptMarks(second.session, "axial", depthAt("axial"), THICK).find(
      (mark) => mark.opacity < 1,
    );
    expect(faded).toBeDefined();
    expect(faded!.opacity).toBeGreaterThan(0);
  });

  it("leaves out a click from another pane", () => {
    const { session } = click(emptySession(), place("coronal"));
    expect(promptMarks(session, "axial", depthAt("axial"), THICK)).toHaveLength(0);
  });

  it("leaves out a hidden object", () => {
    const { session } = click();
    const gone = setObjectHidden(session, session.objects[0]!.id, true);
    expect(promptMarks(gone, "axial", depthAt("axial"), THICK)).toHaveLength(0);
  });

  it("says which object each click belongs to", () => {
    let session = click().session;
    session = addObject(session);
    session = click(session, place("axial", 0, 0.3)).session;
    const marks = promptMarks(session, "axial", depthAt("axial"), THICK);
    expect(new Set(marks.map((mark) => mark.colour)).size).toBe(2);
    expect(marks.filter((mark) => mark.active)).toHaveLength(1);
  });
});

describe("objectVolumeCubicMillimeters", () => {
  it("is zero for an object with no mask", () => {
    expect(objectVolumeCubicMillimeters(volume, click().session.objects[0]!)).toBe(0);
  });

  it("grows when the object gains a second slice", () => {
    const oneCut = clickWithMask();
    const alone = objectVolumeCubicMillimeters(volume, oneCut.objects[0]!);
    expect(alone).toBeGreaterThan(0);
    const twoCuts = clickWithMask(oneCut, "axial", 4);
    expect(objectVolumeCubicMillimeters(volume, twoCuts.objects[0]!)).toBeGreaterThan(alone);
  });

  it("counts a voxel once where two panes cross", () => {
    const axialOnly = objectVolumeCubicMillimeters(volume, clickWithMask().objects[0]!);
    const coronalOnly = objectVolumeCubicMillimeters(
      volume,
      clickWithMask(emptySession(), "coronal").objects[0]!,
    );
    const both = objectVolumeCubicMillimeters(
      volume,
      clickWithMask(clickWithMask(), "coronal").objects[0]!,
    );
    expect(both).toBeGreaterThan(Math.max(axialOnly, coronalOnly));
    expect(both).toBeLessThan(axialOnly + coronalOnly);
  });
});

describe("addGrown", () => {
  it("marks a slice the model inferred apart from a slice the user clicked", () => {
    const session = clickWithMask();
    const grown = addGrown(session, session.objects[0]!.id, place("axial", 1), square("axial", 1));
    expect(grown.objects[0]!.cuts.map((cut) => cut.origin)).toEqual(["user", "grown"]);
  });

  it("leaves no prompts on a grown slice, because the user placed none", () => {
    const session = clickWithMask();
    const grown = addGrown(session, session.objects[0]!.id, place("axial", 1), square("axial", 1));
    expect(grown.objects[0]!.cuts[1]!.points).toHaveLength(0);
  });

  it("asks the model for nothing, so a grown slice never waits", () => {
    const session = clickWithMask();
    const grown = addGrown(session, session.objects[0]!.id, place("axial", 1), square("axial", 1));
    expect(grown.pending).toBeUndefined();
  });

  it("counts toward the size of the object", () => {
    const session = clickWithMask();
    const alone = objectVolumeCubicMillimeters(volume, session.objects[0]!);
    const grown = addGrown(session, session.objects[0]!.id, place("axial", 4), square("axial", 4));
    expect(objectVolumeCubicMillimeters(volume, grown.objects[0]!)).toBeGreaterThan(alone);
  });

  it("replaces a grown slice that a later walk reaches again", () => {
    const session = clickWithMask();
    const once = addGrown(session, session.objects[0]!.id, place("axial", 1), square("axial", 1));
    const twice = addGrown(once, session.objects[0]!.id, place("axial", 1), square("axial", 1, 3));
    expect(twice.objects[0]!.cuts).toHaveLength(2);
  });
});

describe("a click on a grown slice", () => {
  it("turns the slice into one the user owns", () => {
    const session = clickWithMask();
    const grown = addGrown(session, session.objects[0]!.id, place("axial", 1), square("axial", 1));
    const corrected = click(grown, place("axial", 1, 0.45)).session;
    expect(corrected.objects[0]!.cuts[1]!.origin).toBe("user");
    expect(corrected.objects[0]!.cuts[1]!.points).toHaveLength(1);
  });

  it("asks the model to read that slice again", () => {
    const session = clickWithMask();
    const grown = addGrown(session, session.objects[0]!.id, place("axial", 1), square("axial", 1));
    expect(click(grown, place("axial", 1, 0.45)).session.pending).toBeDefined();
  });
});

describe("clearGrown", () => {
  it("takes away every grown slice and keeps every clicked one", () => {
    let session = clickWithMask();
    const id = session.objects[0]!.id;
    session = addGrown(session, id, place("axial", 1), square("axial", 1));
    session = addGrown(session, id, place("axial", 2), square("axial", 2));
    const cleared = clearGrown(session, id);
    expect(cleared.objects[0]!.cuts).toHaveLength(1);
    expect(cleared.objects[0]!.cuts[0]!.origin).toBe("user");
  });

  it("forgets the record of the walk that made them", () => {
    let session = clickWithMask();
    const id = session.objects[0]!.id;
    session = setGrowth(session, id, {
      plane: "axial",
      seedDepth: 0,
      kept: 2,
      reachMillimetres: 6,
      up: "vanished",
      down: "edge",
    });
    expect(clearGrown(session, id).objects[0]!.growth).toBeUndefined();
  });
});

describe("setGrowth", () => {
  it("keeps why the walk stopped on each side", () => {
    const session = clickWithMask();
    const told = setGrowth(session, session.objects[0]!.id, {
      plane: "axial",
      seedDepth: 3,
      kept: 5,
      reachMillimetres: 16.5,
      up: "leaked",
      down: "edge",
    });
    expect(told.objects[0]!.growth!.up).toBe("leaked");
    expect(told.objects[0]!.growth!.down).toBe("edge");
  });
});

describe("visibleParts with grown slices", () => {
  it("says which slices the user clicked and which the model inferred", () => {
    const session = clickWithMask();
    const grown = addGrown(
      session,
      session.objects[0]!.id,
      place("axial", 0.05),
      square("axial", 0),
    );
    const found = visibleParts(grown, "axial", depthAt("axial"), THICK * 40);
    expect(found.map((entry) => entry.origin).sort()).toEqual(["grown", "user"]);
  });
});
