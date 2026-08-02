/**
 * Fixture access for tests.
 *
 * This module reads from disk, so it is not part of the functional core. It
 * lives here because only the core tests use it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../../tests/fixtures/", import.meta.url).pathname;

/** The four series in the fixture study, in the order the scanner made them. */
export const SERIES_NAMES = [
  "pd_tse_fs_cor_DRB",
  "pd_tse_fs_sag_DRB",
  "pd_tse_fs_tra_DRB",
  "t1_tse_cor_DRB",
] as const;

export type SeriesName = (typeof SERIES_NAMES)[number];

export function readFixture(relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, relativePath)));
}

export function readSeries(name: SeriesName): Uint8Array[] {
  const dir = join(ROOT, "series", name);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".dcm"))
    .sort()
    .map((file) => new Uint8Array(readFileSync(join(dir, file))));
}

export function readAllSeries(): Uint8Array[] {
  return SERIES_NAMES.flatMap(readSeries);
}
