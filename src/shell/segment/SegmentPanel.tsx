/**
 * The Segment panel in the left sidebar.
 *
 * Everything is behind a gesture. The panel probes the machine when it opens,
 * states the real download size, and downloads nothing until the user asks.
 *
 * The list is the record of the session. Every click the user placed is
 * counted here, on the cut it was placed on, so nothing a user told the model
 * can hide off screen.
 */
import { useEffect, useMemo, useState } from "react";
import { formatBytes } from "../../core/segment/plan.ts";
import { stopMessage } from "../../core/segment/propagate.ts";
import {
  canUndo,
  cutCounts,
  promptCount,
  type PromptCut,
  type SegmentObject,
} from "../../core/segment/session.ts";
import { downloadSize, objectVolume, useSegment, type PromptMode } from "./store.ts";

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
  const [text, setText] = useState("");

  return (
    <div className="space-y-1.5">
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          void promptText("axial", text);
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

/**
 * The walk through the slices, and how it went.
 *
 * The button is separate from the click on purpose. One walk reads up to 64
 * slices through the vision encoder, and that must never be the price of a
 * click that the user is still refining.
 */
function GrowControl() {
  const growing = useSegment((state) => state.growing);
  const grow = useSegment((state) => state.grow);
  const stopGrowing = useSegment((state) => state.stopGrowing);
  const session = useSegment((state) => state.session);
  const object = session.objects.find((entry) => entry.id === session.activeId);
  const growth = object?.growth;

  if (growing) {
    const reach = (growing.done * growing.millimetresPerSlice).toFixed(0);
    return (
      <div className="space-y-1">
        <Bar fraction={Math.min(growing.done / growing.total, 1)} />
        <p className="flex justify-between font-mono text-[10px] text-neutral-500">
          <span>growing</span>
          <span>
            {growing.done} slices · {reach} mm
          </span>
        </p>
        <button
          type="button"
          onClick={stopGrowing}
          className="w-full rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600"
        >
          Stop
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={grow}
        disabled={!object}
        className="w-full rounded border border-neutral-700 px-2 py-1.5 text-[11px] transition-colors hover:border-neutral-500 disabled:opacity-40"
      >
        Grow through slices
      </button>
      {growth ? (
        <div className="space-y-0.5 text-[10px] text-neutral-500">
          <p className="font-mono">
            {growth.kept} slices grown · {growth.reachMillimetres.toFixed(0)} mm on {growth.plane}
          </p>
          <p>Up: {stopMessage(growth.up)}</p>
          <p>Down: {stopMessage(growth.down)}</p>
        </div>
      ) : (
        <p className="text-[10px] text-neutral-600">
          The walk starts at the last slice you clicked and steps out on both sides. It stops on its
          own, and the panel says why. Combine the three series first: the walk needs slices that
          look alike, and the native step is 3.3 mm against 0.27 mm pixels.
        </p>
      )}
    </div>
  );
}

/** One cut of one object, so the user can return to the slice they clicked on. */
function CutRow({ objectId, cut }: { objectId: string; cut: PromptCut }) {
  const goTo = useSegment((state) => state.goToCut);
  const clear = useSegment((state) => state.clearCut);
  const marks = cut.points.length + (cut.box ? 1 : 0);

  return (
    <li className="flex items-center gap-1 pl-4 text-[10px] text-neutral-500">
      <button
        type="button"
        title="Go to this slice"
        onClick={() => goTo(objectId, cut.key)}
        className="min-w-0 flex-1 truncate text-left font-mono hover:text-neutral-300"
      >
        {cut.plane} {cut.depth.toFixed(1)} mm · {marks} {marks === 1 ? "prompt" : "prompts"}
        {cut.part ? "" : " · waiting"}
      </button>
      <button
        type="button"
        title="Remove the prompts on this slice"
        onClick={() => clear(objectId, cut.key)}
        className="shrink-0 px-0.5 hover:text-red-300"
      >
        ×
      </button>
    </li>
  );
}

function ObjectRow({ object, active }: { object: SegmentObject; active: boolean }) {
  const select = useSegment((state) => state.selectObject);
  const rename = useSegment((state) => state.renameObject);
  const toggle = useSegment((state) => state.toggleVisible);
  const remove = useSegment((state) => state.removeObject);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(object.label);

  // Measuring an object walks every mask pixel, so it runs only on a change.
  const size = useMemo(() => objectVolume(object), [object]);
  const counts = cutCounts(object);

  const stopEditing = (keep: boolean): void => {
    if (keep) rename(object.id, draft);
    setEditing(false);
  };

  return (
    <li
      className={`rounded border px-1 py-1 ${
        active ? "border-sky-400/40 bg-sky-400/5" : "border-transparent"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-sm"
          style={{ backgroundColor: object.colour, opacity: object.hidden ? 0.3 : 1 }}
        />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => stopEditing(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") stopEditing(true);
              if (event.key === "Escape") stopEditing(false);
            }}
            className="min-w-0 flex-1 rounded border border-sky-400/60 bg-transparent px-1 text-[11px] text-neutral-100 focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => select(object.id)}
            onDoubleClick={() => {
              setDraft(object.label);
              setEditing(true);
            }}
            title="Select. Double click to rename."
            className={`min-w-0 flex-1 truncate text-left text-[11px] ${
              object.hidden ? "text-neutral-600" : active ? "text-sky-200" : "text-neutral-300"
            }`}
          >
            {object.label}
          </button>
        )}
        <span className="shrink-0 font-mono text-[10px] text-neutral-500">
          {size < 1000 ? size.toFixed(0) : (size / 1000).toFixed(1) + "k"} mm³
        </span>
        <button
          type="button"
          title={object.hidden ? "Show" : "Hide"}
          onClick={() => toggle(object.id)}
          className="shrink-0 px-0.5 text-[10px] text-neutral-500 hover:text-neutral-300"
        >
          {object.hidden ? "○" : "●"}
        </button>
        <button
          type="button"
          title="Delete"
          onClick={() => remove(object.id)}
          className="shrink-0 px-0.5 text-[10px] text-neutral-500 hover:text-red-300"
        >
          ×
        </button>
      </div>
      {active && object.cuts.length > 0 && (
        <>
          <ul className="mt-0.5 space-y-0.5">
            {object.cuts
              .filter((cut) => cut.origin === "user")
              .map((cut) => (
                <CutRow key={cut.key} objectId={object.id} cut={cut} />
              ))}
          </ul>
          <p className="pl-4 text-[10px] text-neutral-600">
            {counts.user} {counts.user === 1 ? "slice" : "slices"} you clicked · {counts.grown} the
            model inferred
          </p>
        </>
      )}
    </li>
  );
}

export default function SegmentPanel() {
  const probe = useSegment((state) => state.probe);
  const status = useSegment((state) => state.status);
  const busy = useSegment((state) => state.busy);
  const error = useSegment((state) => state.error);
  const note = useSegment((state) => state.note);
  const session = useSegment((state) => state.session);
  const polarity = useSegment((state) => state.polarity);
  const setPolarity = useSegment((state) => state.setPolarity);
  const newObject = useSegment((state) => state.newObject);
  const stepBack = useSegment((state) => state.undo);

  useEffect(() => {
    void probe();
  }, [probe]);

  const total = session.objects.reduce((count, object) => count + promptCount(object), 0);

  return (
    <div className="space-y-3">
      <Loader />

      {status === "ready" && (
        <>
          <div>
            <p className="mb-1.5 text-[11px] text-neutral-400">Prompt with</p>
            <div className="grid grid-cols-2 gap-1">
              <ModeButton id="click" label="Click" hint="Click inside. Alt-click to exclude." />
              <ModeButton id="box" label="Box" hint="Drag a rectangle around the structure" />
            </div>
            <div className="mt-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setPolarity("positive")}
                className={`rounded border px-1 py-1 text-[10px] transition-colors ${
                  polarity === "positive"
                    ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-200"
                    : "border-neutral-800 text-neutral-500 hover:border-neutral-600"
                }`}
              >
                Include
              </button>
              <button
                type="button"
                onClick={() => setPolarity("negative")}
                className={`rounded border px-1 py-1 text-[10px] transition-colors ${
                  polarity === "negative"
                    ? "border-rose-400/60 bg-rose-400/10 text-rose-200"
                    : "border-neutral-800 text-neutral-500 hover:border-neutral-600"
                }`}
              >
                Exclude
              </button>
            </div>
            <p className="mt-1 text-[10px] text-neutral-600">
              Clicks stay where you put them in the patient. Scroll to another slice or use another
              pane, and keep clicking to grow the same object. Every result is a draft for a human
              to check.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={newObject}
              className="rounded border border-neutral-700 px-1 py-1 text-[10px] text-neutral-300 transition-colors hover:border-neutral-500"
            >
              New object
            </button>
            <button
              type="button"
              onClick={stepBack}
              disabled={!canUndo(session)}
              className="rounded border border-neutral-800 px-1 py-1 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 disabled:opacity-40"
            >
              Undo
            </button>
          </div>

          <GrowControl />
          <TextPrompt />
        </>
      )}

      {busy && <p className="text-[10px] text-sky-300/70">Working…</p>}
      {note && <p className="text-[10px] text-neutral-500">{note}</p>}
      {error && <p className="text-[10px] text-red-300">{error}</p>}

      {session.objects.length > 0 && (
        <div className="space-y-1">
          <ul className="space-y-0.5">
            {session.objects.map((object) => (
              <ObjectRow key={object.id} object={object} active={object.id === session.activeId} />
            ))}
          </ul>
          <p className="text-[10px] text-neutral-600">
            {session.objects.length} {session.objects.length === 1 ? "object" : "objects"} · {total}{" "}
            {total === 1 ? "prompt" : "prompts"}. Where two objects meet, the lower one in this list
            covers the one above it.
          </p>
        </div>
      )}
    </div>
  );
}
