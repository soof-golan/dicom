/**
 * Fusing series off the main thread.
 *
 * Fusion reads every source series once for every output voxel, so it costs
 * hundreds of millions of operations. On the main thread that freezes the
 * viewer for seconds, which reads as a crash.
 */
import { fuseVolumes, type FusionOptions } from "../../core/volume/fuse.ts";
import type { Volume } from "../../core/volume/build.ts";

export interface FuseRequest {
  readonly type: "fuse";
  readonly volumes: readonly Volume[];
  readonly options: FusionOptions;
}

export type FuseResponse =
  | { readonly type: "fused"; readonly volume: Volume }
  | { readonly type: "failed"; readonly reason: string };

self.onmessage = (event: MessageEvent<FuseRequest>) => {
  const request = event.data;
  if (request.type !== "fuse") return;
  try {
    const volume = fuseVolumes(request.volumes, request.options);
    const response: FuseResponse = { type: "fused", volume };
    // The data buffer is handed over, not copied. It can reach 32 MB.
    self.postMessage(response, [volume.data.buffer]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: "failed", reason } satisfies FuseResponse);
  }
};
