/**
 * Reading a study into memory.
 *
 * Files reach the app from three places: a drop, a file picker, and the
 * development server. All three end here, as an array of named byte buffers,
 * and go to the parsing worker.
 */
import type { Volume } from "../../core/volume/build.ts";
import type { LoadRequest, LoadResponse, SeriesSummary, StudySource } from "./messages.ts";

export interface LoadedSeries {
  readonly volume: Volume;
  readonly summary: SeriesSummary;
}

export interface LoadHandlers {
  onProgress?: (done: number, total: number, stage: string) => void;
  onSeries?: (series: LoadedSeries) => void;
  onSkipped?: (name: string, reason: string) => void;
}

export class StudyLoadError extends Error {
  override readonly name = "StudyLoadError";
}

/** Parse a set of files into volumes, one series at a time. */
export function loadStudy(
  files: readonly StudySource[],
  handlers: LoadHandlers = {},
): { result: Promise<LoadedSeries[]>; cancel: () => void } {
  const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), {
    type: "module",
    name: "dicom-parser",
  });

  const collected: LoadedSeries[] = [];
  let settled = false;

  const result = new Promise<LoadedSeries[]>((resolve, reject) => {
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      action();
    };

    worker.onmessage = (event: MessageEvent<LoadResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          handlers.onProgress?.(message.done, message.total, message.stage);
          break;
        case "volume": {
          const series = { volume: message.volume, summary: message.summary };
          collected.push(series);
          handlers.onSeries?.(series);
          break;
        }
        case "skipped":
          handlers.onSkipped?.(message.name, message.reason);
          break;
        case "done":
          finish(() => resolve(collected));
          break;
        case "failed":
          finish(() => reject(new StudyLoadError(message.reason)));
          break;
      }
    };

    worker.onerror = (event) => {
      finish(() => reject(new StudyLoadError(event.message || "the parsing worker stopped")));
    };

    const request: LoadRequest = { type: "load", files };
    worker.postMessage(
      request,
      files.map((file) => file.bytes),
    );
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

/** A DICOM file has no reliable extension, so size is the only cheap filter. */
function looksLikeDicom(file: File): boolean {
  if (file.size < 136) return false;
  const name = file.name.toLowerCase();
  if (name.endsWith(".dcm") || name.endsWith(".dicom")) return true;
  // Many archives write DICOMDIR and extension-less files.
  return !/\.(jpe?g|png|gif|pdf|txt|xml|json|zip|html?|csv|md)$/.test(name);
}

export async function readFiles(files: readonly File[]): Promise<StudySource[]> {
  const wanted = files.filter(looksLikeDicom);
  return Promise.all(
    wanted.map(async (file) => ({
      name: file.webkitRelativePath || file.name,
      bytes: await file.arrayBuffer(),
    })),
  );
}

/** Walk a dropped folder. A drop gives entries, not files, when it is a folder. */
export async function readDataTransfer(items: DataTransferItemList): Promise<StudySource[]> {
  const roots: FileSystemEntry[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (roots.length === 0) return [];

  const files: File[] = [];
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push(file);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await visit(child);
    }
  };

  for (const root of roots) await visit(root);
  return readFiles(files);
}

interface DevManifest {
  readonly root: string;
  readonly series: readonly { readonly name: string; readonly files: readonly string[] }[];
}

/**
 * Fetch the study that the development server offers.
 *
 * Returns an empty array when no study is configured, so the caller can treat
 * it as "nothing to load" rather than an error.
 */
export async function readDevStudy(
  onProgress?: (done: number, total: number) => void,
): Promise<StudySource[]> {
  const response = await fetch("/__study/manifest.json");
  if (!response.ok) return [];
  const manifest = (await response.json()) as DevManifest;
  const paths = manifest.series.flatMap((series) => series.files);

  const sources: StudySource[] = [];
  let done = 0;
  const batchSize = 12;
  for (let start = 0; start < paths.length; start += batchSize) {
    const batch = paths.slice(start, start + batchSize);
    const loaded = await Promise.all(
      batch.map(async (path) => ({
        name: path,
        bytes: await (await fetch(`/__study/${encodeURI(path)}`)).arrayBuffer(),
      })),
    );
    sources.push(...loaded);
    done += loaded.length;
    onProgress?.(done, paths.length);
  }
  return sources;
}
