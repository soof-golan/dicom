/**
 * The first-visit tutorial.
 *
 * The steps are data, not components, so the order and the wording can be
 * tested and translated without touching the interface.
 *
 * Each step names the part of the screen it talks about. The shell turns that
 * name into a position. A step that names no target is shown in the middle.
 */

export type TutorialTarget = "screen" | "series" | "display" | "cuts" | "volume" | "cube";

export interface TutorialStep {
  readonly id: string;
  readonly title: string;
  /** One or two short sentences. A reader must finish a step in five seconds. */
  readonly body: string;
  readonly target: TutorialTarget;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "welcome",
    title: "Your scan stays on this device",
    body: "This viewer has no server. It reads your files in the browser, and it sends nothing anywhere.",
    target: "screen",
  },
  {
    id: "series",
    title: "Pick a series",
    body: "One scan holds several series. Each one is a separate set of images, taken with different settings.",
    target: "series",
  },
  {
    id: "cuts",
    title: "Three cuts, one point",
    body: "Drag in any cut to move the crosshair. The other two cuts jump to the same point in the body.",
    target: "cuts",
  },
  {
    id: "scroll",
    title: "Step through the slices",
    body: "Turn the wheel over a cut to move through the scan. Hold Shift and drag to change brightness and contrast.",
    target: "cuts",
  },
  {
    id: "volume",
    title: "The 3D view",
    body: "Drag to turn the volume. Turn the wheel to move closer. The 3D density and threshold sliders decide what you see through.",
    target: "volume",
  },
  {
    id: "cube",
    title: "The view cube",
    body: "Click a face, an edge, or a corner of the cube to jump to that view. The letters name directions in the body.",
    target: "cube",
  },
  {
    id: "colour",
    title: "Color the tissue",
    body: "The tissue color slider maps signal strength to color. It is a guide to the image, not a diagnosis.",
    target: "display",
  },
];

export interface TutorialState {
  /** Index of the step on screen. */
  readonly step: number;
  readonly finished: boolean;
}

export const TUTORIAL_START: TutorialState = { step: 0, finished: false };

export function nextStep(state: TutorialState): TutorialState {
  const next = state.step + 1;
  if (next >= TUTORIAL_STEPS.length) return { step: TUTORIAL_STEPS.length - 1, finished: true };
  return { step: next, finished: false };
}

export function previousStep(state: TutorialState): TutorialState {
  return { step: Math.max(0, state.step - 1), finished: state.finished };
}

export function skip(): TutorialState {
  return { step: TUTORIAL_STEPS.length - 1, finished: true };
}

export function stepAt(state: TutorialState): TutorialStep {
  const index = Math.min(Math.max(state.step, 0), TUTORIAL_STEPS.length - 1);
  return TUTORIAL_STEPS[index]!;
}

export function progress(state: TutorialState): { current: number; total: number } {
  return { current: state.step + 1, total: TUTORIAL_STEPS.length };
}

/**
 * Read the saved state.
 *
 * Anything unreadable counts as a first visit. A corrupt value in
 * `localStorage` must never stop the viewer from starting.
 */
export function parseSaved(raw: string | null): TutorialState {
  if (raw === null) return TUTORIAL_START;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return TUTORIAL_START;
    const record = value as Record<string, unknown>;
    return {
      step: typeof record.step === "number" && Number.isFinite(record.step) ? record.step : 0,
      finished: record.finished === true,
    };
  } catch {
    return TUTORIAL_START;
  }
}

export function serialize(state: TutorialState): string {
  return JSON.stringify(state);
}
