import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Wand2, Undo2, Save, ArrowUpDown, DoorOpen, RefreshCw } from "lucide-react";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useFloorLayoutSave } from "@/hooks/useFloorLayoutSave";
import { recordWriteMessage } from "@/lib/recordWriteOutcome";
import { sortBuildingsByName } from "@/lib/roomSort";
import {
  seedFromAuto, type FloorLayoutsMap, type StoredFloorLayout,
} from "@/pages/phong-trong/floorLayoutShared";
import type { Box } from "@/pages/phong-trong/sampleData";
import EditorCanvas, { type RoomMeta } from "./EditorCanvas";
import { FloorLayoutSaveError, confirmDiscardFloorPlan, editedFloors, floorLabel } from "./floorLayoutSave";

type Kind = "room" | "fixture" | "corridor";
const DEFAULT_ROOM: Box = { x: 18, y: 18, w: 150, h: 118 };

const layoutsOf = (value: unknown): FloorLayoutsMap =>
  value && typeof value === "object" && !Array.isArray(value) ? value as FloorLayoutsMap : {};
const errorMessage = (error: unknown, operation: string) =>
  error instanceof FloorLayoutSaveError ? error.message : recordWriteMessage(error, operation);

export default function FloorPlanEditorTab({ onDirtyChange, onBusyChange }: {
  onDirtyChange?: (dirty: boolean) => void;
  /** Đang lưu / đang tải bản mới: trang cha khoá đổi tab để không mất câu báo xung đột hay từ chối. */
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const { data: buildings } = useBuildings();
  const [buildingId, setBuildingId] = useState("");
  const { data: rooms } = useRooms(buildingId || undefined);
  const { save: saveLayouts, readLatest } = useFloorLayoutSave();

  // base = bản máy chủ lúc mở toà / lúc lưu xong; byFloor = bản trên màn hình (gồm tầng tự xếp tạm).
  const [base, setBase] = useState<FloorLayoutsMap>({});
  const [byFloor, setByFloor] = useState<FloorLayoutsMap>({});
  const [touched, setTouched] = useState<string[]>([]);
  const [floor, setFloor] = useState<number | null>(null);
  const [history, setHistory] = useState<FloorLayoutsMap[]>([]);
  const [snap, setSnap] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [reloading, setReloading] = useState(false);
  const draggingRef = useRef(false);

  const pending = useMemo(() => editedFloors(base, byFloor, touched), [base, byFloor, touched]);
  const dirty = pending.length > 0;
  const saving = saveLayouts.isPending || reloading;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [saving, onBusyChange]);
  // Đóng / tải lại trang khi còn tầng chưa lưu hoặc đang lưu: trình duyệt hỏi trước.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty && !saving) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

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

  const resetTo = (id: string, layouts: FloorLayoutsMap, keepFloor: number | null = null) => {
    setBuildingId(id);
    setBase(layouts);
    setByFloor(layouts);
    setTouched([]);
    setFloor(keepFloor);
    setHistory([]);
    setSelectedId(null);
    setSaveError(null);
  };

  // Chọn toà: hỏi trước khi bỏ tầng chưa lưu, rồi nạp floor_layouts đã lưu làm mốc so sánh.
  const selectBuilding = (id: string) => {
    if (id === buildingId || saving) return;
    if (!confirmDiscardFloorPlan(pending, "chuyển sang toà khác")) return;
    const b = (buildings ?? []).find((x) => x.id === id);
    resetTo(id, layoutsOf(b?.floor_layouts));
  };

  // Tự chọn tầng đầu khi rooms về.
  useEffect(() => {
    if (buildingId && floor == null && floors.length) setFloor(floors[0]);
  }, [buildingId, floor, floors]);

  // Seed tầng chưa có layout (từ layoutFloor) để editor không trống. Tầng tự xếp tạm KHÔNG tính là đã sửa.
  // Chạy lại cả khi bản trên màn hình vừa được thay (tải bản mới nhất) mà tầng đang xem chưa có sơ đồ.
  const floorMissing = floor != null && !byFloor[String(floor)];
  useEffect(() => {
    if (floor == null || !roomsAll.length) return;
    const key = String(floor);
    setByFloor((m) => (m[key] ? m : { ...m, [key]: seedFromAuto(floor, roomsOnFloor as never) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor, roomsAll, floorMissing]);

  const pushHistory = () => setHistory((h) => [...h.slice(-29), byFloor]);
  const snapshot = () => setHistory((h) => [...h.slice(-29), byFloor]);
  const touch = (key: string) => setTouched((t) => (t.includes(key) ? t : [...t, key]));

  const editFloor = (fn: (cur: StoredFloorLayout) => StoredFloorLayout) => {
    if (floor == null || saving) return;
    const key = String(floor);
    setByFloor((m) => (m[key] ? { ...m, [key]: fn(m[key]) } : m));
    touch(key);
  };

  const onChange = (kind: Kind, id: string, box: Box) => {
    if (saving) return;
    if (!draggingRef.current) { pushHistory(); draggingRef.current = true; }
    editFloor((cur) => {
      if (kind === "corridor") return { ...cur, corridor: box };
      if (kind === "fixture") return { ...cur, fixtures: cur.fixtures.map((f) => (f.id === id ? { ...f, ...box } : f)) };
      return { ...cur, rooms: { ...cur.rooms, [id]: box } };
    });
  };
  const onChangeEnd = () => { draggingRef.current = false; };

  const unplaceRoom = (id: string) => { if (saving) return; snapshot(); editFloor((cur) => { const { [id]: _omit, ...rest } = cur.rooms; return { ...cur, rooms: rest }; }); setSelectedId(null); };
  const placeRoom = (id: string) => {
    if (saving) return;
    snapshot();
    editFloor((cur) => {
      const x = Math.max(0, Math.round((cur.canvasW - DEFAULT_ROOM.w) / 2));
      const y = Math.max(0, Math.round((cur.canvasH - DEFAULT_ROOM.h) / 2));
      return { ...cur, rooms: { ...cur.rooms, [id]: { ...DEFAULT_ROOM, x, y } } };
    });
  };
  const addFixture = (kind: "elevator" | "stairs") => {
    if (saving) return;
    snapshot();
    editFloor((cur) => {
      const w = 120, h = 96;
      const x = Math.max(0, Math.round((cur.canvasW - w) / 2));
      const y = Math.max(0, Math.round((cur.canvasH - h) / 2));
      const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
      return { ...cur, fixtures: [...cur.fixtures, { id, kind, x, y, w, h }] };
    });
  };
  const removeFixture = (id: string) => { if (saving) return; snapshot(); editFloor((cur) => ({ ...cur, fixtures: cur.fixtures.filter((f) => f.id !== id) })); setSelectedId(null); };
  const autoArrange = () => {
    if (floor == null || saving) return;
    snapshot();
    const key = String(floor);
    setByFloor((m) => ({ ...m, [key]: seedFromAuto(floor, roomsOnFloor as never) }));
    touch(key);
    setSelectedId(null);
  };
  const undo = () => {
    if (!history.length || saving) return;
    setByFloor(history[history.length - 1]);
    setHistory(history.slice(0, -1));
    setSelectedId(null);
  };

  // Chỉ gửi tầng đã sửa, gộp lên bản mới nhất của máy chủ; tầng người khác vừa lưu thì báo, không ghi đè.
  const save = () => {
    if (!buildingId || !dirty || saving) return;
    const floorsToSave = pending;
    setSaveError(null);
    saveLayouts.mutate({ buildingId, base, draft: byFloor, floors: floorsToSave }, {
      onSuccess: (written) => {
        setBase(written.floorLayouts);
        // Tầng khác lấy bản máy chủ (có thể vừa có người lưu); tầng tự xếp tạm chưa lưu vẫn giữ.
        setByFloor((current) => ({ ...current, ...written.floorLayouts }));
        setTouched([]);
        setHistory([]);
        toast.success(`Đã lưu sơ đồ ${floorLabel(floorsToSave)}.`);
      },
      onError: (error) => setSaveError({
        message: errorMessage(error, "lưu sơ đồ toà nhà"),
        conflict: error instanceof FloorLayoutSaveError && error.kind === "conflict",
      }),
    });
  };

  const reloadLatest = async () => {
    if (!buildingId || saving) return;
    if (!confirmDiscardFloorPlan(pending, "tải bản mới nhất trên máy chủ")) return;
    setReloading(true);
    try {
      const latest = await readLatest(buildingId);
      resetTo(buildingId, latest.floorLayouts, floor);
    } catch (error) {
      setSaveError({ message: errorMessage(error, "tải bản sơ đồ mới nhất"), conflict: false });
    } finally {
      setReloading(false);
    }
  };

  const changeFloor = (f: number) => { setFloor(f); setSelectedId(null); setHistory([]); };

  const unplacedRooms = useMemo(
    () => (draft ? roomsOnFloor.filter((r) => !draft.rooms[r.id]) : []),
    [draft, roomsOnFloor],
  );

  const buildingOpts = sortBuildingsByName(buildings ?? []).map((b) => ({
    value: b.id, label: `${b.name}${b.code && b.code !== b.name ? ` (${b.code})` : ""}`,
  }));
  const floorOpts = floors.map((f) => ({ value: String(f), label: `Tầng ${f}` }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Kéo-thả vị trí phòng, thang máy/cầu thang và hành lang cho từng tầng. Trang công khai
        <code className="mx-1 bg-muted px-1 rounded">/r/:token</code> sẽ hiển thị đúng sơ đồ này.
        Phòng chưa đặt sẽ tự xếp tạm bên dưới. Bấm Lưu chỉ ghi các tầng bạn đã sửa.
      </p>

      {/* Toolbar */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5 w-56">
            <Label>Toà nhà</Label>
            <SearchableSelect value={buildingId} onValueChange={selectBuilding} options={buildingOpts}
              placeholder="Chọn toà nhà" emptyText="Không có toà nhà" disabled={saving} />
          </div>
          <div className="space-y-1.5 w-36">
            <Label>Tầng</Label>
            <SearchableSelect value={floor != null ? String(floor) : ""} onValueChange={(v) => changeFloor(Number(v))}
              options={floorOpts} placeholder={buildingId ? "Chọn tầng" : "Chọn toà trước"} emptyText="Không có tầng"
              disabled={!buildingId} />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {dirty && <span className="text-xs text-amber-700" role="status">Chưa lưu: {floorLabel(pending)}</span>}
            <div className="flex items-center gap-1.5 mr-1">
              <Switch id="snap" checked={snap} onCheckedChange={setSnap} />
              <Label htmlFor="snap" className="text-xs">Bắt lưới</Label>
            </div>
            <Button variant="outline" size="sm" onClick={autoArrange} disabled={!draft || saving} title="Xếp lại tự động">
              <Wand2 className="h-4 w-4 mr-1" />Tự sắp xếp
            </Button>
            <Button variant="outline" size="sm" onClick={undo} disabled={!history.length || saving}>
              <Undo2 className="h-4 w-4 mr-1" />Hoàn tác
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              <Save className="h-4 w-4 mr-1" />{saveLayouts.isPending ? "Đang lưu…" : "Lưu sơ đồ"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {saveError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <span>{saveError.message}</span>
          {saveError.conflict && (
            <Button variant="outline" size="sm" onClick={() => void reloadLatest()} disabled={saving}>
              <RefreshCw className="h-4 w-4 mr-1" />Tải bản mới nhất
            </Button>
          )}
        </div>
      )}

      {!buildingId ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Chọn toà nhà để bắt đầu thiết kế sơ đồ.</CardContent></Card>
      ) : !floors.length ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Toà nhà này chưa có phòng nào.</CardContent></Card>
      ) : !draft ? (
        <Card><CardContent className="p-6"><LoadingState label="sơ đồ" variant="lines" rows={4} /></CardContent></Card>
      ) : (
        <div className={saving ? "space-y-4 pointer-events-none opacity-60" : "space-y-4"} aria-busy={saving}>
          {/* Palette thiết bị */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Thêm thiết bị:</span>
            <Button variant="outline" size="sm" onClick={() => addFixture("elevator")} disabled={saving}>
              <ArrowUpDown className="h-4 w-4 mr-1" />Thang máy
            </Button>
            <Button variant="outline" size="sm" onClick={() => addFixture("stairs")} disabled={saving}>
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
                    title="Thêm vào sơ đồ" disabled={saving}>
                    + {r.name}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Mọi phòng của tầng đã được đặt.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
