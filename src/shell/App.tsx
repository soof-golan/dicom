import { useCallback, useEffect, useRef, useState } from "react";
import { PLANE_IDS, standardPlane, type PlaneId } from "../core/view/planes.ts";
import { loadStudy, readDataTransfer, readDevStudy, readFiles } from "./loader/loadStudy.ts";
import type { StudySource } from "./loader/messages.ts";
import { activeSeries, useStudy } from "./store.ts";
import { ViewerCanvas } from "./viewer/ViewerCanvas.tsx";

function useLoader() {
  return useCallback(async (sources: readonly StudySource[]) => {
    if (sources.length === 0) return;
    const store = useStudy.getState();
    store.beginLoad();
    try {
      await loadStudy(sources, {
        onProgress: (done, total, stage) => store.setProgress({ done, total, stage }),
        onSeries: (series) => store.addSeries(series),
        onSkipped: (name, reason) => store.addSkipped(name, reason),
      }).result;
      useStudy.getState().finishLoad();
    } catch (error) {
      useStudy.getState().failLoad(error instanceof Error ? error.message : String(error));
    }
  }, []);
}

function Dropzone({ onFiles }: { onFiles: (sources: readonly StudySource[]) => void }) {
  const [over, setOver] = useState(false);
  const status = useStudy((state) => state.status);
  const progress = useStudy((state) => state.progress);

  if (status === "loading") {
    const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="grid h-full place-items-center">
        <div className="w-72 text-center">
          <p className="mb-3 text-sm text-neutral-400">{progress.stage}</p>
          <div className="h-1 overflow-hidden rounded bg-neutral-800">
            <div
              className="h-full bg-sky-400 transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 font-mono text-xs text-neutral-500">
            {progress.done} / {progress.total}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`grid h-full place-items-center border-2 border-dashed transition-colors ${
        over ? "border-sky-400 bg-sky-400/5" : "border-neutral-800"
      }`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        void readDataTransfer(event.dataTransfer.items).then(onFiles);
      }}
    >
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-medium">Open a scan</h2>
        <p className="mt-2 text-sm text-neutral-400">
          Drop a DICOM folder here. Your files stay on this device.
        </p>
        <label className="mt-5 inline-block cursor-pointer rounded border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500">
          Choose a folder
          <input
            type="file"
            multiple
            className="hidden"
            // @ts-expect-error directory picking is not in the DOM types yet
            webkitdirectory=""
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              void readFiles(files).then(onFiles);
            }}
          />
        </label>
      </div>
    </div>
  );
}

