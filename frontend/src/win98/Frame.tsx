import { useEffect } from "react";
import { PixelIcon, type IconName } from "./pixel";
import { useDrag, withDrag } from "./useDrag";

/**
 * The shared floating-window frame.
 *
 * Title bar, close button, escape-to-dismiss and drag-to-move, so every
 * utility window behaves the same way without each one reimplementing it.
 */
export function Frame({
  title, icon, onClose, width, children,
}: {
  title: string;
  icon: IconName;
  onClose: () => void;
  width: number;
  children: React.ReactNode;
}) {
  const drag = useDrag();

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div
      className="win win-game"
      style={{
        top: 140,
        left: "50%",
        transform: withDrag(drag.offset, "translateX(-50%)"),
        width: `min(${width}px, calc(100vw - 24px))`,
      }}
    >
      <div
        className="titlebar"
        {...drag.handleProps}
        onDoubleClick={drag.reset}
        title="Drag to move · double-click to recentre"
      >
        <PixelIcon name={icon} size={16} />
        <span className="t-text">{title}</span>
        <span className="t-btns">
          <button className="tbtn close" aria-label="Close" onClick={onClose} />
        </span>
      </div>
      <div className="client" style={{ padding: 14 }}>{children}</div>
    </div>
  );
}
