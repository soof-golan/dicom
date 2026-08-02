import { useEffect, useRef } from "react";
import type { Vec3 } from "../../core/geometry/vec3.ts";
import {
  clampToBounds,
  patientBounds,
  standardPlane,
  type PlaneId,
} from "../../core/view/planes.ts";
import { activeSeries, useStudy } from "../store.ts";
import { gestureFor } from "./interaction.ts";
import { cubeViewport, VolumeScene, type Viewport } from "./VolumeScene.ts";
import type { CubeRegion } from "../../core/view/viewcube.ts";
import { anglesFor } from "../../core/view/viewcube.ts";

const GAP = 2;

export type PaneId = PlaneId | "volume";

export interface Pane {
  readonly id: PaneId;
  readonly view: Viewport;
}

/** A 2x2 grid: three cuts and the 3D view. */
export function layout(width: number, height: number): Pane[] {
  const w = Math.floor((width - GAP) / 2);
  const h = Math.floor((height - GAP) / 2);
  const right = width - w - GAP;
  const bottom = height - h - GAP;
  return [
    { id: "axial", view: { x: 0, y: 0, width: w, height: h } },
    { id: "coronal", view: { x: w + GAP, y: 0, width: right, height: h } },
    { id: "sagittal", view: { x: 0, y: h + GAP, width: w, height: bottom } },
    { id: "volume", view: { x: w + GAP, y: h + GAP, width: right, height: bottom } },
  ];
}

function paneAt(panes: readonly Pane[], x: number, y: number): Pane | undefined {
  return panes.find(
    ({ view }) =>
      view.width > 0 &&
      view.height > 0 &&
      x >= view.x &&
      x < view.x + view.width &&
      y >= view.y &&
      y < view.y + view.height,
  );
}

type Drag =
  | { kind: "crosshair"; pane: Pane }
  | { kind: "pan"; pane: Pane; lastX: number; lastY: number }
  | { kind: "window"; startX: number; startY: number; center: number; width: number }
  | { kind: "orbit"; startX: number; startY: number; azimuth: number; elevation: number };

