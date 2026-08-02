/**
 * Segmentation state.
 *
 * This is a store of its own, next to the study store, not inside it. Masks
 * and model state have their own lifetime, so the viewer never re-renders
 * because a download moved a byte.
 *
 * The state machine lives in `src/core/segment/session.ts` and has tests
 * without a browser. This file adds only what needs a browser: the worker, the
 * download, and reading pixels out of the volume.
 *
 * This module belongs to the lazy chunk. Importing it starts nothing: the
 * worker appears on the first prompt, and the weights only after the user
 * selects the load button.
 */
import { create } from "zustand";
import { formatBytes, planFor, textPlanFor } from "../../core/segment/plan.ts";
import type { ModelPlan, TextPlan } from "../../core/segment/plan.ts";
import { encodeRle } from "../../core/segment/mask.ts";
import {
  framePixelToPatient,
  patientToFramePixel,
  sampleSliceGray,
  sliceFrame,
} from "../../core/segment/project.ts";
import {
  addObject,
  addPoint,
  attachPart,
  clearCut,
  cutCursor,
  emptySession,
  findCut,
  findObject,
  objectVolumeCubicMillimeters,
  removeObject,
  renameObject,
  selectObject,
  setBox,
  setObjectHidden,
  undo,
  type PromptCut,
  type PromptPlace,
  type SegmentObject,
  type Session,
} from "../../core/segment/session.ts";
import { cutAtDepth, depthOf, outsideVolume, sliceThickness } from "../../core/segment/slice.ts";
import type { BoxPrompt, MaskFrame, PointPrompt, Window } from "../../core/segment/types.ts";
import type { Vec3 } from "../../core/geometry/vec3.ts";
import { patientBounds, type PlaneId } from "../../core/view/planes.ts";
import type { Volume } from "../../core/volume/build.ts";
import { activeSeries, useStudy } from "../store.ts";
import { keepStorage, probeCapability } from "./capability.ts";
import type { LoadProgress, SegmentClient } from "./SegmentClient.ts";

/** The longest side of the picture that goes to the model. */
const MAX_SLICE_SIDE = 1024;

export type Status = "idle" | "probing" | "unsupported" | "offered" | "loading" | "ready";

export type PromptMode = "off" | "click" | "box";

interface SegmentStore {
  readonly status: Status;
  readonly plan: ModelPlan | undefined;
  readonly textPlan: TextPlan | undefined;
  readonly textReady: boolean;
  readonly persisted: boolean;
  readonly progress: LoadProgress;
  readonly error: string | undefined;
  readonly note: string | undefined;
  readonly mode: PromptMode;
  /** What a plain click means. Holding alt gives the other one. */
  readonly polarity: "positive" | "negative";
  readonly busy: boolean;
  readonly session: Session;

  readonly probe: () => Promise<void>;
  readonly loadModel: () => Promise<void>;
  readonly cancelLoad: () => void;
  readonly setMode: (mode: PromptMode) => void;
  readonly setPolarity: (polarity: "positive" | "negative") => void;
  readonly addPoint: (plane: PlaneId, patient: Vec3, positive: boolean) => void;
  readonly setBox: (plane: PlaneId, start: Vec3, end: Vec3) => void;
  readonly promptText: (plane: PlaneId, text: string) => Promise<void>;
  readonly newObject: () => void;
  readonly selectObject: (id: string) => void;
  readonly renameObject: (id: string, label: string) => void;
  readonly toggleVisible: (id: string) => void;
  readonly removeObject: (id: string) => void;
  readonly undo: () => void;
  readonly clearCut: (objectId: string, cutKey: string) => void;
  readonly goToCut: (objectId: string, cutKey: string) => void;
}

const IDLE_PROGRESS: LoadProgress = {
  phase: "idle",
  loaded: 0,
  total: 0,
  fraction: undefined,
  file: undefined,
};

/** The worker handle. It is not state, so it does not live in the store. */
let client: SegmentClient | undefined;
/** Which picture the encoder holds, so a second prompt on it is fast. */
let encodedKey: string | undefined;
/** One run at a time. A click during a run waits for it, and does not race. */
let chain: Promise<void> = Promise.resolve();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The series a prompt was placed on, which is not always the active one. */
function volumeOf(seriesUid: string): Volume | undefined {
  return useStudy.getState().series.find((entry) => entry.summary.seriesInstanceUid === seriesUid)
    ?.volume;
}

function currentWindow(): Window {
  const { view } = useStudy.getState();
  return { center: view.windowCenter, width: view.windowWidth };
}

/**
 * The picture the model reads for one cut, and the name of that picture.
 *
 * The name carries the window, because the model reads the grey levels a
 * radiologist sees. A different window is a different picture.
 */
