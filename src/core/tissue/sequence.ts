/**
 * Finding out which sequence a series holds.
 *
 * The tissue classifier needs two sequences of the same anatomy: a T1 and a
 * fat-saturated one. Nothing in DICOM states the sequence in a field that a
 * program can trust. ScanningSequence and SequenceVariant hold codes such as
 * `SE` and `SK`, and those codes do not say whether fat is saturated.
 *
 * The series description does say it, because the technologist named the
 * protocol: `t1_tse_cor` and `pd_tse_fs_cor`. So the name is what this module
 * reads. It is a guess from a string, so the viewer must show which series it
 * paired and let a reader change it.
 */
import { dot } from "../geometry/vec3.ts";
import type { Volume } from "../volume/build.ts";
import { sharesFrameOfReference } from "./resample.ts";

export type SequenceKind =
  /** Fat is bright, fluid is dark. */
  | "t1"
  /** Fat is pushed dark, fluid and edema are bright. */
  | "fatsat"
  /** Fluid is bright and fat stays bright. */
  | "t2"
  | "unknown";

/**
 * Words that name a fat-saturated sequence.
 *
 * STIR and SPAIR and SPIR are all fat suppression by another method. For the
 * classifier they behave the same: fat goes dark and water stays bright.
 */
const FAT_SAT = /(^|[^a-z])(fs|fatsat|fat_sat|stir|spair|spir|tirm)([^a-z]|$)/;

/** T1 and T2 appear as `t1`, `t2`, `t1w`, or `t2w`. */
const T1 = /(^|[^a-z])t1w?([^a-z0-9]|$)/;
const T2 = /(^|[^a-z])t2w?([^a-z0-9]|$)/;

/**
 * Read the sequence from a series description.
 *
 * Fat saturation is tested first. `pd_tse_fs` and `t2_tse_fs` are both
 * fat-saturated, and for this classifier that fact matters more than the
 * weighting.
 */
export function readSequenceKind(description: string): SequenceKind {
  const text = description.toLowerCase().replaceAll(/[\s-]+/g, "_");
  if (FAT_SAT.test(text)) return "fatsat";
  if (T1.test(text)) return "t1";
  if (T2.test(text)) return "t2";
  if (/(^|[^a-z])pdw?([^a-z0-9]|$)/.test(text)) return "t2";
  return "unknown";
}

export interface SequencePair {
  readonly t1: Volume;
  readonly fatsat: Volume;
  /** True when the two series were taken at different angles. */
  readonly oblique: boolean;
}

/** How closely two series were cut at the same angle. 1 is the same plane. */
function planeAgreement(a: Volume, b: Volume): number {
  return Math.abs(dot(a.axes[2], b.axes[2]));
}

/**
 * Find the T1 and fat-saturated pair that covers the active series.
 *
 * The active series must be one half of the pair, because the viewer draws the
 * active series and colors it. Returns nothing when the study holds no partner.
 *
 * A partner must share the frame of reference. Without that, patient
 * coordinates from the two series mean different things, and the colors would
 * be confident nonsense.
 *
 * Among the partners that qualify, the one cut at the closest angle wins. A
 * partner cut across the slices is read through the thick direction, where the
 * step between slices is 12 times the size of a pixel, so its detail is gone.
 */
export function findSequencePair(
  active: Volume,
  others: readonly Volume[],
): SequencePair | undefined {
  const activeKind = readSequenceKind(active.description);
  if (activeKind !== "t1" && activeKind !== "fatsat") return undefined;

  const wanted: SequenceKind = activeKind === "t1" ? "fatsat" : "t1";
  const partners = others
    .filter((volume) => volume.seriesInstanceUid !== active.seriesInstanceUid)
    .filter((volume) => readSequenceKind(volume.description) === wanted)
    .filter((volume) => sharesFrameOfReference(active, volume))
    .sort(
      (a, b) =>
        planeAgreement(active, b) - planeAgreement(active, a) ||
        b.dims[2] - a.dims[2] ||
        a.seriesInstanceUid.localeCompare(b.seriesInstanceUid),
    );

  const partner = partners[0];
  if (!partner) return undefined;

  return {
    t1: activeKind === "t1" ? active : partner,
    fatsat: activeKind === "t1" ? partner : active,
    oblique: planeAgreement(active, partner) < 0.99,
  };
}
