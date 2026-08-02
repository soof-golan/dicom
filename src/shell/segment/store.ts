/**
 * Segmentation state.
 *
 * This is a store of its own, next to the study store, not inside it. Masks
 * and model state have their own lifetime, so the viewer never re-renders
 * because a download moved a byte.
 *
 * This module belongs to the lazy chunk. Importing it starts nothing: the
 * worker appears on the first prompt, and the weights only after the user
 * selects the load button.
 */
import { create } from "zustand";
import { decodeRle, encodeRle } from "../../core/segment/mask.ts";
import { formatBytes, planFor, textPlanFor } from "../../core/segment/plan.ts";
import type { ModelPlan, TextPlan } from "../../core/segment/plan.ts";
import { nextColour } from "../../core/segment/palette.ts";
import {
  frameNormal,
  maskVolumeCubicMillimeters,
  patientToFramePixel,
  sampleSliceGray,
  sliceFrame,
  voxelExtentAlong,
} from "../../core/segment/project.ts";
import type {
  BoxPrompt,
  Mask,
  MaskFrame,
  PointPrompt,
  Segment,
  SegmentSource,
} from "../../core/segment/types.ts";
import type { Vec3 } from "../../core/geometry/vec3.ts";
import { standardPlane, type PlaneId } from "../../core/view/planes.ts";
import { activeSeries, useStudy } from "../store.ts";
import { keepStorage, probeCapability } from "./capability.ts";
import type { LoadProgress, SegmentClient } from "./SegmentClient.ts";

/** The longest side of the picture that goes to the model. */
const MAX_SLICE_SIDE = 1024;

export type Status = "idle" | "probing" | "unsupported" | "offered" | "loading" | "ready";

export type PromptMode = "off" | "click" | "box";

/** A result that the user has not kept yet. */
export interface Draft {
  readonly plane: PlaneId;
  readonly frame: MaskFrame;
  readonly points: readonly PointPrompt[];
  readonly box: BoxPrompt | undefined;
  readonly mask: Mask | undefined;
  readonly score: number;
  readonly source: SegmentSource;
  readonly label: string;
}

interface Cut {
  readonly frame: MaskFrame;
  readonly gray: Uint8Array;
}

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
  readonly busy: boolean;
  readonly segments: readonly Segment[];
  readonly hidden: readonly string[];
  readonly draft: Draft | undefined;

  readonly probe: () => Promise<void>;
  readonly loadModel: () => Promise<void>;
  readonly cancelLoad: () => void;
  readonly setMode: (mode: PromptMode) => void;
  readonly addPoint: (plane: PlaneId, patient: Vec3, positive: boolean) => Promise<void>;
  readonly setBox: (plane: PlaneId, start: Vec3, end: Vec3) => Promise<void>;
  readonly promptText: (plane: PlaneId, text: string) => Promise<void>;
  readonly keepDraft: () => void;
  readonly clearDraft: () => void;
  readonly toggleVisible: (id: string) => void;
  readonly remove: (id: string) => void;
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
/** Which cut the encoder holds, so a second prompt on the same cut is fast. */
let encodedKey: string | undefined;
let counter = 0;

function keyOf(plane: PlaneId, frame: MaskFrame): string {
  const origin = frame.origin.map((value) => value.toFixed(3)).join(",");
  return `${plane}|${origin}|${frame.width}x${frame.height}`;
}