function SeriesList() {
  const series = useStudy((state) => state.series);
  const activeUid = useStudy((state) => state.activeUid);
  const select = useStudy((state) => state.selectSeries);

  return (
    <ul className="space-y-1">
      {series.map(({ summary }) => {
        const active = summary.seriesInstanceUid === activeUid;
        return (
          <li key={summary.seriesInstanceUid}>
            <button
              type="button"
              onClick={() => select(summary.seriesInstanceUid)}
              className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
                active
                  ? "bg-sky-400/15 text-sky-200"
                  : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
              }`}
            >
              <span className="block truncate font-medium">
                {summary.description || `Series ${summary.number}`}
              </span>
              <span className="block font-mono text-[10px] text-neutral-500">
                {summary.modality} · {summary.dims[0]}×{summary.dims[1]}×{summary.sliceCount} ·{" "}
                {summary.plane}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-[11px] text-neutral-400">
        {label}
        <span className="font-mono text-neutral-500">{format?.(value) ?? value.toFixed(0)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 w-full accent-sky-400"
      />
    </label>
  );
}

function Controls() {
  const view = useStudy((state) => state.view);
  const patch = useStudy((state) => state.patchView);
  const toggleClip = useStudy((state) => state.toggleClip);
  const flipClip = useStudy((state) => state.flipClip);

  return (
    <div className="space-y-4">
      <Slider
        label="Brightness"
        value={view.windowCenter}
        min={view.windowCenter - view.windowWidth}
        max={view.windowCenter + view.windowWidth}
        step={1}
        onChange={(windowCenter) => patch({ windowCenter })}
      />
      <Slider
        label="Contrast"
        value={view.windowWidth}
        min={1}
        max={Math.max(view.windowWidth * 3, 100)}
        step={1}
        onChange={(windowWidth) => patch({ windowWidth })}
      />
      <Slider
        label="Tissue color"
        value={view.tissueMix}
        min={0}
        max={1}
        step={0.01}
        onChange={(tissueMix) => patch({ tissueMix })}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <Slider
        label="Slab thickness"
        value={view.slabThickness}
        min={0}
        max={40}
        step={0.5}
        onChange={(slabThickness) => patch({ slabThickness })}
        format={(v) => (v < 0.1 ? "off" : `${v.toFixed(1)} mm`)}
      />
      <Slider
        label="3D density"
        value={view.opacity}
        min={0.2}
        max={12}
        step={0.1}
        onChange={(opacity) => patch({ opacity })}
        format={(v) => v.toFixed(1)}
      />

      <div>
        <p className="mb-1.5 text-[11px] text-neutral-400">Cut the 3D view</p>
        <div className="grid grid-cols-3 gap-1">
          {PLANE_IDS.map((id: PlaneId) => (
            <button
              key={id}
              type="button"
              onClick={() => (view.clip[id] ? flipClip(id) : toggleClip(id))}
              onContextMenu={(event) => {
                event.preventDefault();
                toggleClip(id);
              }}
              className={`rounded border px-1 py-1 text-[10px] capitalize transition-colors ${
                view.clip[id]
                  ? "border-sky-400/60 bg-sky-400/15 text-sky-200"
                  : "border-neutral-800 text-neutral-500 hover:border-neutral-600"
              }`}
            >
              {id}
              {view.clip[id] ? (view.clipFlip[id] ? " ↓" : " ↑") : ""}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-neutral-600">
          Click to cut, click again to flip. Right-click to clear.
        </p>
      </div>
    </div>
  );
}

/** Direction letters drawn over each cut, the way a radiology station shows them. */
function EdgeLabels() {
  const series = useStudy(activeSeries);
  const view = useStudy((state) => state.view);
  if (!series) return null;

  return (
    <div className="pointer-events-none absolute inset-0 grid grid-cols-2 grid-rows-2 gap-0.5">
      {PLANE_IDS.map((id) => {
        const plane = standardPlane(series.volume, id, view.cursor, view.pan[id]);
        return (
          <div key={id} className="relative overflow-hidden">
            <span className="absolute left-2 top-1.5 text-[11px] font-medium tracking-wide text-neutral-300">
              {plane.label}
            </span>
            <span className="absolute left-1/2 top-1.5 -translate-x-1/2 font-mono text-[11px] text-sky-300/70">
              {plane.edges.top}
            </span>
            <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 font-mono text-[11px] text-sky-300/70">
              {plane.edges.bottom}
            </span>
            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-sky-300/70">
              {plane.edges.left}
            </span>
            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-sky-300/70">
              {plane.edges.right}
            </span>
          </div>
        );
      })}
      <div className="relative">
        <span className="absolute left-2 top-1.5 text-[11px] font-medium tracking-wide text-neutral-300">
          3D
        </span>
      </div>
    </div>
  );
}

export function App() {
  const load = useLoader();
  const status = useStudy((state) => state.status);
  const series = useStudy((state) => state.series);
  const error = useStudy((state) => state.error);

  // In development, the server can offer a study so the viewer has data at once.
  // React runs an effect twice under StrictMode, so this guard keeps one load.
  const devLoadStarted = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || devLoadStarted.current) return;
    devLoadStarted.current = true;
    void readDevStudy().then((sources) => {
      if (sources.length > 0) void load(sources);
    });
  }, [load]);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-neutral-800 bg-[#0e1015] p-3">
        <header>
          <h1 className="text-sm font-semibold tracking-tight">DICOM Viewer</h1>
          <p className="text-[11px] text-neutral-500">Nothing leaves this device.</p>
        </header>
        {series.length > 0 && (
          <section>
            <h2 className="mb-1.5 text-[11px] uppercase tracking-wider text-neutral-500">Series</h2>
            <SeriesList />
          </section>
        )}
        {series.length > 0 && (
          <section>
            <h2 className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">Display</h2>
            <Controls />
          </section>
        )}
      </aside>

      <main className="relative min-w-0 flex-1">
        {status === "ready" || series.length > 0 ? (
          <>
            <ViewerCanvas />
            <EdgeLabels />
          </>
        ) : (
          <Dropzone onFiles={load} />
        )}
        {error && (
          <p className="absolute bottom-3 left-3 rounded bg-red-500/15 px-2 py-1 text-xs text-red-300">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
