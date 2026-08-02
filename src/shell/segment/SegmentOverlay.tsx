/**
 * Prompts and masks drawn over the cuts.
 *
 * The overlay sits on top of the renderer canvas and uses the same 2x2 layout,
 * so a pane pixel here is the same pane pixel there. It takes pointer events
 * only while a prompt mode is on. At every other time it lets them through and
 * the viewer behaves exactly as before.
 *
 * Nothing here decides what belongs on a cut. The core answers that from the
 * patient coordinates of each prompt, and this file only draws the answer.
 */
import { useEffect, useRef, useState } from "react";
import type { Vec3 } from "../../core/geometry/vec3.ts";
import { decodeRle } from "../../core/segment/mask.ts";
import { toBytes } from "../../core/segment/palette.ts";
import {
  framePixelToPatient,
  paneFrame,
  patientToFramePixel,
  resampleMask,
} from "../../core/segment/project.ts";
import { boxMarks, promptMarks, visibleParts, type CutOrigin } from "../../core/segment/session.ts";
import { depthOf, sliceThickness } from "../../core/segment/slice.ts";
import type { Mask, MaskFrame } from "../../core/segment/types.ts";
import { standardPlane, type PlaneId } from "../../core/view/planes.ts";
import { activeSeries, useStudy } from "../store.ts";
import { layout, type Pane } from "../viewer/ViewerCanvas.tsx";
import { useSegment } from "./store.ts";

/** How solid the inside of a mask is. The edge is always solid. */
const FILL_ALPHA = 80;

interface Band {
  readonly pane: Pane;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
}

/**
 * Paint one mask into the image, tinted inside and drawn on the edge.
 *
 * A slice the user clicked gets a solid edge. A slice a walk inferred gets a
 * broken edge and a fainter fill, so the two claims never look the same.
 */
function paint(image: ImageData, mask: Mask, pane: Pane, colour: string, origin: CutOrigin): void {
  const [red, green, blue] = toBytes(colour);
  const set = (index: number): boolean => mask.data[index] !== 0;
  const grown = origin === "grown";
  const fill = grown ? Math.round(FILL_ALPHA * 0.55) : FILL_ALPHA;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x;
      if (!set(index)) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === mask.width - 1 ||
        y === mask.height - 1 ||
        !set(index - 1) ||
        !set(index + 1) ||
        !set(index - mask.width) ||
        !set(index + mask.width);
      // The broken edge is a dash of three pixels on and three off.
      const drawn = edge && (!grown || (x + y) % 6 < 3);

      const target = ((pane.view.y + y) * image.width + pane.view.x + x) * 4;
      image.data[target] = red;
      image.data[target + 1] = green;
      image.data[target + 2] = blue;
      image.data[target + 3] = drawn ? 255 : fill;
    }
  }
}

function rgba(colour: string, alpha: number): string {
  const [red, green, blue] = toBytes(colour);
  return `rgba(${red},${green},${blue},${alpha.toFixed(3)})`;
}

