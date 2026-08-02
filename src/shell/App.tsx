import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { TISSUE_INFO, TISSUE_ORDER } from "../core/tissue/classify.ts";
import { STRUCTURE_INFO, STRUCTURE_ORDER } from "../core/tissue/structures.ts";
import { useStructures } from "./tissue/store.ts";
import { PLANE_IDS, standardPlane, type PlaneId } from "../core/view/planes.ts";
import { findFusionCandidate } from "./loader/fuseStudy.ts";
import { loadStudy, readDataTransfer, readDevStudy, readFiles } from "./loader/loadStudy.ts";
import type { StudySource } from "./loader/messages.ts";
import { pageHref, usePage } from "./routes.ts";
import { SegmentLayer, SegmentSection } from "./segment/SegmentSection.tsx";
import { activeSeries, useStudy } from "./store.ts";
import { Tutorial, useTutorial } from "./Tutorial.tsx";
import { clearedForNewSeries, resolveDisplay, useDisplayParams } from "./viewState.ts";

// three.js is the largest dependency by far, and a reader who has opened no
// scan does not need it. The legal pages need none of the viewer at all.
const ViewerCanvas = lazy(async () => ({
  default: (await import("./viewer/ViewerCanvas.tsx")).ViewerCanvas,
}));
const PrivacyPolicy = lazy(async () => ({
  default: (await import("./legal/PrivacyPolicy.tsx")).PrivacyPolicy,
}));
const Terms = lazy(async () => ({ default: (await import("./legal/Terms.tsx")).Terms }));

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
  const [, setDisplay] = useDisplayParams();

  return (
    <ul className="space-y-1">
      {series.map(({ summary }) => {
        const active = summary.seriesInstanceUid === activeUid;
        return (
          <li key={summary.seriesInstanceUid}>
            <button
              type="button"
              onClick={() => {
                // Brightness and contrast were measured from the old series.
                void setDisplay(clearedForNewSeries());
                select(summary.seriesInstanceUid);
              }}
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

/**
 * Offer to build one volume with cubic voxels.
 *
 * It appears only when the study holds two or more series of one sequence, cut
 * at different angles. That is the case fusion can improve, and outside it the
 * button would promise detail that no series measured.
 */
function FuseButton() {
  const series = useStudy((state) => state.series);
  const fusing = useStudy((state) => state.fusing);
  const fuse = useStudy((state) => state.fuseSeries);

  const candidate = findFusionCandidate(series.map((entry) => entry.volume));
  const already = series.some((entry) => entry.volume.seriesInstanceUid.startsWith("fused:"));
  if (!candidate || already) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={fusing}
        onClick={() => void fuse()}
        className="w-full rounded border border-neutral-800 px-2 py-1.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-50"
      >
        {fusing ? "Combining…" : `Combine ${candidate.volumes.length} series`}
      </button>
      <p className="mt-1 text-[10px] leading-relaxed text-neutral-600">
        Builds one volume with {candidate.spacing.toFixed(1)} mm cubic voxels. Cuts at an angle get
        sharper. Detail inside a slice gets coarser, so the originals stay.
      </p>
    </div>
  );
}

/**
 * One display control.
 *
 * The ends are fixed by the caller and never move with the value. A double
 * click returns the control to the value the series opened with.
 */
function Slider({
  label,
  value,
  min,
  max,
  step,
  isDefault,
  onChange,
  onReset,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  isDefault: boolean;
  onChange: (value: number) => void;
  onReset: () => void;
  format?: (value: number) => string;
}) {
  const clamped = Math.min(Math.max(value, min), max);
  return (
    <label className="block" title="Double click to restore the starting value">
      <span className="flex justify-between text-[11px] text-neutral-400">
        {label}
        <span className={isDefault ? "font-mono text-neutral-600" : "font-mono text-sky-300/80"}>
          {format?.(value) ?? value.toFixed(0)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamped}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={onReset}
        className="mt-1 w-full accent-sky-400"
      />
    </label>
  );
}

function Controls() {
  const view = useStudy((state) => state.view);
  const limits = useStudy((state) => state.limits);
  const [params, setParams] = useDisplayParams();

  const contrastStep = Math.max(1, Math.round(limits.windowWidth[1] / 400));
  const clearAll = () =>
    void setParams({
      wc: null,
      ww: null,
      tissue: null,
      slab: null,
      density: null,
      threshold: null,
    });

  return (
    <div className="space-y-4">
      <Slider
        label="Brightness"
        value={view.windowCenter}
        min={limits.windowCenter[0]}
        max={limits.windowCenter[1]}
        step={contrastStep}
        isDefault={params.wc === null}
        onChange={(wc) => void setParams({ wc })}
        onReset={() => void setParams({ wc: null })}
      />
      <Slider
        label="Contrast"
        value={view.windowWidth}
        min={limits.windowWidth[0]}
        max={limits.windowWidth[1]}
        step={contrastStep}
        isDefault={params.ww === null}
        onChange={(ww) => void setParams({ ww })}
        onReset={() => void setParams({ ww: null })}
      />
      <Slider
        label="Tissue color"
        value={view.tissueMix}
        min={0}
        max={1}
        step={0.01}
        isDefault={params.tissue === null}
        onChange={(tissue) => void setParams({ tissue })}
        onReset={() => void setParams({ tissue: null })}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <TissueLegend />
      <Slider
        label="Slab thickness"
        value={view.slabThickness}
        min={0}
        max={40}
        step={0.5}
        isDefault={params.slab === null}
        onChange={(slab) => void setParams({ slab })}
        onReset={() => void setParams({ slab: null })}
        format={(v) => (v < 0.1 ? "off" : `${v.toFixed(1)} mm`)}
      />
      <Slider
        label="3D density"
        value={view.opacity}
        min={0.2}
        max={12}
        step={0.1}
        isDefault={params.density === null}
        onChange={(density) => void setParams({ density })}
        onReset={() => void setParams({ density: null })}
        format={(v) => v.toFixed(1)}
      />
      <Slider
        label="3D threshold"
        value={view.threshold}
        min={0}
        max={0.9}
        step={0.01}
        isDefault={params.threshold === null}
        onChange={(threshold) => void setParams({ threshold })}
        onReset={() => void setParams({ threshold: null })}
        format={(v) => `${Math.round(v * 100)}%`}
      />

      <ClipControls />

      <button
        type="button"
        onClick={clearAll}
        className="w-full rounded border border-neutral-800 px-2 py-1.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
      >
        Restore every setting
      </button>
    </div>
  );
}

/**
 * What the colors mean, and how much to trust them.
 *
 * The legend states which two series named the tissue. A reader who does not
 * know that cannot judge the colors, and this classifier reads signal, not
 * anatomy, so that judgement is the whole safeguard.
 */
function TissueLegend() {
  const pair = useStudy((state) => state.pair);
  const series = useStudy(activeSeries);
  const tissueMix = useStudy((state) => state.view.tissueMix);
  if (tissueMix <= 0 || !series) return null;

  const classes = pair ? TISSUE_ORDER : (["dark", "muscle", "fat", "fluid"] as const);

  return (
    <div className="rounded border border-neutral-800 p-2">
      {pair ? (
        <p className="text-[11px] text-neutral-400">
          From <span className="font-mono text-neutral-300">{pair.t1.description}</span> and{" "}
          <span className="font-mono text-neutral-300">{pair.fatsat.description}</span>.
        </p>
      ) : (
        <p className="text-[11px] text-amber-400/80">
          One sequence only. Fat and fluid cannot be told apart, so the colors are coarse and fade
          where the signal is unclear.
        </p>
      )}
      {pair?.oblique && (
        <p className="mt-1 text-[11px] text-amber-400/80">
          The two series were cut at different angles, so the partner is read through its thick
          direction.
        </p>
      )}

      <ul className="mt-2 space-y-1">
        {classes.map((id) => (
          <li key={id} className="flex items-start gap-2" title={TISSUE_INFO[id].covers}>
            <span
              className="mt-0.5 size-2.5 shrink-0 rounded-sm"
              style={{
                backgroundColor: `rgb(${TISSUE_INFO[id].color
                  .map((c) => Math.round(c * 255))
                  .join(" ")})`,
              }}
            />
            <span className="text-[11px] leading-tight text-neutral-400">
              {TISSUE_INFO[id].name}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
        Colors come from signal strength, not from anatomy. A gray pixel is one the classifier would
        not name.
      </p>

      <StructureLegend />
    </div>
  );
}

/**
 * The classes that shape named, kept apart from the classes that signal named.
 *
 * A reader must be able to tell the two claims apart. The colors above come
 * from a signal difference that physics puts there. The colors below come from
 * form and position, which is weaker, so they sit under their own heading with
 * their own warning.
 */
function StructureLegend() {
  const status = useStructures((state) => state.status);
  const result = useStructures((state) => state.result);
  const error = useStructures((state) => state.error);
  const request = useStructures((state) => state.request);
  const pair = useStudy((state) => state.pair);
  const tissueMix = useStudy((state) => state.view.tissueMix);

  // Naming dark structures costs seconds, so it waits for a reader who turned
  // tissue color on. The worker answers once per pair.
  useEffect(() => {
    if (tissueMix > 0 && pair) request(pair.t1, pair.fatsat);
  }, [tissueMix, pair, request]);

  if (status === "idle") return null;

  const found = new Set(
    (result?.components ?? [])
      .filter((component) => component.structure !== "dark")
      .map((component) => component.structure),
  );

  return (
    <div className="mt-3 border-t border-neutral-800 pt-2">
      <p className="text-[11px] font-medium text-neutral-300">Named by shape, not by signal</p>
      <p className="mt-1 text-[10px] leading-relaxed text-amber-400/80">
        Cortex, tendon, ligament, and vessel give no signal at this echo time, so no threshold can
        separate them. These four are separated by shape and by what each end touches. That is a
        weaker claim than the classes above, and it can be wrong.
      </p>

      {status === "working" && <p className="mt-2 text-[11px] text-neutral-500">Reading shapes…</p>}
      {status === "failed" && <p className="mt-2 text-[11px] text-red-300">{error}</p>}

      {status === "ready" && result && (
        <>
          <ul className="mt-2 space-y-1">
            {STRUCTURE_ORDER.filter((id) => id !== "dark").map((id) => (
              <li key={id} className="flex items-start gap-2" title={STRUCTURE_INFO[id].covers}>
                <span
                  className="mt-0.5 size-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: `rgb(${STRUCTURE_INFO[id].color
                      .map((c) => Math.round(c * 255))
                      .join(" ")})`,
                    opacity: found.has(id) ? 1 : 0.25,
                  }}
                />
                <span
                  className={`text-[11px] leading-tight ${
                    found.has(id) ? "text-neutral-400" : "text-neutral-600"
                  }`}
                >
                  {STRUCTURE_INFO[id].name}
                  {!found.has(id) && " — none found"}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
            Named {result.namedVoxels.toLocaleString()} of {result.darkVoxels.toLocaleString()} dark
            voxels. The rest stayed unnamed, because naming them would be a guess.
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-neutral-600">
            Bone reads as two claims: marrow above, from signal, and cortex here, from shape.
          </p>
          {result.warnings.map((warning) => (
            <p key={warning} className="mt-1 text-[10px] leading-relaxed text-amber-400/70">
              {warning}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

function ClipControls() {
  const view = useStudy((state) => state.view);
  const toggleClip = useStudy((state) => state.toggleClip);
  const flipClip = useStudy((state) => state.flipClip);

  return (
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
            {view.clip[id] ? (view.clipFlip[id] ? " \u2193" : " \u2191") : ""}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-neutral-600">
        Click to cut, click again to flip. Right-click to clear.
      </p>
    </div>
  );
}

/**
 * Keep the store in step with the address bar.
 *
 * The URL decides these six settings. The renderer reads the store, not React,
 * so the values have to reach it. Nothing writes back the other way, so there
 * is no loop.
 */
function useDisplayFromUrl(): void {
  const [params] = useDisplayParams();
  const defaults = useStudy((state) => state.defaults);
  const patch = useStudy((state) => state.patchView);

  useEffect(() => {
    patch(resolveDisplay(params, defaults));
  }, [params, defaults, patch]);
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

function SidebarFooter({ onReplayTutorial }: { onReplayTutorial: () => void }) {
  return (
    <footer className="mt-auto space-y-2 border-t border-neutral-800 pt-3">
      <button
        type="button"
        onClick={onReplayTutorial}
        className="text-[11px] text-neutral-500 transition-colors hover:text-neutral-300"
      >
        Show the tutorial again
      </button>
      <p className="flex gap-3 text-[11px] text-neutral-600">
        <a href={pageHref("privacy")} className="transition-colors hover:text-neutral-400">
          Privacy
        </a>
        <a href={pageHref("terms")} className="transition-colors hover:text-neutral-400">
          Terms
        </a>
        <a
          href="https://github.com/soof-golan/dicom"
          className="transition-colors hover:text-neutral-400"
        >
          Source
        </a>
      </p>
      <p className="text-[10px] leading-relaxed text-neutral-700">
        Not a medical device. Do not use for diagnosis.
      </p>
    </footer>
  );
}

function LegalScreen({ page }: { page: "privacy" | "terms" }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <a
          href={pageHref("viewer")}
          className="mb-8 inline-block text-[12px] text-neutral-500 transition-colors hover:text-neutral-300"
        >
          &larr; Back to the viewer
        </a>
        <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
          {page === "privacy" ? <PrivacyPolicy /> : <Terms />}
        </Suspense>
      </div>
    </div>
  );
}

export function App() {
  const load = useLoader();
  const status = useStudy((state) => state.status);
  const series = useStudy((state) => state.series);
  const error = useStudy((state) => state.error);
  const [page] = usePage();
  const tutorial = useTutorial();
  useDisplayFromUrl();

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

  if (page === "privacy" || page === "terms") {
    return <LegalScreen page={page} />;
  }

  const hasSeries = series.length > 0;
  // The tutorial waits for a scan. Pointing at an empty screen teaches nothing.
  const showTutorial = tutorial.loaded && !tutorial.state.finished && hasSeries;

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-neutral-800 bg-[#0e1015] p-3">
        <header>
          <h1 className="text-sm font-semibold tracking-tight">DICOM Viewer</h1>
          <p className="text-[11px] text-neutral-500">Nothing leaves this device.</p>
        </header>
        {hasSeries && (
          <section>
            <h2 className="mb-1.5 text-[11px] uppercase tracking-wider text-neutral-500">Series</h2>
            <SeriesList />
            <FuseButton />
          </section>
        )}
        {hasSeries && (
          <section>
            <h2 className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">Display</h2>
            <Controls />
          </section>
        )}
        {hasSeries && <SegmentSection />}
        <SidebarFooter onReplayTutorial={tutorial.restart} />
      </aside>

      <main className="relative min-w-0 flex-1">
        {status === "ready" || hasSeries ? (
          <Suspense fallback={null}>
            <ViewerCanvas />
            <EdgeLabels />
            <SegmentLayer />
          </Suspense>
        ) : (
          <Dropzone onFiles={load} />
        )}
        {error && (
          <p className="absolute bottom-3 left-3 rounded bg-red-500/15 px-2 py-1 text-xs text-red-300">
            {error}
          </p>
        )}
      </main>

      {showTutorial && <Tutorial state={tutorial.state} onChange={tutorial.update} />}
    </div>
  );
}
