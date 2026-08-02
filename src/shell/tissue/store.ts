/**
 * The state of the dark-structure labels.
 *
 * This is a store of its own, next to the study store, so a run that takes
 * seconds never re-renders the viewer while it works.
 *
 * The labels are asked for once per pair of series. Nothing starts until the
 * reader turns tissue color on, because the run costs seconds and a reader who
 * never colors the image must not pay for it.
 */
import { create } from "zustand";
import type { Volume } from "../../core/volume/build.ts";
import type { FromStructureWorker, StructureResult, ToStructureWorker } from "./protocol.ts";

export type StructureStatus = "idle" | "working" | "ready" | "failed";

interface StructureStore {
  readonly status: StructureStatus;
  readonly error?: string;
  readonly result?: StructureResult;
  /** Which pair the result belongs to, so a series change asks again. */
  readonly key?: string;
  readonly request: (t1: Volume, fatsat: Volume, shapeVolume?: Volume) => void;
  readonly clear: () => void;
}

let worker: Worker | undefined;

function stop(): void {
  worker?.terminate();
  worker = undefined;
}

export const useStructures = create<StructureStore>((set, get) => ({
  status: "idle",

  request: (t1, fatsat, shapeVolume) => {
    const key = [t1, fatsat, shapeVolume]
      .map((volume) => volume?.seriesInstanceUid ?? "none")
      .join("|");
    if (get().key === key && get().status !== "failed") return;

    stop();
    set({ status: "working", key, error: undefined, result: undefined });

    worker = new Worker(new URL("./structures.worker.ts", import.meta.url), {
      type: "module",
      name: "dark-structures",
    });
    worker.onmessage = (event: MessageEvent<FromStructureWorker>) => {
      const message = event.data;
      if (message.type === "failed") {
        set({ status: "failed", error: message.reason });
      } else {
        set({ status: "ready", result: message });
      }
      stop();
    };
    worker.onerror = (event) => {
      set({ status: "failed", error: event.message || "the structure worker stopped" });
      stop();
    };

    const request: ToStructureWorker = { t1, fatsat, shapeVolume };
    worker.postMessage(request);
  },

  clear: () => {
    stop();
    set({ status: "idle", key: undefined, result: undefined, error: undefined });
  },
}));

if (import.meta.env.DEV) {
  (globalThis as unknown as { __structures?: typeof useStructures }).__structures = useStructures;
}