export default function SegmentOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<Band | undefined>(undefined);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [, redraw] = useState(0);

  const series = useStudy(activeSeries);
  const view = useStudy((state) => state.view);
  const status = useSegment((state) => state.status);
  const mode = useSegment((state) => state.mode);
  const polarity = useSegment((state) => state.polarity);
  const session = useSegment((state) => state.session);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: host.clientWidth, height: host.clientHeight });
    });
    observer.observe(host);
    setSize({ width: host.clientWidth, height: host.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !series || size.width === 0 || size.height === 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = size.width;
    canvas.height = size.height;
    context.clearRect(0, 0, size.width, size.height);

    // The viewer nudges its own store on every pointer move, so this effect
    // runs often. With nothing to draw it must cost nothing.
    if (session.objects.length === 0 && !bandRef.current) return;

    const panes = layout(size.width, size.height).filter(
      (pane): pane is Pane & { id: PlaneId } =>
        pane.id !== "volume" && pane.view.width > 0 && pane.view.height > 0,
    );

    /** The cut a pane shows now, and the frame that covers that pane. */
    const setUp = (pane: Pane & { id: PlaneId }) => {
      const plane = standardPlane(series.volume, pane.id, view.cursor, view.pan[pane.id]);
      return {
        id: pane.id,
        frame: paneFrame(plane, pane.view.width, pane.view.height, view.paneZoom),
        depth: depthOf(series.volume, pane.id, plane.origin),
        thickness: sliceThickness(series.volume, pane.id),
      };
    };

    const image = context.createImageData(size.width, size.height);
    for (const pane of panes) {
      const cut = setUp(pane);
      // The core returns the masks in creation order, so a newer object paints
      // over an older one where the two overlap.
      for (const entry of visibleParts(session, cut.id, cut.depth, cut.thickness)) {
        paint(
          image,
          resampleMask(decodeRle(entry.part.mask), entry.part.frame, cut.frame),
          pane,
          entry.colour,
          entry.origin,
        );
      }
    }
    context.putImageData(image, 0, 0);

    // Prompt marks and the rubber band go on top, in plain canvas drawing.
    for (const pane of panes) {
      const cut = setUp(pane);
      const toPane = (patient: Vec3): [number, number] => {
        const at = patientToFramePixel(cut.frame, patient);
        return [pane.view.x + at.x + 0.5, pane.view.y + at.y + 0.5];
      };

      for (const mark of boxMarks(session, cut.id, cut.depth, cut.thickness)) {
        const [x0, y0] = toPane(mark.box.start);
        const [x1, y1] = toPane(mark.box.end);
        context.lineWidth = mark.active ? 1.5 : 1;
        context.strokeStyle = rgba(mark.colour, mark.opacity);
        context.strokeRect(
          Math.min(x0, x1),
          Math.min(y0, y1),
          Math.abs(x1 - x0),
          Math.abs(y1 - y0),
        );
      }

      for (const mark of promptMarks(session, cut.id, cut.depth, cut.thickness)) {
        const [x, y] = toPane(mark.patient);
        context.beginPath();
        context.arc(x, y, mark.active ? 4.5 : 3.5, 0, Math.PI * 2);
        context.fillStyle = rgba(mark.colour, mark.opacity);
        context.fill();
        context.lineWidth = 1.5;
        context.strokeStyle = `rgba(0,0,0,${(0.7 * mark.opacity).toFixed(3)})`;
        context.stroke();
        // A negative click wears a bar across it, so the two kinds never read
        // the same at a glance, and colour alone never carries the meaning.
        if (!mark.positive) {
          context.beginPath();
          context.moveTo(x - 2.5, y);
          context.lineTo(x + 2.5, y);
          context.strokeStyle = `rgba(255,255,255,${(0.95 * mark.opacity).toFixed(3)})`;
          context.stroke();
        }
      }
    }

    const band = bandRef.current;
    if (band) {
      context.lineWidth = 1.5;
      context.strokeStyle = "rgba(255,255,255,0.9)";
      context.setLineDash([4, 3]);
      context.strokeRect(
        band.pane.view.x + Math.min(band.startX, band.x),
        band.pane.view.y + Math.min(band.startY, band.y),
        Math.abs(band.x - band.startX),
        Math.abs(band.y - band.startY),
      );
      context.setLineDash([]);
    }
  }, [series, view, session, size]);

  const active = status === "ready" && mode !== "off";

  /** The pane under a pointer, and the point in the patient that it names. */
  const hit = (
    event: React.PointerEvent<HTMLDivElement>,
  ): { pane: Pane; plane: PlaneId; patient: Vec3; localX: number; localY: number } | undefined => {
    const host = hostRef.current;
    if (!host || !series) return undefined;
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const pane = layout(size.width, size.height).find(
      (entry) =>
        entry.id !== "volume" &&
        x >= entry.view.x &&
        x < entry.view.x + entry.view.width &&
        y >= entry.view.y &&
        y < entry.view.y + entry.view.height,
    );
    if (!pane || pane.id === "volume") return undefined;
    const plane = standardPlane(series.volume, pane.id, view.cursor, view.pan[pane.id]);
    const frame: MaskFrame = paneFrame(plane, pane.view.width, pane.view.height, view.paneZoom);
    const localX = x - pane.view.x;
    const localY = y - pane.view.y;
    return {
      pane,
      plane: pane.id,
      patient: framePixelToPatient(frame, localX - 0.5, localY - 0.5),
      localX,
      localY,
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const found = hit(event);
    if (!found) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (mode === "click") {
      // The panel sets what a plain click means. Alt gives the other one, so a
      // refinement never needs a trip back to the panel.
      const wanted = polarity === "positive";
      useSegment.getState().addPoint(found.plane, found.patient, event.altKey ? !wanted : wanted);
      return;
    }
    bandRef.current = {
      pane: found.pane,
      startX: found.localX,
      startY: found.localY,
      x: found.localX,
      y: found.localY,
    };
  };

  /** Where a pointer sits inside the pane that the drag started in. */
  const trackBand = (band: Band, event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    band.x = event.clientX - rect.left - band.pane.view.x;
    band.y = event.clientY - rect.top - band.pane.view.y;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const band = bandRef.current;
    if (!band) return;
    trackBand(band, event);
    redraw((tick) => tick + 1);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const band = bandRef.current;
    bandRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!band || !series || band.pane.id === "volume") return;
    // Read the end from this event, not from the last move. A fast drag can
    // release without a single move in between, and that box would be empty.
    trackBand(band, event);
    redraw((tick) => tick + 1);
    if (Math.abs(band.x - band.startX) < 3 || Math.abs(band.y - band.startY) < 3) return;

    const plane = standardPlane(series.volume, band.pane.id, view.cursor, view.pan[band.pane.id]);
    const frame = paneFrame(plane, band.pane.view.width, band.pane.view.height, view.paneZoom);
    useSegment
      .getState()
      .setBox(
        band.pane.id,
        framePixelToPatient(frame, band.startX - 0.5, band.startY - 0.5),
        framePixelToPatient(frame, band.x - 0.5, band.y - 0.5),
      );
  };

  return (
    <div
      ref={hostRef}
      className={`absolute inset-0 ${active ? "cursor-crosshair" : "pointer-events-none"}`}
      onPointerDown={active ? onPointerDown : undefined}
      onPointerMove={active && mode === "box" ? onPointerMove : undefined}
      onPointerUp={active ? onPointerUp : undefined}
      onPointerCancel={active ? onPointerUp : undefined}
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="pointer-events-none h-full w-full" />
    </div>
  );
}
