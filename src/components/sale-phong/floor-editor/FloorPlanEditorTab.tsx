import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Wand2, Undo2, Save, ArrowUpDown, DoorOpen } from "lucide-react";
import { useBuildings, useUpdateBuilding } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import {
  seedFromAuto, type FloorLayoutsMap, type StoredFloorLayout,
} from "@/pages/phong-trong/floorLayoutShared";
import type { Box } from "@/pages/phong-trong/sampleData";
import type { Json } from "@/integrations/supabase/types";
import EditorCanvas, { type RoomMeta } from "./EditorCanvas";

type Kind = "room" | "fixture" | "corridor";
const DEFAULT_ROOM: Box = { x: 18, y: 18, w: 150, h: 118 };

export default function FloorPlanEditorTab() {
  const { data: buildings } = useBuildings();
  const [buildingId, setBuildingId] = useState("");
  const { data: rooms } = useRooms(buildingId || undefined);
  const updateBuilding = useUpdateBuilding();

  const [byFloor, setByFloor] = useState<FloorLayoutsMap>({});
  const [floor, setFloor] = useState<number | null>(null);
  const [history, setHistory] = useState<FloorLayoutsMap[]>([]);
  const [snap, setSnap] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const draggingRef = useRef(false);

  const roomsAll = useMemo(() => rooms ?? [], [rooms]);
  const floors = useMemo(
    () => Array.from(new Set(roomsAll.map((r) => r.floor as number))).sort((a, b) => b - a),
    [roomsAll],
  );
  const roomsOnFloor = useMemo(
    () => roomsAll.filter((r) => r.floor === floor),
    [roomsAll, floor],
  );
  const roomsById = useMemo<Record<string, RoomMeta>>(
    () => Object.fromEntries(roomsAll.map((r) => [r.id, {
      name: r.name, code: r.code, area: r.area, available: r.status === "AVAILABLE",
    }])),
    [roomsAll],
  );

  const draft: StoredFloorLayout | undefined = floor != null ? byFloor[String(floor)] : undefined;

  // Chọn toà: nạp floor_layouts đã lưu (snapshot tại thời điểm chọn), reset trạng thái.
  const selectBuilding = (id: string) => {
    const b = (buildings ?? []).find((x) => x.id === id);
    setBuildingId(id);
    setByFloor((b?.floor_layouts as unknown as FloorLayoutsMap) ?? {});
    setFloor(null);
    setHistory([]);
    setSelectedId(null);
    setDirty(false);
  };

  // Tự chọn tầng đầu khi rooms về.
  useEffect(() => {
    if (buildingId && floor == null && floors.length) setFloor(floors[0]);
  }, [buildingId, floor, floors]);

  // Seed tầng chưa có layout (từ layoutFloor) để editor không trống.
  useEffect(() => {
    if (floor == null || !roomsAll.length) return;
    const key = String(floor);
    setByFloor((m) => (m[key] ? m : { ...m, [key]: seedFromAuto(floor, roomsOnFloor as never) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor, roomsAll]);

  const pushHistory = () => setHistory((h) => [...h.slice(-29), byFloor]);
  const snapshot = () => setHistory((h) => [...h.slice(-29), byFloor]);

  const editFloor = (fn: (cur: StoredFloorLayout) => StoredFloorLayout) => {
    if (floor == null) return;
    const key = String(floor);
    setByFloor((m) => (m[key] ? { ...m, [key]: fn(m[key]) } : m));
    setDirty(true);
  };

  const onChange = (kind: Kind, id: string, box: Box) => {
    if (!draggingRef.current) { pushHistory(); draggingRef.current = true; }
    editFloor((cur) => {
      if (kind === "corridor") return { ...cur, corridor: box };
      if (kind === "fixture") return { ...cur, fixtures: cur.fixtures.map((f) => (f.id === id ? { ...f, ...box } : f)) };
      return { ...cur, rooms: { ...cur.rooms, [id]: box } };
    });
  };
  const onChangeEnd = () => { draggingRef.current = false; };

  const unplaceRoom = (id: string) => { snapshot(); editFloor((cur) => { const { [id]: _omit, ...rest } = cur.rooms; return { ...cur, rooms: rest }; }); setSelectedId(null); };
  const placeRoom = (id: string) => {
    snapshot();
    editFloor((cur) => {
      const x = Math.max(0, Math.round((cur.canvasW - DEFAULT_ROOM.w) / 2));
      const y = Math.max(0, Math.round((cur.canvasH - DEFAULT_ROOM.h) / 2));
      return { ...cur, rooms: { ...cur.rooms, [id]: { ...DEFAULT_ROOM, x, y } } };
    });
  };
  const addFixture = (kind: "elevator" | "stairs") => {
    snapshot();
    editFloor((cur) => {
      const w = 120, h = 96;
      const x = Math.max(0, Math.round((cur.canvasW - w) / 2));
      const y = Math.max(0, Math.round((cur.canvasH - h) / 2));
      const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
      return { ...cur, fixtures: [...cur.fixtures, { id, kind, x, y, w, h }] };
    });
  };
  const removeFixture = (id: string) => { snapshot(); editFloor((cur) => ({ ...cur, fixtures: cur.fixtures.filter((f) => f.id !== id) })); setSelectedId(null); };
  const autoArrange = () => {
    if (floor == null) return;
    snapshot();
    setByFloor((m) => ({ ...m, [String(floor)]: seedFromAuto(floor, roomsOnFloor as never) }));
    setDirty(true);
    setSelectedId(null);
  };
  const undo = () => {
    if (!history.length) return;
    setByFloor(history[history.length - 1]);
    setHistory(history.slice(0, -1));
    setSelectedId(null);
  };
  const save = () => {
    if (!buildingId) return;
    updateBuilding.mutate(
      { id: buildingId, updates: { floor_layouts: byFloor as unknown as Json } },
      { onSuccess: () => { setDirty(false); setHistory([]); } },
    );
  };

  const changeFloor = (f: number) => { setFloor(f); setSelectedId(null); setHistory([]); };

  const unplacedRooms = useMemo(
    () => (draft ? roomsOnFloor.filter((r) => !draft.rooms[r.id]) : []),
    [draft, roomsOnFloor],
  );

  const buildingOpts = (buildings ?? []).map((b) => ({
    value: b.id, label: `${b.name}${b.code && b.code !== b.name ? ` (${b.code})` : ""}`,
  }));
  const floorOpts = floors.map((f) => ({ value: String(f), label: `Tầng ${f}` }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Kéo-thả vị trí phòng, thang máy/cầu thang và hành lang cho từng tầng. Trang công khai
        <code className="mx-1 bg-muted px-1 rounded">/r/:token</code> sẽ hiển thị đúng sơ đồ này.
        Phòng chưa đặt sẽ tự xếp tạm bên dưới.
      </p>

      {/* Toolbar */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5 w-56">
            <Label>Toà nhà</Label>
            <SearchableSelect value={buildingId} onValueChange={selectBuilding} options={buildingOpts}
              placeholder="Chọn toà nhà" emptyText="Không có toà nhà" />
          </div>
          <div className="space-y-1.5 w-36">
            <Label>Tầng</Label>
            <SearchableSelect value={floor != null ? String(floor) : ""} onValueChange={(v) => changeFloor(Number(v))}
              options={floorOpts} placeholder={buildingId ? "Chọn tầng" : "Chọn toà trước"} emptyText="Không có tầng"
              disabled={!buildingId} />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <div className="flex items-center gap-1.5 mr-1">
              <Switch id="snap" checked={snap} onCheckedChange={setSnap} />
              <Label htmlFor="snap" className="text-xs">Bắt lưới</Label>
            </div>
            <Button variant="outline" size="sm" onClick={autoArrange} disabled={!draft} title="Xếp lại tự động">
              <Wand2 className="h-4 w-4 mr-1" />Tự sắp xếp
            </Button>
            <Button variant="outline" size="sm" onClick={undo} disabled={!history.length}>
              <Undo2 className="h-4 w-4 mr-1" />Hoàn tác
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || updateBuilding.isPending}>
              <Save className="h-4 w-4 mr-1" />Lưu sơ đồ
            </Button>
          </div>
        </CardContent>
      </Card>

      {!buildingId ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Chọn toà nhà để bắt đầu thiết kế sơ đồ.</CardContent></Card>
      ) : !floors.length ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Toà nhà này chưa có phòng nào.</CardContent></Card>
      ) : !draft ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Đang dựng sơ đồ…</CardContent></Card>
      ) : (
        <>
          {/* Palette thiết bị */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Thêm thiết bị:</span>
            <Button variant="outline" size="sm" onClick={() => addFixture("elevator")}>
              <ArrowUpDown className="h-4 w-4 mr-1" />Thang máy
            </Button>
            <Button variant="outline" size="sm" onClick={() => addFixture("stairs")}>
              <ArrowUpDown className="h-4 w-4 mr-1" />Cầu thang
            </Button>
          </div>

          <EditorCanvas
            draft={draft} roomsById={roomsById} snap={snap} selectedId={selectedId}
            onSelect={setSelectedId} onChange={onChange} onChangeEnd={onChangeEnd}
            onUnplaceRoom={unplaceRoom} onRemoveFixture={removeFixture}
          />

          {/* Phòng chưa đặt */}
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium mb-1.5">
              <DoorOpen className="h-4 w-4" />Phòng chưa đặt ({unplacedRooms.length})
            </div>
            {unplacedRooms.length ? (
              <div className="flex flex-wrap gap-2">
                {unplacedRooms.map((r) => (
                  <Button key={r.id} variant="outline" size="sm" className="h-8" onClick={() => placeRoom(r.id)}
                    title="Thêm vào sơ đồ">
                    + {r.name}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Mọi phòng của tầng đã được đặt.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
