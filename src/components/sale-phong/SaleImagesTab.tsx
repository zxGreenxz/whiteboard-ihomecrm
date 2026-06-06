import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useBuildings, useUpdateBuilding } from "@/hooks/useBuildings";
import { useRooms, useUpdateRoom } from "@/hooks/useRooms";
import SaleImageManager from "./SaleImageManager";

/** jsonb images (string[] | null | gì khác) → string[]. */
const toStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function RoomImagesSection() {
  const { data: buildings } = useBuildings();
  const [buildingId, setBuildingId] = useState("");
  const { data: rooms } = useRooms(buildingId || undefined);
  const [roomId, setRoomId] = useState("");
  const updateRoom = useUpdateRoom();

  const room = useMemo(() => (rooms ?? []).find((r) => r.id === roomId), [rooms, roomId]);
  const [draft, setDraft] = useState<string[]>([]);
  useEffect(() => { setDraft(toStrArr(room?.images)); }, [room]);
  // Đổi toà → reset phòng đang chọn.
  useEffect(() => { setRoomId(""); }, [buildingId]);

  const buildingOpts = (buildings ?? []).map((b) => ({ value: b.id, label: `${b.name}${b.code && b.code !== b.name ? ` (${b.code})` : ""}` }));
  const roomOpts = (rooms ?? []).map((r) => ({
    value: r.id,
    label: `${r.name}${r.code ? ` · ${r.code}` : ""} — Tầng ${r.floor}`,
    keywords: `${r.name} ${r.code ?? ""}`,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ảnh phòng</CardTitle>
        <CardDescription>Ảnh hiển thị trong gallery chi tiết phòng trên trang công khai.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Toà nhà</Label>
            <SearchableSelect value={buildingId} onValueChange={setBuildingId} options={buildingOpts}
              placeholder="Chọn toà nhà" emptyText="Không có toà nhà" />
          </div>
          <div className="space-y-1.5">
            <Label>Phòng</Label>
            <SearchableSelect value={roomId} onValueChange={setRoomId} options={roomOpts}
              placeholder={buildingId ? "Chọn phòng" : "Chọn toà trước"} emptyText="Không có phòng"
              disabled={!buildingId} />
          </div>
        </div>

        {room ? (
          <>
            <SaleImageManager value={draft} onChange={setDraft} />
            <div className="flex justify-end">
              <Button disabled={updateRoom.isPending}
                onClick={() => updateRoom.mutate({ id: room.id, updates: { images: draft } })}>
                Lưu ảnh phòng
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Chọn toà nhà và phòng để quản lý ảnh.</p>
        )}
      </CardContent>
    </Card>
  );
}

function BuildingImagesSection() {
  const { data: buildings } = useBuildings();
  const [buildingId, setBuildingId] = useState("");
  const updateBuilding = useUpdateBuilding();

  const building = useMemo(() => (buildings ?? []).find((b) => b.id === buildingId), [buildings, buildingId]);
  const [draft, setDraft] = useState<string[]>([]);
  useEffect(() => { setDraft(toStrArr(building?.images)); }, [building]);

  const buildingOpts = (buildings ?? []).map((b) => ({ value: b.id, label: `${b.name}${b.code && b.code !== b.name ? ` (${b.code})` : ""}` }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ảnh toà nhà</CardTitle>
        <CardDescription>Ảnh bìa toà nhà hiển thị ở đầu mỗi toà trên trang công khai.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5 sm:max-w-sm">
          <Label>Toà nhà</Label>
          <SearchableSelect value={buildingId} onValueChange={setBuildingId} options={buildingOpts}
            placeholder="Chọn toà nhà" emptyText="Không có toà nhà" />
        </div>

        {building ? (
          <>
            <SaleImageManager value={draft} onChange={setDraft} />
            <div className="flex justify-end">
              <Button disabled={updateBuilding.isPending}
                onClick={() => updateBuilding.mutate({ id: building.id, updates: { images: draft } })}>
                Lưu ảnh toà nhà
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Chọn toà nhà để quản lý ảnh.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SaleImagesTab() {
  return (
    <div className="space-y-4">
      <RoomImagesSection />
      <BuildingImagesSection />
    </div>
  );
}
