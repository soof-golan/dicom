/**
 * The Segment panel in the left sidebar.
 *
 * Everything is behind a gesture. The panel probes the machine when it opens,
 * states the real download size, and downloads nothing until the user asks.
 */
import { useEffect, useState } from "react";
import { formatBytes } from "../../core/segment/plan.ts";
import type { Segment } from "../../core/segment/types.ts";
import { downloadSize, segmentVolume, useSegment, type PromptMode } from "./store.ts";

function Bar({ fraction }: { fraction: number | undefined }) {
  return (
    <div className="h-1 overflow-hidden rounded bg-neutral-800">
      <div
        className={`h-full bg-sky-400 ${fraction === undefined ? "animate-pulse" : "transition-[width] duration-150"}`}
        style={{ width: fraction === undefined ? "100%" : `${Math.round(fraction * 100)}%` }}
      />
    </div>
  );
}

function ModeButton({ id, label, hint }: { id: PromptMode; label: string; hint: string }) {
  const mode = useSegment((state) => state.mode);
  const setMode = useSegment((state) => state.setMode);
  const active = mode === id;
  return (
    <button
      type="button"
      title={hint}
      onClick={() => setMode(active ? "off" : id)}
      className={`rounded border px-1 py-1 text-[10px] transition-colors ${
        active
          ? "border-sky-400/60 bg-sky-400/15 text-sky-200"
          : "border-neutral-800 text-neutral-500 hover:border-neutral-600"
      }`}
    >
      {label}
    </button>
  );
}

function Loader() {
  const status = useSegment((state) => state.status);
  const plan = useSegment((state) => state.plan);
  const textPlan = useSegment((state) => state.textPlan);
  const progress = useSegment((state) => state.progress);
  const persisted = useSegment((state) => state.persisted);
  const load = useSegment((state) => state.loadModel);
  const cancel = useSegment((state) => state.cancelLoad);

  if (status === "probing") return <p className="text-[11px] text-neutral-500">Checking WebGPU…</p>;

  if (status === "unsupported") {
    return (
      <p className="text-[11px] text-neutral-500">
        Segmentation needs WebGPU. Chrome, Edge, Safari 26 and Firefox 147 have it.
      </p>
    );
  }

  if (!plan) return null;

  if (status === "loading") {
    const done = formatBytes(progress.loaded);
    const total = progress.total > 0 ? formatBytes(progress.total) : "…";
    return (
      <div className="space-y-1.5">
        <Bar fraction={progress.fraction} />
        <p className="flex justify-between font-mono text-[10px] text-neutral-500">
          <span>{progress.phase}</span>
          <span>
            {done} / {total}
          </span>
        </p>
        <button
          type="button"
          onClick={cancel}
          className="w-full rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600"
        >
          Stop
        </button>
        <p className="text-[10px] text-neutral-600">Stopping starts the download again later.</p>
      </div>
    );
  }

  if (status === "ready") {
    return (
      <p className="font-mono text-[10px] text-neutral-500">
        {plan.backend} · {plan.label}
        {persisted ? " · kept on this device" : ""}
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => void load()}
        className="w-full rounded border border-neutral-700 px-2 py-1.5 text-[11px] transition-colors hover:border-neutral-500"
      >
        Load model · {downloadSize(plan, textPlan)}
      </button>
      <p className="text-[10px] text-neutral-600">
        {plan.label} on {plan.backend}. The download stays on this device.
        {plan.reduced ? " This machine gets the smaller model." : ""}
      </p>
    </div>
  );
}

