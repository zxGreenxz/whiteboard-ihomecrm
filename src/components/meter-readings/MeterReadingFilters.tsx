import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import type { Database } from "@/integrations/supabase/types";

type MeterType = Database["public"]["Enums"]["meter_type"];

export interface MeterReadingFilters {
  building_id: string | null;
  room_id: string | null;
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

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Tòa nhà */}
      <Select
        value={filters.building_id ?? "ALL"}
        onValueChange={(v) =>
          update({
            building_id: v === "ALL" ? null : v,
            room_id: null,
          })
        }
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Chọn tòa nhà" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Tất cả tòa nhà</SelectItem>
          {(buildings ?? []).map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Phòng (phụ thuộc Tòa nhà) */}
      <Select
        value={filters.room_id ?? "ALL"}
        onValueChange={(v) => update({ room_id: v === "ALL" ? null : v })}
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Chọn phòng" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Tất cả phòng</SelectItem>
          {(rooms ?? []).map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Loại công tơ */}
      <Select
        value={filters.meter_type ?? "ALL"}
        onValueChange={(v) =>
          update({ meter_type: v === "ALL" ? null : (v as MeterType) })
        }
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Loại công tơ" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Tất cả loại</SelectItem>
          {METER_TYPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Tháng chốt */}
      <Input
        type="month"
        className="w-[180px]"
        value={filters.month}
        onChange={(e) => update({ month: e.target.value })}
      />

      {/* Trạng thái duyệt */}
      <Select
        value={filters.status ?? "ALL"}
        onValueChange={(v) =>
          update({
            status: v === "ALL" ? null : (v as "APPROVED" | "UNAPPROVED"),
          })
        }
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Trạng thái" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Tất cả trạng thái</SelectItem>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
