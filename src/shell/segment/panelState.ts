/**
 * Whether the segmentation panel is open.
 *
 * This one flag is the only part of the feature that the first page load
 * carries. Everything else - the store, the panel, the overlay, the worker and
 * the model runtime - loads behind a dynamic import once the flag turns on.
 */
import { create } from "zustand";

interface PanelState {
  readonly open: boolean;
  readonly toggle: () => void;
}

export const useSegmentPanel = create<PanelState>((set, get) => ({
  open: false,
  toggle: () => set({ open: !get().open }),
}));
