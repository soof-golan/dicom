/**
 * Grouping loose images into series.
 *
 * A folder of DICOM files holds no order. Every file names its series, and the
 * series is the unit that becomes one volume.
 */
import type { Instance } from "../dicom/instance.ts";
import { dot } from "../geometry/vec3.ts";

export interface Series {
  readonly seriesInstanceUid: string;
  readonly studyInstanceUid: string;
  readonly modality: string;
  readonly number: number;
  readonly description: string;
  /** Instances sorted along the slice normal, from first to last. */
  readonly instances: readonly Instance[];
}

/**
 * Sort slices by where they sit along the plane normal.
 *
 * Instance number is the tie-break. Two slices at one position happen in
 * multi-echo and dual-contrast series, and a stable order keeps the volume
 * reproducible.
 */
export function sortAlongNormal(instances: readonly Instance[]): Instance[] {
  const reference = instances[0];
  if (!reference) return [];
  const { normal } = reference;
  return [...instances].sort((a, b) => {
    const delta = dot(a.position, normal) - dot(b.position, normal);
    if (Math.abs(delta) > 1e-6) return delta;
    return a.instanceNumber - b.instanceNumber;
  });
}

/** Group instances by series, then sort each series and the list itself. */
export function groupIntoSeries(instances: readonly Instance[]): Series[] {
  const groups = new Map<string, Instance[]>();
  for (const instance of instances) {
    const key =
      instance.seriesInstanceUid || `${instance.studyInstanceUid}#${instance.seriesNumber}`;
    const group = groups.get(key);
    if (group) group.push(instance);
    else groups.set(key, [instance]);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = sortAlongNormal(group);
      const head = sorted[0]!;
      return {
        seriesInstanceUid: head.seriesInstanceUid,
        studyInstanceUid: head.studyInstanceUid,
        modality: head.modality,
        number: head.seriesNumber,
        description: head.seriesDescription,
        instances: sorted,
      };
    })
    .sort((a, b) => a.number - b.number || a.description.localeCompare(b.description));
}