function TextPrompt() {
  const textReady = useSegment((state) => state.textReady);
  const busy = useSegment((state) => state.busy);
  const promptText = useSegment((state) => state.promptText);
  const draft = useSegment((state) => state.draft);
  const [text, setText] = useState("");
  const plane = draft?.plane ?? "axial";

  return (
    <div className="space-y-1.5">
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          void promptText(plane, text);
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="what to find"
          disabled={!textReady || busy}
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-transparent px-1.5 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-sky-400/60 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!textReady || busy || text.trim().length === 0}
          className="rounded border border-neutral-800 px-2 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 disabled:opacity-40"
        >
          Find
        </button>
      </form>
      <p className="text-[10px] text-neutral-600">
        Text search is unreliable on MRI: open-vocabulary models score about 12% Dice on unseen
        medical images. Use a box for anything you will act on.
      </p>
    </div>
  );
}

function DraftActions() {
  const draft = useSegment((state) => state.draft);
  const keep = useSegment((state) => state.keepDraft);
  const clear = useSegment((state) => state.clearDraft);
  if (!draft?.mask) return null;

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-1">
        <button
          type="button"
          onClick={keep}
          className="rounded border border-sky-400/60 bg-sky-400/15 px-1 py-1 text-[10px] text-sky-200"
        >
          Keep
        </button>
        <button
          type="button"
          onClick={clear}
          className="rounded border border-neutral-800 px-1 py-1 text-[10px] text-neutral-500 transition-colors hover:border-neutral-600"
        >
          Discard
        </button>
      </div>
      <p className="font-mono text-[10px] text-neutral-600">
        draft · score {draft.score.toFixed(2)}
      </p>
    </div>
  );
}

function Row({ segment }: { segment: Segment }) {
  const hidden = useSegment((state) => state.hidden.includes(segment.id));
  const toggle = useSegment((state) => state.toggleVisible);
  const remove = useSegment((state) => state.remove);
  const size = segmentVolume(segment);

  return (
    <li className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-neutral-800/60">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-sm"
        style={{ backgroundColor: segment.colour, opacity: hidden ? 0.3 : 1 }}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[11px] ${hidden ? "text-neutral-600" : "text-neutral-300"}`}
      >
        {segment.label}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-neutral-500">
        {size < 1000 ? size.toFixed(0) : (size / 1000).toFixed(1) + "k"} mm³
      </span>
      <button
        type="button"
        title={hidden ? "Show" : "Hide"}
        onClick={() => toggle(segment.id)}
        className="shrink-0 px-0.5 text-[10px] text-neutral-500 hover:text-neutral-300"
      >
        {hidden ? "○" : "●"}
      </button>
      <button
        type="button"
        title="Delete"
        onClick={() => remove(segment.id)}
        className="shrink-0 px-0.5 text-[10px] text-neutral-500 hover:text-red-300"
      >
        ×
      </button>
    </li>
  );
}

export default function SegmentPanel() {
  const probe = useSegment((state) => state.probe);
  const status = useSegment((state) => state.status);
  const busy = useSegment((state) => state.busy);
  const error = useSegment((state) => state.error);
  const note = useSegment((state) => state.note);
  const segments = useSegment((state) => state.segments);

  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <div className="space-y-3">
      <Loader />

      {status === "ready" && (
        <>
          <div>
            <p className="mb-1.5 text-[11px] text-neutral-400">Prompt with</p>
            <div className="grid grid-cols-2 gap-1">
              <ModeButton id="box" label="Box" hint="Drag a rectangle around the structure" />
              <ModeButton id="click" label="Click" hint="Click inside. Alt-click to exclude." />
            </div>
            <p className="mt-1 text-[10px] text-neutral-600">
              A box beats a click on MR. Every result is a draft for a human to check.
            </p>
          </div>
          <TextPrompt />
          <DraftActions />
        </>
      )}

      {busy && <p className="text-[10px] text-sky-300/70">Working…</p>}
      {note && <p className="text-[10px] text-neutral-500">{note}</p>}
      {error && <p className="text-[10px] text-red-300">{error}</p>}

      {segments.length > 0 && (
        <ul className="space-y-0.5">
          {segments.map((segment) => (
            <Row key={segment.id} segment={segment} />
          ))}
        </ul>
      )}
    </div>
  );
}