/** The cut under the current cursor, at the resolution the model reads. */
function cutFor(plane: PlaneId): Cut | undefined {
  const state = useStudy.getState();
  const series = activeSeries(state);
  if (!series) return undefined;
  const cut = standardPlane(series.volume, plane, state.view.cursor, state.view.pan[plane]);
  const frame = sliceFrame(series.volume, cut, MAX_SLICE_SIDE);
  const gray = sampleSliceGray(series.volume, frame, {
    center: state.view.windowCenter,
    width: state.view.windowWidth,
  });
  return { frame, gray };
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLabel(source: SegmentSource): string {
  if (source === "box") return "Box";
  if (source === "text") return "Text";
  return "Click";
}

export const useSegment = create<SegmentStore>((set, get) => {
  async function encodeIfNeeded(plane: PlaneId, cut: Cut): Promise<void> {
    const key = keyOf(plane, cut.frame);
    if (key === encodedKey) return;
    await client!.encode(cut.gray, cut.frame.width, cut.frame.height);
    encodedKey = key;
  }

  async function run(
    plane: PlaneId,
    cut: Cut,
    points: readonly PointPrompt[],
    box: BoxPrompt | undefined,
    source: SegmentSource,
    label: string,
  ): Promise<void> {
    set({ busy: true, error: undefined });
    try {
      await encodeIfNeeded(plane, cut);
      const mask = await client!.decode(points, box);
      if (!mask) {
        set({ busy: false });
        return;
      }
      set({
        busy: false,
        draft: {
          plane,
          frame: cut.frame,
          points,
          box,
          mask: { width: mask.width, height: mask.height, data: mask.data },
          score: mask.score,
          source,
          label,
        },
      });
    } catch (error) {
      set({ busy: false, error: messageOf(error) });
    }
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
    busy: false,
    segments: [],
    hidden: [],
    draft: undefined,

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
        const textReady = await handle.load(plan, textPlan);
        set({
          status: "ready",
          textReady,
          mode: "box",
          progress: { ...IDLE_PROGRESS, phase: "ready" },
          note:
            textPlan && !textReady
              ? "The text model did not load. Click and box prompts still work."
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

    setMode: (mode) => set({ mode, draft: undefined }),

    /**
     * Add a click.
     *
     * Clicks build up while the cut stays put. Moving the cursor to another
     * slice changes the cut, and then the list starts again.
     */
    addPoint: async (plane, patient, positive) => {
      const state = get();
      if (state.status !== "ready") return;
      const cut = cutFor(plane);
      if (!cut) return;

      const sameCut = state.draft?.plane === plane && keyOf(plane, cut.frame) === encodedKey;
      const at = patientToFramePixel(cut.frame, patient);
      const points: PointPrompt[] = [
        ...(sameCut ? (state.draft?.points ?? []) : []),
        { kind: "point", x: at.x, y: at.y, positive },
      ];
      const box = sameCut ? state.draft?.box : undefined;
      await run(plane, cut, points, box, "click", defaultLabel("click"));
    },

    setBox: async (plane, start, end) => {
      if (get().status !== "ready") return;
      const cut = cutFor(plane);
      if (!cut) return;
      const a = patientToFramePixel(cut.frame, start);
      const b = patientToFramePixel(cut.frame, end);
      const box: BoxPrompt = {
        kind: "box",
        x0: Math.min(a.x, b.x),
        y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x),
        y1: Math.max(a.y, b.y),
      };
      if (box.x1 - box.x0 < 2 || box.y1 - box.y0 < 2) return;
      await run(plane, cut, [], box, "box", defaultLabel("box"));
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
      const cut = cutFor(plane);
      if (!cut) return;

      set({ busy: true, note: undefined, error: undefined });
      try {
        await encodeIfNeeded(plane, cut);
        const boxes = await client!.detect(phrase);
        const best = boxes[0];
        if (!best) {
          set({ busy: false, note: `No match for "${phrase}" on this cut.` });
          return;
        }
        const box: BoxPrompt = { kind: "box", x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 };
        set({ note: `Best match ${Math.round(best.score * 100)}%. Check it against the anatomy.` });
        await run(plane, cut, [], box, "text", phrase);
      } catch (error) {
        set({ busy: false, error: messageOf(error) });
      }
    },

    keepDraft: () => {
      const { draft, segments } = get();
      if (!draft?.mask) return;
      counter += 1;
      const segment: Segment = {
        id: `segment-${counter}`,
        label: draft.label,
        source: draft.source,
        mask: encodeRle(draft.mask),
        colour: nextColour(segments.map((entry) => entry.colour)),
        score: draft.score,
        plane: draft.plane,
        frame: draft.frame,
      };
      set({ segments: [...segments, segment], draft: undefined });
    },

    clearDraft: () => set({ draft: undefined }),

    toggleVisible: (id) => {
      const { hidden } = get();
      set({
        hidden: hidden.includes(id) ? hidden.filter((entry) => entry !== id) : [...hidden, id],
      });
    },

    remove: (id) =>
      set({
        segments: get().segments.filter((segment) => segment.id !== id),
        hidden: get().hidden.filter((entry) => entry !== id),
      }),
  };
});

/** The size of a segment in cubic millimeters, using the depth of one voxel. */
export function segmentVolume(segment: Segment): number {
  const series = activeSeries(useStudy.getState());
  if (!series) return 0;
  const thickness = voxelExtentAlong(series.volume, frameNormal(segment.frame));
  return maskVolumeCubicMillimeters(segment.frame, decodeRle(segment.mask), thickness);
}

export function downloadSize(plan: ModelPlan, text: TextPlan | undefined): string {
  return formatBytes(plan.bytes + (text?.bytes ?? 0));
}