function pictureFor(
  volume: Volume,
  cut: PromptCut,
  window: Window,
): { frame: MaskFrame; gray: Uint8Array; key: string } {
  const plane = cutAtDepth(volume, cut.plane, cut.depth);
  const frame = sliceFrame(volume, plane, MAX_SLICE_SIDE);
  return {
    frame,
    gray: sampleSliceGray(volume, frame, window),
    key: `${cut.key}|${window.center.toFixed(2)}/${window.width.toFixed(2)}`,
  };
}

async function ensureClient(onProgress: (progress: LoadProgress) => void): Promise<SegmentClient> {
  if (client) return client;
  const { SegmentClient: Client } = await import("./SegmentClient.ts");
  client = new Client(onProgress);
  return client;
}

function stop(): void {
  client?.dispose();
  client = undefined;
  encodedKey = undefined;
}

export const useSegment = create<SegmentStore>((set, get) => {
  /**
   * Ask the model for the mask of the cut that is waiting.
   *
   * Only the prompts of that one cut go in. A click made on another slice is
   * never handed to a 2D encoding of this one: the model would read it as a
   * point on this picture, which it is not.
   */
  async function runPending(): Promise<void> {
    const target = get().session.pending;
    if (!target || get().status !== "ready") return;
    const object = findObject(get().session, target.objectId);
    const cut = object ? findCut(object, target.cutKey) : undefined;
    if (!object || !cut) return;

    if (cut.points.length === 0 && !cut.box) {
      set({ session: clearCut(get().session, object.id, cut.key) });
      return;
    }

    const volume = volumeOf(cut.seriesUid);
    if (!volume) {
      set({ error: "The series that holds this prompt is gone. Nothing ran." });
      return;
    }

    set({ busy: true, error: undefined });
    try {
      const picture = pictureFor(volume, cut, currentWindow());
      if (picture.key !== encodedKey) {
        await client!.encode(picture.gray, picture.frame.width, picture.frame.height);
        encodedKey = picture.key;
      }

      const points: PointPrompt[] = cut.points.map((point) => {
        const at = patientToFramePixel(picture.frame, point.patient);
        return { kind: "point", x: at.x, y: at.y, positive: point.positive };
      });
      const box = boxIn(picture.frame, cut);
      const mask = await client!.decode(points, box);
      set({ busy: false });
      if (!mask) return;

      // A click that landed during the run made a new cut object. The mask
      // answers the older question, so drop it and let the next run win.
      const fresh = findObject(get().session, object.id);
      if (!fresh || findCut(fresh, cut.key) !== cut) return;

      set({
        session: attachPart(get().session, object.id, cut.key, {
          frame: picture.frame,
          mask: encodeRle(mask),
          score: mask.score,
        }),
      });
    } catch (error) {
      set({ busy: false, error: messageOf(error) });
    }
  }

  /** Queue a run. Runs never overlap, so two cuts cannot cross in the worker. */
  function schedule(): void {
    chain = chain.then(runPending).then(() => {
      if (get().session.pending) schedule();
    });
  }

  /** Where a click sits, or nothing with a reason the user can read. */
  function placeOf(plane: PlaneId, patient: Vec3): PromptPlace | undefined {
    if (get().status !== "ready") {
      set({ error: "Load the model before you place a prompt." });
      return undefined;
    }
    const series = activeSeries(useStudy.getState());
    if (!series) return undefined;
    if (outsideVolume(patientBounds(series.volume), patient)) {
      set({ error: "That point is outside the volume. Nothing was added." });
      return undefined;
    }
    return {
      plane,
      seriesUid: series.summary.seriesInstanceUid,
      depth: depthOf(series.volume, plane, patient),
      patient,
    };
  }

  function thicknessOn(plane: PlaneId): number {
    const series = activeSeries(useStudy.getState());
    return series ? sliceThickness(series.volume, plane) : 1;
  }

  return {
    status: "idle",
    plan: undefined,
    textPlan: undefined,
    textReady: false,
    persisted: false,
    progress: IDLE_PROGRESS,
    error: undefined,
    note: undefined,
    mode: "off",
    polarity: "positive",
    busy: false,
    session: emptySession(),

    /** Ask the machine what it can run. Nothing downloads yet. */
    probe: async () => {
      if (get().status !== "idle") return;
      set({ status: "probing" });
      const capability = await probeCapability();
      const plan = planFor(capability);
      if (!plan) {
        set({
          status: "unsupported",
          error: "This browser has no WebGPU. The fallback model needs a desktop.",
        });
        return;
      }
      set({ status: "offered", plan, textPlan: textPlanFor(plan) });
    },

    loadModel: async () => {
      const { plan, textPlan, status } = get();
      if (!plan || status === "loading" || status === "ready") return;
      set({ status: "loading", error: undefined, progress: IDLE_PROGRESS });

      // `persist()` must follow a user gesture, and this button is one.
      const storage = await keepStorage();
      set({ persisted: storage.persisted });

      try {
        const handle = await ensureClient((progress) => set({ progress }));
        const { textReady, textError } = await handle.load(plan, textPlan);
        set({
          status: "ready",
          textReady,
          mode: "click",
          progress: { ...IDLE_PROGRESS, phase: "ready" },
          note:
            textPlan && !textReady
              ? `The text model did not load. Click and box prompts still work. ${textError ?? ""}`.trim()
              : undefined,
        });
      } catch (error) {
        stop();
        set({ status: "offered", error: messageOf(error), progress: IDLE_PROGRESS });
      }
    },

    cancelLoad: () => {
      stop();
      set({ status: "offered", progress: IDLE_PROGRESS, error: undefined, note: undefined });
    },

    setMode: (mode) => set({ mode }),

    setPolarity: (polarity) => set({ polarity }),

    /**
     * Add a click to the active object.
     *
     * The click joins the cut it was made on. Every other cut of the object
     * keeps the mask it already has, so moving to another slice adds to the
     * object instead of starting it again.
     */
    addPoint: (plane, patient, positive) => {
      const place = placeOf(plane, patient);
      if (!place) return;
      set({ session: addPoint(get().session, place, positive, thicknessOn(plane)) });
      schedule();
    },

    setBox: (plane, start, end) => {
      const place = placeOf(plane, start);
      if (!place) return;
      set({ session: setBox(get().session, place, start, end, thicknessOn(plane)) });
      schedule();
    },

    /**
     * Find a phrase, then segment what it found.
     *
     * The detector gives boxes. The best box goes into the mask decoder as a
     * box prompt. This is the standard chain, and it is why the text feature
     * needs no text head inside SAM.
     */
    promptText: async (plane, text) => {
      const phrase = text.trim();
      if (get().status !== "ready" || !get().textReady || phrase.length === 0) return;
      const series = activeSeries(useStudy.getState());
      if (!series) return;

      const depth = depthOf(series.volume, plane, useStudy.getState().view.cursor);
      const cut: PromptCut = {
        key: "text-probe",
        plane,
        seriesUid: series.summary.seriesInstanceUid,
        depth,
        points: [],
        box: undefined,
        part: undefined,
      };

      set({ busy: true, note: undefined, error: undefined });
      try {
        const picture = pictureFor(series.volume, cut, currentWindow());
        if (picture.key !== encodedKey) {
          await client!.encode(picture.gray, picture.frame.width, picture.frame.height);
          encodedKey = picture.key;
        }
        const best = (await client!.detect(phrase))[0];
        if (!best) {
          set({ busy: false, note: `No match for "${phrase}" on this cut.` });
          return;
        }
        set({
          busy: false,
          note: `Best match ${Math.round(best.score * 100)}%. Check it against the anatomy.`,
        });
        const at = (x: number, y: number): Vec3 => framePixelToPatient(picture.frame, x, y);
        get().setBox(plane, at(best.x0, best.y0), at(best.x1, best.y1));
      } catch (error) {
        set({ busy: false, error: messageOf(error) });
      }
    },

    newObject: () => set({ session: addObject(get().session), mode: "click" }),

    selectObject: (id) => set({ session: selectObject(get().session, id) }),

    renameObject: (id, label) => set({ session: renameObject(get().session, id, label) }),

    toggleVisible: (id) => {
      const object = findObject(get().session, id);
      if (!object) return;
      set({ session: setObjectHidden(get().session, id, !object.hidden) });
    },

    removeObject: (id) => set({ session: removeObject(get().session, id) }),

    undo: () => {
      set({ session: undo(get().session) });
      schedule();
    },

    clearCut: (objectId, cutKey) => set({ session: clearCut(get().session, objectId, cutKey) }),

    /** Move the cursor to the slice a prompt was placed on, so it shows again. */
    goToCut: (objectId, cutKey) => {
      const object = findObject(get().session, objectId);
      const cut = object ? findCut(object, cutKey) : undefined;
      const volume = cut ? volumeOf(cut.seriesUid) : undefined;
      if (!cut || !volume) return;
      const study = useStudy.getState();
      study.setCursor(cutCursor(volume, cut, study.view.cursor));
    },
  };
});

/** The box of a cut, in the pixels of the picture the model read. */
function boxIn(frame: MaskFrame, cut: PromptCut): BoxPrompt | undefined {
  if (!cut.box) return undefined;
  const a = patientToFramePixel(frame, cut.box.start);
  const b = patientToFramePixel(frame, cut.box.end);
  return {
    kind: "box",
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

/** The size of an object in cubic millimetres, over the active series. */
export function objectVolume(object: SegmentObject): number {
  const series = activeSeries(useStudy.getState());
  return series ? objectVolumeCubicMillimeters(series.volume, object) : 0;
}

export function downloadSize(plan: ModelPlan, text: TextPlan | undefined): string {
  return formatBytes(plan.bytes + (text?.bytes ?? 0));
}

if (import.meta.env.DEV) {
  (globalThis as unknown as { __segment?: typeof useSegment }).__segment = useSegment;
}
