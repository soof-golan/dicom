/** The contract between the main thread and the parsing worker. */
import type { Volume } from "../../core/volume/build.ts";

export interface StudySource {
  readonly name: string;
  readonly bytes: ArrayBuffer;
}

export type LoadRequest = {
  readonly type: "load";
  readonly files: readonly StudySource[];
};

export interface SeriesSummary {
  readonly seriesInstanceUid: string;
  readonly description: string;
  readonly modality: string;
  readonly number: number;
  readonly sliceCount: number;
  readonly plane: string;
  readonly dims: readonly [number, number, number];
  readonly spacing: readonly [number, number, number];
}

export type LoadResponse =
  | {
      readonly type: "progress";
      readonly done: number;
      readonly total: number;
      readonly stage: string;
    }
  | { readonly type: "volume"; readonly volume: Volume; readonly summary: SeriesSummary }
  | { readonly type: "skipped"; readonly name: string; readonly reason: string }
  | { readonly type: "done"; readonly volumeCount: number; readonly skippedCount: number }
  | { readonly type: "failed"; readonly reason: string };
