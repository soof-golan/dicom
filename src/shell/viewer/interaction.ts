/**
 * What a pointer gesture means.
 *
 * The mapping lives here, apart from the event plumbing, so it can be read in
 * one place and shown to the user in the same words.
 */

export type Gesture = "crosshair" | "pan" | "window" | "orbit";

export interface Buttons {
  readonly button: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

const MIDDLE = 1;
const RIGHT = 2;

/**
 * Pick the gesture for a press.
 *
 * The right button and Shift both mean window and level, because a laptop
 * trackpad makes a right press awkward. The middle button and Alt both mean
 * pan, for the same reason.
 */
export function gestureFor(event: Buttons, pane: "cut" | "volume"): Gesture {
  if (event.button === RIGHT || event.shiftKey) return "window";
  if (event.button === MIDDLE || event.altKey) return "pan";
  return pane === "volume" ? "orbit" : "crosshair";
}

export const GESTURE_HELP: readonly { readonly keys: string; readonly meaning: string }[] = [
  { keys: "Drag in a cut", meaning: "Move the crosshair. The other two cuts follow." },
  { keys: "Drag in the 3D view", meaning: "Turn the camera." },
  { keys: "Wheel", meaning: "Step through the slices. In 3D, move closer or further." },
  { keys: "Shift or right button", meaning: "Change brightness and contrast." },
  { keys: "Alt or middle button", meaning: "Move the image inside its frame." },
];
