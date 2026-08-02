import { useCallback, useEffect, useState } from "react";
import {
  nextStep,
  parseSaved,
  previousStep,
  progress,
  serialize,
  skip,
  stepAt,
  TUTORIAL_START,
  TUTORIAL_STEPS,
  type TutorialState,
  type TutorialTarget,
} from "../core/tutorial/steps.ts";

const STORAGE_KEY = "dicom-viewer.tutorial";

/** Where each step's card sits, and which part of the screen it points at. */
const PLACEMENT: Record<TutorialTarget, string> = {
  screen: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
  series: "left-[17rem] top-24",
  display: "left-[17rem] bottom-24",
  cuts: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
  volume: "right-8 bottom-24",
  cube: "right-8 top-1/2",
};

/** A soft ring over the part of the screen that the step talks about. */
const SPOTLIGHT: Partial<Record<TutorialTarget, string>> = {
  series: "left-2 top-16 h-44 w-60",
  display: "left-2 bottom-4 h-72 w-60",
  volume: "right-0 bottom-0 h-1/2 w-1/2",
  cube: "right-3 top-[52%] h-36 w-36",
};

function read(): TutorialState {
  if (typeof localStorage === "undefined") return TUTORIAL_START;
  try {
    return parseSaved(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private browsing can refuse storage. The tutorial still runs.
    return TUTORIAL_START;
  }
}

function write(state: TutorialState): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch {
    // Nothing to do. Losing the tutorial position is not worth an error.
  }
}

/** Clear the saved position, so the tutorial runs again. */
export function forgetTutorial(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignored, as above.
  }
}

export function useTutorial() {
  const [state, setState] = useState<TutorialState>(TUTORIAL_START);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setState(read());
    setLoaded(true);
  }, []);

  const update = useCallback((next: TutorialState) => {
    setState(next);
    write(next);
  }, []);

  const restart = useCallback(() => {
    forgetTutorial();
    setState(TUTORIAL_START);
  }, []);

  return { state, loaded, update, restart };
}

export function Tutorial({
  state,
  onChange,
}: {
  state: TutorialState;
  onChange: (next: TutorialState) => void;
}) {
  const step = stepAt(state);
  const { current, total } = progress(state);
  const spotlight = SPOTLIGHT[step.target];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onChange(skip());
      if (event.key === "ArrowRight" || event.key === "Enter") onChange(nextStep(state));
      if (event.key === "ArrowLeft") onChange(previousStep(state));
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [state, onChange]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px]" />

      {spotlight && (
        <div
          className={`pointer-events-none absolute rounded-lg ring-2 ring-sky-400/70 ${spotlight}`}
          style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)" }}
        />
      )}

      <div
        role="dialog"
        aria-label="Getting started"
        className={`absolute w-80 rounded-lg border border-neutral-700 bg-[#0e1015] p-4 shadow-2xl ${
          PLACEMENT[step.target]
        }`}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-widest text-sky-400/80">
            {current} of {total}
          </span>
          <button
            type="button"
            onClick={() => onChange(skip())}
            className="text-[11px] text-neutral-500 transition-colors hover:text-neutral-300"
          >
            Skip
          </button>
        </div>

        <h2 className="text-sm font-semibold tracking-tight text-neutral-100">{step.title}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-400">{step.body}</p>

        <div className="mt-4 flex items-center gap-2">
          <div className="flex flex-1 gap-1">
            {TUTORIAL_STEPS.map((entry, index) => (
              <span
                key={entry.id}
                className={`h-0.5 flex-1 rounded transition-colors ${
                  index <= state.step ? "bg-sky-400" : "bg-neutral-800"
                }`}
              />
            ))}
          </div>
          {state.step > 0 && (
            <button
              type="button"
              onClick={() => onChange(previousStep(state))}
              className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:border-neutral-500"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => onChange(nextStep(state))}
            className="rounded bg-sky-500 px-3 py-1 text-[11px] font-medium text-neutral-950 transition-colors hover:bg-sky-400"
          >
            {current === total ? "Start" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
