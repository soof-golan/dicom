/**
 * Application state.
 *
 * Volumes are large, so they live here and never go into a URL or into
 * `localStorage`. Only the small view settings are shareable.
 */
import { create } from "zustand";
import type { Vec3 } from "../core/geometry/vec3.ts";
import type { PlaneId } from "../core/view/planes.ts";
import { defaultWindow, patientBounds } from "../core/view/planes.ts";
import type { LoadedSeries } from "./loader/loadStudy.ts";
import type { ViewerState } from "./viewer/VolumeScene.ts";

export type LoadStatus = "empty" | "loading" | "ready" | "error";

export interface Progress {
  readonly done: number;
  readonly total: number;
  readonly stage: string;
}

const INITIAL_VIEW: ViewerState = {
  cursor: [0, 0, 0],
  windowCenter: 0,
  windowWidth: 1,
  tissueMix: 0,
  slabThickness: 0,
  paneZoom: 1,
  pan: { axial: [0, 0], coronal: [0, 0], sagittal: [0, 0] },
  orbit: { azimuth: 0.6, elevation: 0.35, zoom: 1.6 },
  clip: { axial: false, coronal: false, sagittal: false },
  clipFlip: { axial: false, coronal: false, sagittal: false },
  opacity: 3,
  lightStrength: 0.6,
  threshold: 0.28,
  edgeBoost: 0.7,
  showCrosshair: true,
  invert: false,
};

interface StudyStore {
  readonly status: LoadStatus;
  readonly progress: Progress;
  readonly error?: string;
  readonly series: readonly LoadedSeries[];
  readonly activeUid?: string;
  readonly skipped: readonly { name: string; reason: string }[];
  readonly view: ViewerState;

  readonly beginLoad: () => void;
  readonly setProgress: (progress: Progress) => void;
  readonly addSeries: (series: LoadedSeries) => void;
  readonly addSkipped: (name: string, reason: string) => void;
  readonly finishLoad: () => void;
  readonly failLoad: (reason: string) => void;
  readonly selectSeries: (uid: string) => void;
  readonly patchView: (patch: Partial<ViewerState>) => void;
  readonly setCursor: (cursor: Vec3) => void;
  readonly panBy: (id: PlaneId, dx: number, dy: number) => void;
  readonly resetPan: () => void;
  readonly toggleClip: (id: PlaneId) => void;
  readonly flipClip: (id: PlaneId) => void;
  readonly reset: () => void;
}

export const useStudy = create<StudyStore>((set, get) => ({
  status: "empty",
  progress: { done: 0, total: 0, stage: "" },
  series: [],
  skipped: [],
  view: INITIAL_VIEW,

  beginLoad: () =>
    set({
      status: "loading",
      error: undefined,
      series: [],
      skipped: [],
      activeUid: undefined,
      progress: { done: 0, total: 0, stage: "Reading files" },
    }),

  setProgress: (progress) => set({ progress }),

  addSeries: (series) => {
    const { series: existing, activeUid } = get();
    const next = [...existing, series];
    // The first series to arrive becomes the active one, and it decides the
    // cursor and the window. Later ones only join the list.
    if (activeUid !== undefined) {
      set({ series: next });
      return;
    }
    set({ series: next, activeUid: series.summary.seriesInstanceUid, ...viewFor(series) });
  },

  addSkipped: (name, reason) => set({ skipped: [...get().skipped, { name, reason }] }),

  finishLoad: () => set({ status: get().series.length > 0 ? "ready" : "error" }),

  failLoad: (reason) => set({ status: "error", error: reason }),

  selectSeries: (uid) => {
    const series = get().series.find((entry) => entry.summary.seriesInstanceUid === uid);
    if (!series) return;
    set({ activeUid: uid, ...viewFor(series) });
  },

  patchView: (patch) => set({ view: { ...get().view, ...patch } }),

  setCursor: (cursor) => set({ view: { ...get().view, cursor } }),

  panBy: (id, dx, dy) => {
    const { view } = get();
    const [x, y] = view.pan[id];
    set({ view: { ...view, pan: { ...view.pan, [id]: [x + dx, y + dy] } } });
  },

  resetPan: () => set({ view: { ...get().view, pan: INITIAL_VIEW.pan, paneZoom: 1 } }),

  toggleClip: (id) => {
    const { view } = get();
    set({ view: { ...view, clip: { ...view.clip, [id]: !view.clip[id] } } });
  },

  flipClip: (id) => {
    const { view } = get();
    set({ view: { ...view, clipFlip: { ...view.clipFlip, [id]: !view.clipFlip[id] } } });
  },

  reset: () =>
    set({
      status: "empty",
      series: [],
      skipped: [],
      activeUid: undefined,
      error: undefined,
      view: INITIAL_VIEW,
    }),
}));

/** Center the cursor and pick a window whenever a new series becomes active. */
function viewFor(series: LoadedSeries): { view: ViewerState } {
  const bounds = patientBounds(series.volume);
  const { center, width } = defaultWindow(series.volume);
  return {
    view: {
      ...INITIAL_VIEW,
      cursor: bounds.center,
      windowCenter: center,
      windowWidth: width,
    },
  };
}

export function activeSeries(state: StudyStore): LoadedSeries | undefined {
  return state.series.find((entry) => entry.summary.seriesInstanceUid === state.activeUid);
}

if (import.meta.env.DEV) {
  (globalThis as unknown as { __study?: typeof useStudy }).__study = useStudy;
}
