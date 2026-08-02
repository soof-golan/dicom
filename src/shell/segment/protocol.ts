/**
 * What the main thread and the segmentation worker say to each other.
 *
 * Types only. Both sides import this with `import type`, so no runtime edge
 * joins the worker chunk to the entry chunk. A value import here would pull
 * the model runtime into the first page load.
 */
import type { BoxPrompt, PointPrompt } from "../../core/segment/types.ts";
import type { ModelPlan, TextPlan } from "../../core/segment/plan.ts";

export type Phase =
  | "idle"
  | "downloading"
  | "compiling"
  | "encoding"
  | "ready"
  | "decoding"
  | "detecting"
  | "error";

export interface DetectedBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly score: number;
}

export type ToWorker =
  | {
      readonly kind: "load";
      readonly id: number;
      readonly plan: ModelPlan;
      /** The text model, or nothing to skip it. */
      readonly text: TextPlan | undefined;
    }
  /** Run the vision encoder once for one cut. Slow. */
  | {
      readonly kind: "encode";
      readonly id: number;
      readonly width: number;
      readonly height: number;
      readonly gray: Uint8Array;
    }
  /** Run the mask decoder for the cut that was encoded last. Fast. */
  | {
      readonly kind: "decode";
      readonly id: number;
      readonly points: readonly PointPrompt[];
      readonly box: BoxPrompt | undefined;
    }
  /** Turn a phrase into boxes on the cut that was encoded last. */
  | { readonly kind: "detect"; readonly id: number; readonly text: string }
  | { readonly kind: "dispose"; readonly id: number };

export type FromWorker =
  | {
      readonly kind: "progress";
      readonly phase: Phase;
      readonly loaded: number;
      readonly total: number;
      /** 0 to 1, or nothing when no total is known. Never show a made-up number. */
      readonly fraction: number | undefined;
      readonly file: string | undefined;
    }
  | { readonly kind: "loaded"; readonly id: number; readonly textReady: boolean }
  | { readonly kind: "encoded"; readonly id: number }
  | {
      readonly kind: "mask";
      readonly id: number;
      readonly width: number;
      readonly height: number;
      readonly data: Uint8Array;
      readonly score: number;
    }
  | { readonly kind: "boxes"; readonly id: number; readonly boxes: readonly DetectedBox[] }
  | { readonly kind: "failed"; readonly id: number; readonly message: string };
