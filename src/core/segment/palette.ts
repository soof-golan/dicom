/**
 * Colours for segments.
 *
 * Three rules decide the set. Each colour must stay legible on the near-black
 * page. Each colour must stay apart from the others. And each colour must stay
 * away from the tissue ramp, because a segment that looks like fat or fluid
 * tells the reader the wrong thing.
 *
 * The distances use OKLab, which spaces colours the way an eye does. RGB does
 * not: two colours far apart in RGB can look the same.
 */

/** The page behind every pane. */
export const BACKGROUND = "#07080b";

/**
 * The tissue ramp that the volume shader draws.
 *
 * These are the same five anchors as `tissueColor` in
 * `src/shell/viewer/shaders.ts`, plus the crosshair blue. A test keeps every
 * segment colour away from all of them.
 */
export const RESERVED_COLOURS: readonly string[] = [
  "#0d0f17", // background of the ramp
  "#4a5470", // cortical bone, tendon
  "#9e4d4a", // muscle
  "#eed6a1", // fat and marrow
  "#6bd9ff", // fluid, edema
  "#fcfaeb", // free fluid
  "#6bc7ff", // the crosshair
];

/** The colours a segment can take, in the order they are given out. */
export const SEGMENT_COLOURS: readonly string[] = [
  "#ff4fd8", // magenta
  "#4ef07a", // green
  "#a06bff", // violet
  "#ff8a1f", // orange
  "#ff5c72", // coral
  "#c8f53a", // lime
  "#ff9ecb", // pink
];

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Convert a hex colour to OKLab, where distance matches what an eye sees. */
export function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** How far apart two colours look. Above 0.1 reads as a different colour. */
export function colourDistance(a: string, b: string): number {
  const [x, y, z] = toOklab(a);
  const [p, q, r] = toOklab(b);
  return Math.hypot(x - p, y - q, z - r);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio, from 1 to 21. Text needs 4.5 or more. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

/** The colour at a position in the list. The list repeats after the last one. */
export function colourAt(index: number): string {
  const count = SEGMENT_COLOURS.length;
  const wrapped = ((index % count) + count) % count;
  return SEGMENT_COLOURS[wrapped]!;
}

/**
 * The next colour to give out.
 *
 * A colour that nobody uses wins. When every colour is taken, the one used
 * least often wins, so a long list still spreads out.
 */
export function nextColour(used: readonly string[]): string {
  const counts = new Map<string, number>(SEGMENT_COLOURS.map((colour) => [colour, 0]));
  for (const colour of used) {
    const seen = counts.get(colour);
    if (seen !== undefined) counts.set(colour, seen + 1);
  }
  let best = SEGMENT_COLOURS[0]!;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const colour of SEGMENT_COLOURS) {
    const count = counts.get(colour)!;
    if (count < bestCount) {
      best = colour;
      bestCount = count;
    }
  }
  return best;
}

/** The three 0-to-255 channels of a colour, for drawing into image data. */
export function toBytes(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
