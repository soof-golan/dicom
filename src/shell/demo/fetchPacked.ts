/**
 * Fetching the packed demo study.
 *
 * The core reads the packed format. This module is the only part that touches
 * the network, because `src/core` may not.
 *
 * The bucket serves each `.raw` file with `Content-Encoding: br` or `gzip`, so
 * the browser inflates the body before `arrayBuffer()` ever sees it. There is
 * no decoder here and no library to load. `docs/demo-dataset.md` lists the
 * headers the bucket must send.
 */
import {
  parseManifest,
  volumeFromPacked,
  type PackedManifest,
  type PackedSidecar,
} from "../../core/volume/packed.ts";
import type { Volume } from "../../core/volume/build.ts";

export class DemoFetchError extends Error {
  override readonly name = "DemoFetchError";
}

async function get(url: URL, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new DemoFetchError(`${url.href} answered ${response.status} ${response.statusText}`);
  }
  return response;
}

/** Read the study manifest. One request for the whole study. */
export async function fetchManifest(base: URL, signal?: AbortSignal): Promise<PackedManifest> {
  const response = await get(new URL("manifest.json", base), signal);
  return parseManifest(await response.json());
}

/** Read one grid. One request, and the body streams. */
export async function fetchVolume(
  base: URL,
  sidecar: PackedSidecar,
  signal?: AbortSignal,
): Promise<Volume> {
  const response = await get(new URL(sidecar.url, base), signal);
  return volumeFromPacked(sidecar, await response.arrayBuffer());
}
