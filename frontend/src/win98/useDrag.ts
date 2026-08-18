import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Grab-and-move, as an offset rather than a position.
 *
 * The obvious way to make a window draggable is to own its `left`/`top`. That
 * would mean tearing out the responsive rules the windows already use —
 * `left: 80px; right: 80px; margin: 0 auto` on the main one, `left: 50%;
 * transform: translateX(-50%)` on the floating ones — and reimplementing every
 * breakpoint in JavaScript.
 *
 * So this returns a **delta** instead, applied as a `translate` on top of
 * whatever CSS already decided. The layout keeps working at every width, the
 * window still recentres when the viewport changes, and dragging is a dozen
 * lines rather than a rewrite.
 *
 * Pointer events (not mouse) so it works with a trackpad, a pen and a finger,
 * and `setPointerCapture` so a fast drag that leaves the title bar keeps
 * tracking instead of dropping the window mid-flight.
 */

export type Drag = {
  /** Compose into the element's own transform. */
  offset: { x: number; y: number };
  /** Spread onto whatever should be the grab handle. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
  };
  dragging: boolean;
  reset: () => void;
};

export function useDrag(enabled = true): Drag {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const start = useRef({ px: 0, py: 0, ox: 0, oy: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      // Never start a drag from a control that lives in the handle — the
      // close and maximise buttons sit in the title bar.
      if ((e.target as HTMLElement).closest("button, a, input")) return;

      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      start.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
      setDragging(true);
    },
    [enabled, offset.x, offset.y]
  );

  useEffect(() => {
    if (!dragging) return;

    const move = (e: PointerEvent) => {
      const nx = start.current.ox + (e.clientX - start.current.px);
      const ny = start.current.oy + (e.clientY - start.current.py);
      // Keep a grabbable strip on screen. A window dragged entirely past the
      // edge is unrecoverable without a reset nobody knows about.
      const limitX = window.innerWidth * 0.8;
      const limitY = window.innerHeight * 0.7;
      setOffset({
        x: Math.max(-limitX, Math.min(limitX, nx)),
        y: Math.max(-limitY, Math.min(limitY, ny)),
      });
    };
    const up = () => setDragging(false);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging]);

  const reset = useCallback(() => setOffset({ x: 0, y: 0 }), []);

  return {
    offset,
    dragging,
    reset,
    handleProps: {
      onPointerDown,
      style: { cursor: enabled ? "move" : undefined, touchAction: "none" },
    },
  };
}

/** Compose a drag offset with a transform the CSS already applies. */
export function withDrag(offset: { x: number; y: number }, base = ""): string {
  if (!offset.x && !offset.y) return base;
  return `${base} translate(${offset.x}px, ${offset.y}px)`.trim();
}
