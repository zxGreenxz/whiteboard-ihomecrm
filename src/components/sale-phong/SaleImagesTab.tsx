import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { X, Building2, DoorOpen } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useBuildings, useUpdateBuilding } from "@/hooks/useBuildings";
import { useRooms, useUpdateRoom } from "@/hooks/useRooms";
import SaleImageManager from "./SaleImageManager";

/** jsonb images/amenities (string[] | null | gì khác) → string[]. */
const toStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Tag-input nội thất/tiện ích (Input + Thêm + badges) — đồng bộ EditRoomDialog. */
function AmenityEditor({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [input, setInput] = useState("");
  const add = () => {
    const t = input.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setInput("");
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          placeholder="Nhập nội thất (VD: Máy lạnh, Tủ lạnh, Giường, Máy giặt...)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <Button type="button" variant="outline" onClick={add}>Thêm</Button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((item) => (
            <Badge key={item} variant="secondary" className="gap-1">
              {item}
              <button type="button" aria-label={`Xoá ${item}`} onClick={() => onChange(value.filter((a) => a !== item))}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">Chưa có nội thất nào. Danh sách này hiển thị ở mục "Nội thất" trong chi tiết phòng trên trang công khai.</p>
      )}
    </div>
  );
}

/** Thông tin Sale của TỪNG PHÒNG: nội thất + ảnh phòng. */
function RoomInfoSection() {
  const qc = useQueryClient();
  const { data: buildings } = useBuildings();
  const [buildingId, setBuildingId] = useState("");
  const { data: rooms } = useRooms(buildingId || undefined);
  const [roomId, setRoomId] = useState("");
  const updateRoom = useUpdateRoom();

  const room = useMemo(() => (rooms ?? []).find((r) => r.id === roomId), [rooms, roomId]);
  const [amenities, setAmenities] = useState<string[]>([]);
  const [images, setImages] = useState<string[]>([]);
  useEffect(() => {
    setAmenities(toStrArr(room?.amenities));
    setImages(toStrArr(room?.images));
  }, [room]);
  // Đổi toà → reset phòng đang chọn.
  useEffect(() => { setRoomId(""); }, [buildingId]);

  const buildingOpts = (buildings ?? []).map((b) => ({ value: b.id, label: `${b.name}${b.code && b.code !== b.name ? ` (${b.code})` : ""}` }));
  const roomOpts = (rooms ?? []).map((r) => ({
    value: r.id,
    label: `${r.name}${r.code ? ` · ${r.code}` : ""} — Tầng ${r.floor}`,
    keywords: `${r.name} ${r.code ?? ""}`,
  }));

  const save = () => {
    if (!room) return;
    updateRoom.mutate(
      { id: room.id, updates: { amenities: amenities.length > 0 ? amenities : null, images } },
      { onSuccess: () => qc.invalidateQueries({ queryKey: ["my-available-rooms"] }) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><DoorOpen className="h-4 w-4" />Thông tin phòng</CardTitle>
        <CardDescription>Nội thất và ảnh của từng phòng, hiển thị trong chi tiết phòng trên trang công khai.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
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
            <div className="space-y-2 pt-4 border-t">
              <Label>Nội thất</Label>
              <AmenityEditor value={amenities} onChange={setAmenities} />
            </div>
            <div className="space-y-2 pt-4 border-t">
              <Label>Ảnh phòng</Label>
              <SaleImageManager value={images} onChange={setImages} />
            </div>
            <div className="flex justify-end">
              <Button disabled={updateRoom.isPending} onClick={save}>
                {updateRoom.isPending ? "Đang lưu..." : "Lưu thông tin phòng"}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Chọn toà nhà và phòng để chỉnh sửa nội thất, ảnh.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Thông tin Sale của TOÀ NHÀ: liên hệ quản lý + ảnh bìa toà. */
function BuildingInfoSection() {
  const qc = useQueryClient();
  const { data: buildings } = useBuildings();
  const [buildingId, setBuildingId] = useState("");
  const updateBuilding = useUpdateBuilding();

  const building = useMemo(() => (buildings ?? []).find((b) => b.id === buildingId), [buildings, buildingId]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [images, setImages] = useState<string[]>([]);
  useEffect(() => {
    setContactName((building as any)?.public_contact_name ?? "");
    setContactPhone((building as any)?.public_contact_phone ?? "");
    setImages(toStrArr(building?.images));
  }, [building]);

  const buildingOpts = (buildings ?? []).map((b) => ({ value: b.id, label: `${b.name}${b.code && b.code !== b.name ? ` (${b.code})` : ""}` }));

  const save = () => {
    if (!building) return;
    updateBuilding.mutate(
      {
        id: building.id,
        updates: {
          public_contact_name: contactName.trim() || null,
          public_contact_phone: contactPhone.trim() || null,
          images,
        },
      },
      { onSuccess: () => qc.invalidateQueries({ queryKey: ["my-available-rooms"] }) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" />Thông tin toà nhà</CardTitle>
        <CardDescription>SĐT liên hệ quản lý và ảnh bìa của toà, hiển thị ở đầu mỗi toà trên trang công khai.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5 sm:max-w-sm">
          <Label>Toà nhà</Label>
          <SearchableSelect value={buildingId} onValueChange={setBuildingId} options={buildingOpts}
            placeholder="Chọn toà nhà" emptyText="Không có toà nhà" />
        </div>

        {building ? (
          <>
            <div className="space-y-3 pt-4 border-t">
              <Label>Liên hệ quản lý toà</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground font-normal">Người liên hệ</Label>
                  <Input placeholder="VD: A. Tâm (QL toà)" value={contactName}
                    onChange={(e) => setContactName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground font-normal">Số điện thoại</Label>
                  <Input type="tel" inputMode="tel" placeholder="VD: 0901234567" value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Ưu tiên hiển thị cho phòng thuộc toà này (gọi/Zalo). Để trống sẽ dùng hotline chung ở "Cài đặt hiển thị".
              </p>
            </div>

            <div className="space-y-2 pt-4 border-t">
              <Label>Ảnh toà nhà</Label>
              <SaleImageManager value={images} onChange={setImages} />
            </div>

            <div className="flex justify-end">
              <Button disabled={updateBuilding.isPending} onClick={save}>
                {updateBuilding.isPending ? "Đang lưu..." : "Lưu thông tin toà nhà"}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Chọn toà nhà để chỉnh sửa liên hệ, ảnh.</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Tab "Thông tin Sale": gom thông tin hiển thị trang công khai "Phòng trống"
 * theo 2 cấp — Toà nhà (liên hệ quản lý + ảnh bìa) và Phòng (nội thất + ảnh).
 * Bố cục responsive (shadcn Card + grid) dùng tốt trên cả desktop lẫn mobile.
 */
export default function SaleImagesTab() {
  return (
    <div className="space-y-4">
      <BuildingInfoSection />
      <RoomInfoSection />
    </div>
  );
}
