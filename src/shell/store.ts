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
import { findSequencePair, type SequencePair } from "../core/tissue/sequence.ts";
import { findFusionCandidate, fuseInWorker } from "./loader/fuseStudy.ts";
import type { LoadedSeries } from "./loader/loadStudy.ts";
import type { ViewerState } from "./viewer/VolumeScene.ts";

/**
 * The partner for the active series, from everything loaded so far.
 *
 * Series arrive one at a time, so this runs again on each arrival. A T1 that
 * loads after the fat-saturated series must still find its partner.
 */
function pairFor(
  series: readonly LoadedSeries[],
  activeUid: string | undefined,
): SequencePair | undefined {
  const active = series.find((entry) => entry.summary.seriesInstanceUid === activeUid);
  if (!active) return undefined;
  return findSequencePair(
    active.volume,
    series.map((entry) => entry.volume),
  );
}

export type LoadStatus = "empty" | "loading" | "ready" | "error";

/**
 * Fixed ends for the display sliders.
 *
 * The ends come from the data, once, when a series becomes active. They must
 * not follow the value: a slider whose range moves as you drag it can never
 * reach its own end, and it feels broken.
 */
export interface ViewLimits {
  readonly windowCenter: readonly [number, number];
  readonly windowWidth: readonly [number, number];
}

const DEFAULT_LIMITS: ViewLimits = {
  windowCenter: [0, 1],
  windowWidth: [1, 2],
};

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
  /**
   * The T1 and fat-saturated partner that name tissue for the active series.
   *
   * It is stored, not derived at draw time, because the answer changes only
   * when the series list or the active series changes, and the legend has to
   * show which partner was chosen.
   */
  readonly pair?: SequencePair;
  readonly skipped: readonly { name: string; reason: string }[];
  readonly view: ViewerState;
  /** The view that a double click on a slider returns to. */
  readonly defaults: ViewerState;
  readonly limits: ViewLimits;

  /** True while the fusion worker runs. */
  readonly fusing: boolean;

  readonly beginLoad: () => void;
  readonly fuseSeries: () => Promise<void>;
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
  readonly resetView: () => void;
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
  defaults: INITIAL_VIEW,
  limits: DEFAULT_LIMITS,
  fusing: false,

  /**
   * Build one volume with cubic voxels and add it to the list.
   *
   * It joins the series rather than replacing any of them. It is finer through
   * the slices and coarser inside them, so it answers a different question, and
   * a reader must be able to go back.
   */
  fuseSeries: async () => {
    const { series, fusing } = get();
    if (fusing) return;
    const candidate = findFusionCandidate(series.map((entry) => entry.volume));
    if (!candidate) return;

    set({ fusing: true, error: undefined });
    try {
      const volume = await fuseInWorker(candidate.volumes).result;
      get().addSeries({
        volume,
        summary: {
          seriesInstanceUid: volume.seriesInstanceUid,
          description: volume.description,
          modality: volume.modality,
          number: 999,
          sliceCount: volume.dims[2],
          plane: "isotropic",
          dims: volume.dims,
          spacing: volume.spacing,
        },
      });
      set({ fusing: false });
      get().selectSeries(volume.seriesInstanceUid);
    } catch (error) {
      set({
        fusing: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  beginLoad: () =>
    set({
      status: "loading",
      error: undefined,
      series: [],
      skipped: [],
      activeUid: undefined,
      pair: undefined,
      progress: { done: 0, total: 0, stage: "Reading files" },
    }),

  setProgress: (progress) => set({ progress }),

  addSeries: (series) => {
    const { series: existing, activeUid } = get();
    const next = [...existing, series];
    // The first series to arrive becomes the active one, and it decides the
    // cursor and the window. Later ones only join the list, but any of them can
    // be the partner that names tissue, so the pair is looked for again.
    if (activeUid !== undefined) {
      set({ series: next, pair: pairFor(next, activeUid) });
      return;
    }
    const uid = series.summary.seriesInstanceUid;
    set({ series: next, activeUid: uid, pair: pairFor(next, uid), ...viewFor(series) });
  },

  addSkipped: (name, reason) => set({ skipped: [...get().skipped, { name, reason }] }),

  finishLoad: () => set({ status: get().series.length > 0 ? "ready" : "error" }),

  failLoad: (reason) => set({ status: "error", error: reason }),

  selectSeries: (uid) => {
    const all = get().series;
    const series = all.find((entry) => entry.summary.seriesInstanceUid === uid);
    if (!series) return;
    set({ activeUid: uid, pair: pairFor(all, uid), ...viewFor(series) });
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

  resetView: () => set({ view: get().defaults }),

  reset: () =>
    set({
      status: "empty",
      series: [],
      skipped: [],
      activeUid: undefined,
      pair: undefined,
      fusing: false,
      error: undefined,
      view: INITIAL_VIEW,
      defaults: INITIAL_VIEW,
      limits: DEFAULT_LIMITS,
    }),
}));

/**
 * Center the cursor, pick a window, and fix the slider ends.
 *
 * This runs whenever a series becomes active. The result is both the view and
 * the state that a double click returns to.
 */
function viewFor(series: LoadedSeries): {
  view: ViewerState;
  defaults: ViewerState;
  limits: ViewLimits;
} {
  const { volume } = series;
  const bounds = patientBounds(volume);
  const { center, width } = defaultWindow(volume);

  const toValue = (stored: number): number =>
    stored * volume.rescaleSlope + volume.rescaleIntercept;
  const low = toValue(volume.valueRange.min);
  const high = toValue(volume.valueRange.max);
  const span = Math.max(high - low, 1);

  const view: ViewerState = {
    ...INITIAL_VIEW,
    cursor: bounds.center,
    windowCenter: center,
    windowWidth: width,
  };

  return {
    view,
    defaults: view,
    limits: {
      // A little room past each end, so the ends stay reachable.
      windowCenter: [low - span * 0.1, high + span * 0.1],
      windowWidth: [1, span * 1.5],
    },
  };
}

export function activeSeries(state: StudyStore): LoadedSeries | undefined {
  return state.series.find((entry) => entry.summary.seriesInstanceUid === state.activeUid);
}

if (import.meta.env.DEV) {
  (globalThis as unknown as { __study?: typeof useStudy }).__study = useStudy;
}
