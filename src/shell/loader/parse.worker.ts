/// <reference lib="webworker" />
/**
 * The parsing worker.
 *
 * It holds every expensive step: byte parsing, pixel decoding, and volume
 * assembly. The main thread stays free to draw, so a large study never freezes
 * the interface. Each finished volume is posted as soon as it is ready, and its
 * pixel buffer is transferred instead of copied.
 */
import { readInstance, type Instance } from "../../core/dicom/instance.ts";
import { parseDicom } from "../../core/dicom/parse.ts";
import { describePlane } from "../../core/geometry/anatomy.ts";
import { buildVolume } from "../../core/volume/build.ts";
import { groupIntoSeries } from "../../core/volume/series.ts";
import type { LoadRequest, LoadResponse, SeriesSummary } from "./messages.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: LoadResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(
  instances: readonly Instance[],
  volume: ReturnType<typeof buildVolume>,
): SeriesSummary {
  return {
    seriesInstanceUid: volume.seriesInstanceUid,
    description: volume.description,
    modality: volume.modality,
    number: instances[0]?.seriesNumber ?? 0,
    sliceCount: volume.dims[2],
    plane: describePlane(volume.axes[2]),
    dims: volume.dims,
    spacing: volume.spacing,
  };
}

function handle(request: LoadRequest): void {
  const instances: Instance[] = [];
  let skipped = 0;

  request.files.forEach((file, index) => {
    try {
      instances.push(readInstance(parseDicom(new Uint8Array(file.bytes))));
    } catch (error) {
      skipped += 1;
      post({ type: "skipped", name: file.name, reason: reason(error) });
    }
    if (index % 16 === 0 || index === request.files.length - 1) {
      post({
        type: "progress",
        done: index + 1,
        total: request.files.length,
        stage: "Reading files",
      });
    }
  });

  if (instances.length === 0) {
    post({ type: "failed", reason: "No readable DICOM images were found." });
    return;
  }

  const series = groupIntoSeries(instances);
  let built = 0;

  series.forEach((entry, index) => {
    post({
      type: "progress",
      done: index,
      total: series.length,
      stage: `Building ${entry.description || "series"}`,
    });
    try {
      const volume = buildVolume(entry.instances);
      built += 1;
      post({ type: "volume", volume, summary: summarize(entry.instances, volume) }, [
        volume.data.buffer,
      ]);
    } catch (error) {
      skipped += entry.instances.length;
      post({
        type: "skipped",
        name: entry.description || entry.seriesInstanceUid,
        reason: reason(error),
      });
    }
  });

  post({ type: "done", volumeCount: built, skippedCount: skipped });
}

scope.onmessage = (event: MessageEvent<LoadRequest>) => {
  try {
    handle(event.data);
  } catch (error) {
    post({ type: "failed", reason: reason(error) });
  }
};
