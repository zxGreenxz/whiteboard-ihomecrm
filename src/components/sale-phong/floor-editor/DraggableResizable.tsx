import { useRef } from "react";
import { X } from "lucide-react";
import type { Box } from "@/pages/phong-trong/sampleData";

type Handle = "nw" | "ne" | "sw" | "se";
const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];
const MIN_W = 56;
const MIN_H = 44;
const GRID = 14;

const handleStyle: Record<Handle, React.CSSProperties> = {
  nw: { left: -5, top: -5, cursor: "nwse-resize" },
  ne: { right: -5, top: -5, cursor: "nesw-resize" },
  sw: { left: -5, bottom: -5, cursor: "nesw-resize" },
  se: { right: -5, bottom: -5, cursor: "nwse-resize" },
};

/**
 * Box kéo-thả + resize 4 góc trên canvas tọa độ tuyệt đối. Toạ độ là px canvas
 * CHƯA scale; chia delta con trỏ cho `scale` để khớp WYSIWYG với trang công khai.
 */
export default function DraggableResizable({
  box, scale, snap, selected, disabled, className, style, children, onSelect, onChange, onChangeEnd, onRemove,
}: {
  box: Box;
  scale: number;
  snap: boolean;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  onSelect?: () => void;
  onChange: (next: Box) => void;
  onChangeEnd?: () => void;
  onRemove?: () => void;
}) {
  const drag = useRef<{ px: number; py: number; box: Box; mode: "move" | Handle } | null>(null);

  const g = (v: number) => (snap ? Math.round(v / GRID) * GRID : Math.round(v));

  const begin = (mode: "move" | Handle) => (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect?.();
    const start = { px: e.clientX, py: e.clientY, box: { ...box }, mode };
    drag.current = start;

    const onMove = (ev: MouseEvent) => {
      const s = drag.current;
      if (!s) return;
      const dx = (ev.clientX - s.px) / scale;
      const dy = (ev.clientY - s.py) / scale;
      let { x, y, w, h } = s.box;
      if (s.mode === "move") {
        x = Math.max(0, g(s.box.x + dx));
        y = Math.max(0, g(s.box.y + dy));
      } else {
        if (s.mode.includes("e")) w = Math.max(MIN_W, g(s.box.w + dx));
        if (s.mode.includes("s")) h = Math.max(MIN_H, g(s.box.h + dy));
        if (s.mode.includes("w")) {
          const nx = Math.min(s.box.x + s.box.w - MIN_W, g(s.box.x + dx));
          x = Math.max(0, nx);
          w = s.box.x + s.box.w - x;
        }
        if (s.mode.includes("n")) {
          const ny = Math.min(s.box.y + s.box.h - MIN_H, g(s.box.y + dy));
          y = Math.max(0, ny);
          h = s.box.y + s.box.h - y;
        }
      }
      onChange({ x, y, w, h });
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onChangeEnd?.();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      onMouseDown={begin("move")}
      style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, cursor: disabled ? "default" : "move", ...style }}
      className={className}
    >
      {children}
      {selected && !disabled && (
        <>
          {HANDLES.map((hd) => (
            <span
              key={hd}
              onMouseDown={begin(hd)}
              style={{ position: "absolute", width: 10, height: 10, background: "#fff", border: "1.5px solid #2563eb", borderRadius: 2, ...handleStyle[hd] }}
            />
          ))}
          {onRemove && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              style={{ position: "absolute", right: -8, top: -8 }}
              className="bg-red-500 text-white rounded-full p-0.5 shadow"
              title="Bỏ khỏi sơ đồ"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
