/**
 * Prompts and masks drawn over the cuts.
 *
 * The overlay sits on top of the renderer canvas and uses the same 2x2 layout,
 * so a pane pixel here is the same pane pixel there. It takes pointer events
 * only while a prompt mode is on. At every other time it lets them through and
 * the viewer behaves exactly as before.
 */
import { useEffect, useRef, useState } from "react";
import type { Vec3 } from "../../core/geometry/vec3.ts";
import { decodeRle } from "../../core/segment/mask.ts";
import { toBytes } from "../../core/segment/palette.ts";
import {
  frameNormal,
  framePixelToPatient,
  paneFrame,
  patientToFramePixel,
  resampleMask,
  voxelExtentAlong,
} from "../../core/segment/project.ts";
import type { Mask, MaskFrame } from "../../core/segment/types.ts";
import { standardPlane, type PlaneId } from "../../core/view/planes.ts";
import { activeSeries, useStudy } from "../store.ts";
import { layout, type Pane } from "../viewer/ViewerCanvas.tsx";
import { useSegment } from "./store.ts";

const DRAFT_COLOUR = "#ffffff";

interface Band {
  readonly pane: Pane;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
}

/** Paint one mask into the image, tinted inside and solid on the edge. */
function paint(image: ImageData, mask: Mask, pane: Pane, colour: string, fillAlpha: number): void {
  const [red, green, blue] = toBytes(colour);
  const set = (index: number): boolean => mask.data[index] !== 0;

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

      const target = ((pane.view.y + y) * image.width + pane.view.x + x) * 4;
      image.data[target] = red;
      image.data[target + 1] = green;
      image.data[target + 2] = blue;
      image.data[target + 3] = edge ? 255 : fillAlpha;
    }
  }
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
  const segments = useSegment((state) => state.segments);
  const hidden = useSegment((state) => state.hidden);
  const draft = useSegment((state) => state.draft);

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
    const image = context.createImageData(size.width, size.height);
    const panes = layout(size.width, size.height);

    for (const pane of panes) {
      if (pane.id === "volume" || pane.view.width <= 0 || pane.view.height <= 0) continue;
      const plane = standardPlane(series.volume, pane.id, view.cursor, view.pan[pane.id]);
      const target = paneFrame(plane, pane.view.width, pane.view.height, view.paneZoom);

      /** A mask only belongs on a cut that runs through the slice it was made on. */
      const onThisCut = (frame: MaskFrame): boolean => {
        const thickness = voxelExtentAlong(series.volume, frameNormal(frame));
        return Math.abs(patientToFramePixel(frame, plane.origin).depth) <= thickness / 2 + 1e-6;
      };

      for (const segment of segments) {
        if (segment.plane !== pane.id) continue;
        if (hidden.includes(segment.id)) continue;
        if (!onThisCut(segment.frame)) continue;
        paint(
          image,
          resampleMask(decodeRle(segment.mask), segment.frame, target),
          pane,
          segment.colour,
          90,
        );
      }

      if (draft?.mask && draft.plane === pane.id && onThisCut(draft.frame)) {
        paint(image, resampleMask(draft.mask, draft.frame, target), pane, DRAFT_COLOUR, 70);
      }
    }

    context.putImageData(image, 0, 0);

    // Prompt marks and the rubber band go on top, in plain canvas drawing.
    context.lineWidth = 1.5;
    for (const pane of panes) {
      if (pane.id === "volume" || !draft || draft.plane !== pane.id) continue;
      const plane = standardPlane(series.volume, pane.id, view.cursor, view.pan[pane.id]);
      const target = paneFrame(plane, pane.view.width, pane.view.height, view.paneZoom);
      const toPane = (x: number, y: number): [number, number] => {
        const at = patientToFramePixel(target, framePixelToPatient(draft.frame, x, y));
        return [pane.view.x + at.x + 0.5, pane.view.y + at.y + 0.5];
      };

      if (draft.box) {
        const [x0, y0] = toPane(draft.box.x0, draft.box.y0);
        const [x1, y1] = toPane(draft.box.x1, draft.box.y1);
        context.strokeStyle = "rgba(255,255,255,0.85)";
        context.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
      for (const point of draft.points) {
        const [x, y] = toPane(point.x, point.y);
        context.beginPath();
        context.arc(x, y, 4, 0, Math.PI * 2);
        context.fillStyle = point.positive ? "rgba(78,240,122,0.9)" : "rgba(255,92,114,0.9)";
        context.fill();
        context.strokeStyle = "rgba(0,0,0,0.7)";
        context.stroke();
      }
    }

    const band = bandRef.current;
    if (band) {
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
  }, [series, view, segments, hidden, draft, size]);

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
    const frame = paneFrame(plane, pane.view.width, pane.view.height, view.paneZoom);
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
      void useSegment.getState().addPoint(found.plane, found.patient, !event.altKey);
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

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const band = bandRef.current;
    if (!band) return;
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    band.x = event.clientX - rect.left - band.pane.view.x;
    band.y = event.clientY - rect.top - band.pane.view.y;
    redraw((tick) => tick + 1);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const band = bandRef.current;
    bandRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!band || !series || band.pane.id === "volume") return;
    redraw((tick) => tick + 1);

    const plane = standardPlane(series.volume, band.pane.id, view.cursor, view.pan[band.pane.id]);
    const frame = paneFrame(plane, band.pane.view.width, band.pane.view.height, view.paneZoom);
    void useSegment
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
      onPointerUp={active && mode === "box" ? onPointerUp : undefined}
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="pointer-events-none h-full w-full" />
    </div>
  );
}
