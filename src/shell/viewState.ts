/**
 * Display settings in the address bar.
 *
 * Putting these in the URL makes a view shareable. A link carries what you saw,
 * so a second reader opens the same window, the same colouring, and the same
 * 3D settings.
 *
 * Each value is absent until the reader changes it. An absent value means "use
 * the value this series opened with", which the store computes from the data.
 * Two things follow from that rule:
 *
 * - A URL stays short, and holds only what a reader chose on purpose.
 * - Clearing a value restores the default, so a reset is a delete.
 *
 * Brightness and contrast are the exception when the series changes. They are
 * measured from one series, so they mean nothing for another one, and the app
 * clears them on a switch.
 */
import { parseAsFloat, useQueryStates } from "nuqs";
import type { ViewerState } from "./viewer/VolumeScene.ts";

/** Short names, because they end up visible in the address bar. */
export const DISPLAY_PARSERS = {
  wc: parseAsFloat,
  ww: parseAsFloat,
  tissue: parseAsFloat,
  slab: parseAsFloat,
  density: parseAsFloat,
  threshold: parseAsFloat,
};

export type DisplayParams = {
  [K in keyof typeof DISPLAY_PARSERS]: number | null;
};

/** Values that only make sense for the series they were measured from. */
export const SERIES_SPECIFIC = ["wc", "ww"] as const;

export function clearedForNewSeries(): Pick<DisplayParams, (typeof SERIES_SPECIFIC)[number]> {
  return { wc: null, ww: null };
}

/**
 * Read and write the display settings in the URL.
 *
 * The history entry is replaced, not added. A slider drag must not fill the
 * back button with hundreds of steps.
 */
export function useDisplayParams() {
  return useQueryStates(DISPLAY_PARSERS, {
    history: "replace",
    throttleMs: 120,
    clearOnDefault: true,
  });
}

/** Fill in every setting the URL leaves out, from the series defaults. */
export function resolveDisplay(
  params: DisplayParams,
  defaults: ViewerState,
): Pick<
  ViewerState,
  "windowCenter" | "windowWidth" | "tissueMix" | "slabThickness" | "opacity" | "threshold"
> {
  return {
    windowCenter: params.wc ?? defaults.windowCenter,
    windowWidth: params.ww ?? defaults.windowWidth,
    tissueMix: params.tissue ?? defaults.tissueMix,
    slabThickness: params.slab ?? defaults.slabThickness,
    opacity: params.density ?? defaults.opacity,
    threshold: params.threshold ?? defaults.threshold,
  };
}
