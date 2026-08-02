/**
 * Choosing which series to fuse, and running the fusion.
 *
 * Fusion only helps when the series measured the same thing from different
 * angles. Two series with different contrast must never be averaged: a T1 and a
 * fat-saturated sequence disagree about fat on purpose, and the average of the
 * two says nothing about either.
 */
import { readSequenceKind } from "../../core/tissue/sequence.ts";
import type { Volume } from "../../core/volume/build.ts";
import { planFusion, shareFrameOfReference, type FusionOptions } from "../../core/volume/fuse.ts";
import type { FuseRequest, FuseResponse } from "./fuse.worker.ts";

/**
 * A budget the browser can hold and finish in a few seconds.
 *
 * Eight million voxels is 16 MB as 16-bit data. For this elbow it lands near
 * 0.7 mm cubic, which is about five times finer through the slices than the
 * 3.3 mm the scanner measured, and coarser than 0.27 mm inside a slice. So the
 * fused volume is offered beside the originals, never in place of them.
 */
export const DEFAULT_FUSION: FusionOptions = { voxelBudget: 8_000_000 };

export interface FusionCandidate {
  readonly volumes: readonly Volume[];
  /** The step the result will use, in millimeters. */
  readonly spacing: number;
  readonly voxels: number;
}

/** Are these two series cut at meaningfully different angles? */
function differentAngle(a: Volume, b: Volume): boolean {
  const [x, y, z] = a.axes[2];
  const [p, q, r] = b.axes[2];
  return Math.abs(x * p + y * q + z * r) < 0.9;
}

/**
 * Find the largest set of series worth fusing.
 *
 * The set must share one sequence and one frame of reference, and must hold at
 * least two different cut angles. Two series cut the same way add signal but no
 * detail, and detail is the reason to do this.
 */
export function findFusionCandidate(volumes: readonly Volume[]): FusionCandidate | undefined {
  const byKind = new Map<string, Volume[]>();
  for (const volume of volumes) {
    const kind = readSequenceKind(volume.description);
    if (kind === "unknown") continue;
    const key = `${kind}:${volume.frameOfReferenceUid}`;
    byKind.set(key, [...(byKind.get(key) ?? []), volume]);
  }

  let best: FusionCandidate | undefined;
  for (const group of byKind.values()) {
    if (group.length < 2 || !shareFrameOfReference(group)) continue;
    const angled = group.some((a) => group.some((b) => differentAngle(a, b)));
    if (!angled) continue;

    const grid = planFusion(group, DEFAULT_FUSION);
    const candidate: FusionCandidate = {
      volumes: group,
      spacing: grid.spacing[0],
      voxels: grid.dims[0] * grid.dims[1] * grid.dims[2],
    };
    if (!best || candidate.volumes.length > best.volumes.length) best = candidate;
  }
  return best;
}

export class FusionFailed extends Error {
  override readonly name = "FusionFailed";
}

/** Run the fusion in a worker. The promise settles when the worker answers. */
export function fuseInWorker(
  volumes: readonly Volume[],
  options: FusionOptions = DEFAULT_FUSION,
): { result: Promise<Volume>; cancel: () => void } {
  const worker = new Worker(new URL("./fuse.worker.ts", import.meta.url), {
    type: "module",
    name: "dicom-fuse",
  });

  let settled = false;
  const result = new Promise<Volume>((resolve, reject) => {
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      action();
    };

    worker.onmessage = (event: MessageEvent<FuseResponse>) => {
      const message = event.data;
      if (message.type === "fused") finish(() => resolve(message.volume));
      else finish(() => reject(new FusionFailed(message.reason)));
    };
    worker.onerror = (event) => {
      finish(() => reject(new FusionFailed(event.message || "the fusion worker stopped")));
    };

    worker.postMessage({ type: "fuse", volumes, options } satisfies FuseRequest);
  });

  return {
    result,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
    },
  };
}
