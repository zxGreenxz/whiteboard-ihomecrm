import { SearchableSelect } from "@/components/ui/searchable-select";
import { Input } from "@/components/ui/input";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { uniqueRoomNames, roomIdsByName, roomNameFromIds } from "@/lib/roomSort";
import type { Database } from "@/integrations/supabase/types";

type MeterType = Database["public"]["Enums"]["meter_type"];

export interface MeterReadingFilters {
  building_id: string | null;
  room_id: string | null;
  /** Lọc nhiều phòng cùng tên (gộp mọi toà). Ưu tiên hơn room_id. */
  room_ids?: string[] | null;
  meter_type: MeterType | null;
  month: string; // YYYY-MM
  status: "UNAPPROVED" | "APPROVED" | null;
}

interface MeterReadingFiltersProps {
  filters: MeterReadingFilters;
  onChange: (filters: MeterReadingFilters) => void;
}

const METER_TYPE_OPTIONS: { value: MeterType; label: string }[] = [
  { value: "ELECTRICITY", label: "Điện" },
  { value: "WATER", label: "Nước" },
  { value: "GAS", label: "Gas" },
];

const STATUS_OPTIONS: { value: "APPROVED" | "UNAPPROVED"; label: string }[] = [
  { value: "APPROVED", label: "Đã duyệt" },
  { value: "UNAPPROVED", label: "Chưa duyệt" },
];

export function MeterReadingFiltersBar({
  filters,
  onChange,
}: MeterReadingFiltersProps) {
  const { data: buildings } = useBuildings();
  const { data: rooms } = useRooms(filters.building_id ?? undefined);

  const update = (patch: Partial<MeterReadingFilters>) => {
    onChange({ ...filters, ...patch });
  };

  // Lọc theo TÊN phòng (gộp phòng cùng tên ở mọi toà nhà → 1 lựa chọn).
  const roomList = rooms ?? [];
  const roomValue =
    roomNameFromIds(roomList, filters.room_ids) ??
    (filters.room_id
      ? roomList.find((r) => r.id === filters.room_id)?.name
      : undefined) ??
    "ALL";

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Tòa nhà */}
      <SearchableSelect
        value={filters.building_id ?? "ALL"}
        onValueChange={(v) =>
          update({
            building_id: v === "ALL" ? null : v,
            room_id: null,
            room_ids: null,
          })
        }
        className="w-[200px]"
        placeholder="Chọn tòa nhà"
        options={[
          { value: "ALL", label: "Tất cả tòa nhà" },
          ...(buildings ?? []).map((b) => ({ value: b.id, label: b.name })),
        ]}
      />

      {/* Phòng — gộp theo tên (nhiều toà cùng "101" → 1 mục) */}
      <SearchableSelect
        value={roomValue}
        onValueChange={(name) =>
          update({
            room_id: null,
            room_ids: name === "ALL" ? null : roomIdsByName(roomList, name),
          })
        }
        className="w-[200px]"
        placeholder="Chọn phòng"
        options={[
          { value: "ALL", label: "Tất cả phòng" },
          ...uniqueRoomNames(roomList).map((n) => ({ value: n, label: n })),
        ]}
      />

      {/* Loại công tơ */}
      <SearchableSelect
        value={filters.meter_type ?? "ALL"}
        onValueChange={(v) =>
          update({ meter_type: v === "ALL" ? null : (v as MeterType) })
        }
        className="w-[160px]"
        placeholder="Loại công tơ"
        options={[
          { value: "ALL", label: "Tất cả loại" },
          ...METER_TYPE_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label,
          })),
        ]}
      />

      {/* Tháng chốt */}
      <Input
        type="month"
        className="w-[180px]"
        value={filters.month}
        onChange={(e) => update({ month: e.target.value })}
      />

      {/* Trạng thái duyệt */}
      <SearchableSelect
        value={filters.status ?? "ALL"}
        onValueChange={(v) =>
          update({
            status: v === "ALL" ? null : (v as "APPROVED" | "UNAPPROVED"),
          })
        }
        className="w-[180px]"
        placeholder="Trạng thái"
        options={[
          { value: "ALL", label: "Tất cả trạng thái" },
          ...STATUS_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label,
          })),
        ]}
      />
    </div>
  );
}
