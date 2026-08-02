/**
 * The worker that names dark structures.
 *
 * `findStructures` blurs the whole volume three times and then walks outward
 * from every component. On the elbow study that is about six seconds, and on
 * the main thread the viewer would freeze for all of it.
 */
import { findStructures } from "../../core/tissue/structures.ts";
import type { FromStructureWorker, ToStructureWorker } from "./protocol.ts";

function post(message: FromStructureWorker, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

onmessage = (event: MessageEvent<ToStructureWorker>) => {
  const { t1, fatsat, shapeVolume } = event.data;
  try {
    const field = findStructures({ t1, fatsat, shapeVolume });
    post(
      {
        type: "structures",
        dims: field.dims,
        patientToVoxel: field.patientToVoxel,
        labels: field.labels,
        confidence: field.confidence,
        darkVoxels: field.darkVoxels,
        namedVoxels: field.namedVoxels,
        // Only what a panel can show. The evidence numbers stay in the worker.
        components: field.components.map(({ id, structure, confidence, reason, voxels, kind }) => ({
          id,
          structure,
          confidence,
          reason,
          voxels,
          kind,
        })),
        warnings: field.warnings,
      },
      [field.labels.buffer, field.confidence.buffer],
    );
  } catch (error) {
    post({ type: "failed", reason: error instanceof Error ? error.message : String(error) });
  }
};
