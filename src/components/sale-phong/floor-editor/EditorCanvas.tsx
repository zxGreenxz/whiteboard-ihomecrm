import { useLayoutEffect, useRef, useState } from "react";
import DraggableResizable from "./DraggableResizable";
import type { StoredFloorLayout } from "@/pages/phong-trong/floorLayoutShared";
import type { Box } from "@/pages/phong-trong/sampleData";

export interface RoomMeta {
  name: string;
  code: string | null;
  area: number | null;
  available: boolean;
}

type Kind = "room" | "fixture" | "corridor";

/** Canvas tọa độ tuyệt đối (mirror FloorCanvas của trang công khai), scale-to-fit. */
export default function EditorCanvas({
  draft, roomsById, snap, selectedId, onSelect, onChange, onChangeEnd, onUnplaceRoom, onRemoveFixture,
}: {
  draft: StoredFloorLayout;
  roomsById: Record<string, RoomMeta>;
  snap: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (kind: Kind, id: string, box: Box) => void;
  onChangeEnd: () => void;
  onUnplaceRoom: (id: string) => void;
  onRemoveFixture: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / draft.canvasW));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft.canvasW]);

  return (
    <div
      ref={wrapRef}
      className="w-full overflow-hidden rounded-lg border bg-slate-50"
      onMouseDown={() => onSelect(null)}
    >
      <div style={{ height: draft.canvasH * scale }}>
        <div style={{ width: draft.canvasW, height: draft.canvasH, transform: `scale(${scale})`, transformOrigin: "top left", position: "relative" }}>
          {/* Hành lang */}
          <DraggableResizable
            box={draft.corridor} scale={scale} snap={snap}
            selected={selectedId === "corridor"} onSelect={() => onSelect("corridor")}
            onChange={(b) => onChange("corridor", "corridor", b)} onChangeEnd={onChangeEnd}
            className="rounded bg-slate-200/70 border border-dashed border-slate-400 flex items-center justify-center text-[11px] text-slate-500"
          >
            Hành lang
          </DraggableResizable>

          {/* Thiết bị: thang máy / cầu thang */}
          {draft.fixtures.map((fx) => (
            <DraggableResizable
              key={fx.id} box={fx} scale={scale} snap={snap}
              selected={selectedId === fx.id} onSelect={() => onSelect(fx.id)}
              onChange={(b) => onChange("fixture", fx.id, b)} onChangeEnd={onChangeEnd}
              onRemove={() => onRemoveFixture(fx.id)}
              className="rounded-md border-2 border-dashed border-slate-400 bg-white/80 flex items-center justify-center text-xs text-slate-600"
            >
              {fx.kind === "elevator" ? "Thang máy" : "Cầu thang"}
            </DraggableResizable>
          ))}

          {/* Phòng đã đặt */}
          {Object.entries(draft.rooms).map(([id, box]) => {
            const meta = roomsById[id];
            if (!meta) return null; // phòng đã xoá → bỏ qua khi render
            const color = meta.available ? "border-emerald-500 bg-emerald-50" : "border-slate-300 bg-white";
            return (
              <DraggableResizable
                key={id} box={box} scale={scale} snap={snap}
                selected={selectedId === id} onSelect={() => onSelect(id)}
                onChange={(b) => onChange("room", id, b)} onChangeEnd={onChangeEnd}
                onRemove={() => onUnplaceRoom(id)}
                className={`rounded-md border-2 shadow-sm flex flex-col items-center justify-center text-center select-none ${color}`}
              >
                <span className="text-sm font-semibold leading-tight">{meta.name}</span>
                {meta.area ? <span className="text-[10px] text-muted-foreground">{meta.area}m²</span> : null}
              </DraggableResizable>
            );
          })}
        </div>
      </div>
    </div>
  );
}
