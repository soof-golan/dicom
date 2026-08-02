/**
 * The two small pieces that the first page load carries.
 *
 * Both hold nothing but a heading and a `lazy()` boundary. The panel, the
 * overlay, the store and the model runtime arrive in a separate chunk, and
 * only after the user opens the section.
 */
import { lazy, Suspense } from "react";
import { useSegmentPanel } from "./panelState.ts";

const Panel = lazy(() => import("./SegmentPanel.tsx"));
const Overlay = lazy(() => import("./SegmentOverlay.tsx"));

export function SegmentSection() {
  const open = useSegmentPanel((state) => state.open);
  const toggle = useSegmentPanel((state) => state.toggle);

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="mb-2 flex w-full items-center justify-between text-[11px] uppercase tracking-wider text-neutral-500 transition-colors hover:text-neutral-300"
      >
        Segment
        <span aria-hidden className="text-[10px]">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <Suspense fallback={<p className="text-[11px] text-neutral-600">Loading…</p>}>
          <Panel />
        </Suspense>
      )}
    </section>
  );
}

export function SegmentLayer() {
  const open = useSegmentPanel((state) => state.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Overlay />
    </Suspense>
  );
}