export function ViewerCanvas({ onPanes }: { onPanes?: (panes: Pane[]) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<VolumeScene>(null);
  const panesRef = useRef<Pane[]>([]);
  const dragRef = useRef<Drag>(null);
  const hoveredCubeRef = useRef<CubeRegion>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new VolumeScene(canvas);
    sceneRef.current = scene;

    let frame = 0;
    let uploadedUid: string | undefined;
    // The partner can arrive after the active series, so the upload has to
    // happen again when it does. Without this the colors stay single-sequence
    // until the reader clicks another series.
    let uploadedPartnerUid: string | undefined;

    const draw = () => {
      const state = useStudy.getState();
      const series = activeSeries(state);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;

      scene.setSize(width, height, Math.min(globalThis.devicePixelRatio, 2));
      scene.clear();
      if (!series) return;

      // Uploading a volume is the one expensive step. Do it when the series
      // changes, not on every frame.
      const activeUid = series.summary.seriesInstanceUid;
      const partner =
        state.pair &&
        (state.pair.t1.seriesInstanceUid === activeUid ? state.pair.fatsat : state.pair.t1);
      if (uploadedUid !== activeUid || uploadedPartnerUid !== partner?.seriesInstanceUid) {
        scene.setVolume(series.volume, state.pair);
        uploadedUid = activeUid;
        uploadedPartnerUid = partner?.seriesInstanceUid;
      }

      const panes = layout(width, height);
      panesRef.current = panes;
      onPanes?.(panes);

      const planes = scene.planesFor(series.volume, state.view);
      for (const pane of panes) {
        if (pane.id === "volume") {
          scene.drawVolume(pane.view, state.view, planes, hoveredCubeRef.current ?? undefined);
        } else {
          const plane = planes.find((entry) => entry.id === pane.id);
          if (plane) scene.drawPlane(pane.view, plane, state.view);
        }
      }
    };

    // A continuous loop that only draws when something changed. This survives
    // the double mount that React StrictMode performs in development, where a
    // one-shot frame can be cancelled before it ever runs.
    let dirty = true;
    let running = true;
    const markDirty = () => {
      dirty = true;
    };

    const tick = () => {
      if (!running) return;
      frame = requestAnimationFrame(tick);
      if (!dirty) return;
      dirty = false;
      draw();
    };

    const unsubscribe = useStudy.subscribe(markDirty);
    const observer = new ResizeObserver(markDirty);
    observer.observe(canvas);
    tick();

    if (import.meta.env.DEV) {
      (globalThis as unknown as { __scene?: VolumeScene }).__scene = scene;
    }

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [onPanes]);

  /** Where a pointer sits inside a pane, in patient millimeters. */
  const patientAt = (pane: Pane, clientX: number, clientY: number): Vec3 | undefined => {
    const canvas = canvasRef.current;
    const series = activeSeries(useStudy.getState());
    if (!canvas || !series || pane.id === "volume") return undefined;

    const rect = canvas.getBoundingClientRect();
    const state = useStudy.getState().view;
    const plane = standardPlane(series.volume, pane.id, state.cursor, state.pan[pane.id]);

    const localX = clientX - rect.left - pane.view.x;
    const localY = clientY - rect.top - pane.view.y;
    const s = localX / pane.view.width - 0.5;
    const t = localY / pane.view.height - 0.5;

    const aspect = pane.view.width / Math.max(pane.view.height, 1);
    const planeAspect = plane.size[0] / Math.max(plane.size[1], 1e-6);
    const fitted =
      planeAspect > aspect
        ? [plane.size[0], plane.size[0] / aspect]
        : [plane.size[1] * aspect, plane.size[1]];
    const w = fitted[0]! / state.paneZoom;
    const h = fitted[1]! / state.paneZoom;

    if (!Number.isFinite(s) || !Number.isFinite(t) || !Number.isFinite(w) || !Number.isFinite(h)) {
      return undefined;
    }
    return [
      plane.origin[0] + plane.u[0] * s * w + plane.v[0] * t * h,
      plane.origin[1] + plane.u[1] * s * w + plane.v[1] * t * h,
      plane.origin[2] + plane.u[2] * s * w + plane.v[2] * t * h,
    ];
  };

  /** How many millimeters one screen pixel covers in a pane. */
  const millimetersPerPixel = (pane: Pane): { x: number; y: number } => {
    const series = activeSeries(useStudy.getState());
    if (!series || pane.id === "volume") return { x: 0, y: 0 };
    const state = useStudy.getState().view;
    const plane = standardPlane(series.volume, pane.id, state.cursor, state.pan[pane.id]);
    const aspect = pane.view.width / Math.max(pane.view.height, 1);
    const planeAspect = plane.size[0] / Math.max(plane.size[1], 1e-6);
    const fitted =
      planeAspect > aspect
        ? [plane.size[0], plane.size[0] / aspect]
        : [plane.size[1] * aspect, plane.size[1]];
    return {
      x: fitted[0]! / state.paneZoom / Math.max(pane.view.width, 1),
      y: fitted[1]! / state.paneZoom / Math.max(pane.view.height, 1),
    };
  };

  /** The view cube region under a pointer, or nothing when it misses the cube. */
  const cubeRegionAt = (clientX: number, clientY: number): CubeRegion | undefined => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    const volumePane = panesRef.current.find((pane) => pane.id === "volume");
    if (!canvas || !scene || !volumePane) return undefined;

    const rect = canvas.getBoundingClientRect();
    const box = cubeViewport(volumePane.view);
    const x = clientX - rect.left - box.x;
    const y = clientY - rect.top - box.y;
    if (x < 0 || y < 0 || x > box.width || y > box.height) return undefined;
    return scene.cube.pick(x, y, box, useStudy.getState().view.orbit);
  };

  const moveCursorTo = (pane: Pane, clientX: number, clientY: number): void => {
    const series = activeSeries(useStudy.getState());
    const point = patientAt(pane, clientX, clientY);
    if (!series || !point) return;
    useStudy.getState().setCursor(clampToBounds(patientBounds(series.volume), point));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pane = paneAt(panesRef.current, event.clientX - rect.left, event.clientY - rect.top);
    if (!pane) return;
    canvas.setPointerCapture(event.pointerId);

    const view = useStudy.getState().view;

    // The cube sits on top of the 3D view, so it gets the press first.
    if (pane.id === "volume" && event.button === 0 && !event.shiftKey && !event.altKey) {
      const region = cubeRegionAt(event.clientX, event.clientY);
      if (region) {
        const angles = anglesFor(region.direction);
        useStudy.getState().patchView({ orbit: { ...view.orbit, ...angles } });
        return;
      }
    }

    const gesture = gestureFor(event, pane.id === "volume" ? "volume" : "cut");

    switch (gesture) {
      case "window":
        dragRef.current = {
          kind: "window",
          startX: event.clientX,
          startY: event.clientY,
          center: view.windowCenter,
          width: view.windowWidth,
        };
        break;
      case "pan":
        dragRef.current = { kind: "pan", pane, lastX: event.clientX, lastY: event.clientY };
        break;
      case "orbit":
        dragRef.current = {
          kind: "orbit",
          startX: event.clientX,
          startY: event.clientY,
          azimuth: view.orbit.azimuth,
          elevation: view.orbit.elevation,
        };
        break;
      case "crosshair":
        dragRef.current = { kind: "crosshair", pane };
        moveCursorTo(pane, event.clientX, event.clientY);
        break;
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      const region = cubeRegionAt(event.clientX, event.clientY);
      if (region?.id !== hoveredCubeRef.current?.id) {
        hoveredCubeRef.current = region ?? null;
        // Nudge the render loop, which watches the store.
        useStudy.getState().patchView({});
      }
      return;
    }
    const store = useStudy.getState();

    if (drag.kind === "crosshair") {
      moveCursorTo(drag.pane, event.clientX, event.clientY);
      return;
    }
    if (drag.kind === "pan") {
      if (drag.pane.id === "volume") return;
      const scale = millimetersPerPixel(drag.pane);
      store.panBy(
        drag.pane.id,
        -(event.clientX - drag.lastX) * scale.x,
        -(event.clientY - drag.lastY) * scale.y,
      );
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      return;
    }
    if (drag.kind === "window") {
      const scale = Math.max(store.view.windowWidth, 1) / 200;
      store.patchView({
        windowCenter: drag.center + (event.clientY - drag.startY) * scale,
        windowWidth: Math.max(1, drag.width + (event.clientX - drag.startX) * scale),
      });
      return;
    }
    const limit = Math.PI / 2 - 0.01;
    store.patchView({
      orbit: {
        ...store.view.orbit,
        // Dragging holds the volume and turns it, the way CAD software does.
        // The camera moves the opposite way to the pointer, so both signs are
        // the reverse of the camera angles they set.
        azimuth: drag.azimuth - (event.clientX - drag.startX) * 0.008,
        elevation: Math.max(
          -limit,
          Math.min(limit, drag.elevation + (event.clientY - drag.startY) * 0.008),
        ),
      },
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    canvasRef.current?.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const series = activeSeries(useStudy.getState());
    if (!canvas || !series) return;
    const rect = canvas.getBoundingClientRect();
    const pane = paneAt(panesRef.current, event.clientX - rect.left, event.clientY - rect.top);
    if (!pane) return;

    const store = useStudy.getState();
    if (pane.id === "volume") {
      store.patchView({
        orbit: {
          ...store.view.orbit,
          zoom: Math.max(0.6, Math.min(6, store.view.orbit.zoom * (1 + event.deltaY * 0.001))),
        },
      });
      return;
    }

    // Step the cursor along the normal of the pane under the pointer.
    const plane = standardPlane(series.volume, pane.id, store.view.cursor, store.view.pan[pane.id]);
    const step = Math.sign(event.deltaY) * Math.min(...series.volume.spacing);
    const moved: Vec3 = [
      store.view.cursor[0] + plane.normal[0] * step,
      store.view.cursor[1] + plane.normal[1] * step,
      store.view.cursor[2] + plane.normal[2] * step,
    ];
    store.setCursor(clampToBounds(patientBounds(series.volume), moved));
  };

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
