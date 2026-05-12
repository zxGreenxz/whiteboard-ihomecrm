import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateInput } from "@/components/ui/date-input";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useAccounts } from "@/hooks/useAccounts";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";

interface IncomeExpenseFiltersProps {
  filters: IncomeExpenseFilters;
  onChange: (filters: IncomeExpenseFilters) => void;
}

export function IncomeExpenseFiltersBar({
  filters,
  onChange,
}: IncomeExpenseFiltersProps) {
  const { data: areas } = useAreas();
  const { data: allBuildings } = useBuildings({ includeVirtual: true });
  const { data: rooms } = useRooms(filters.building_id ?? undefined);
  const { data: accounts } = useAccounts();

  // Filter buildings by selected area
  const filteredBuildings = filters.area_id
    ? (allBuildings || []).filter((b) => b.area_id === filters.area_id)
    : allBuildings || [];

  const handleChange = (patch: Partial<IncomeExpenseFilters>) => {
    onChange({ ...filters, ...patch });
  };

  const handleAreaChange = (value: string) => {
    const areaId = value === "ALL" ? null : value;
    handleChange({
      area_id: areaId,
      building_id: null,
      room_id: null,
    });
  };

  const handleBuildingChange = (value: string) => {
    const buildingId = value === "ALL" ? null : value;
    handleChange({
      building_id: buildingId,
      room_id: null,
    });
  };

  const handleRoomChange = (value: string) => {
    const roomId = value === "ALL" ? null : value;
    handleChange({
      room_id: roomId,
    });
  };

  const handleAccountChange = (value: string) => {
    handleChange({ account_id: value === "ALL" ? null : value });
  };

  const handleTypeChange = (value: string) => {
    handleChange({
      type:
        value === "ALL"
          ? null
          : (value as "INCOME" | "EXPENSE"),
    });
  };

  const handleApprovalChange = (value: string) => {
    handleChange({
      approval_status: value as "UNAPPROVED" | "APPROVED" | "CANCELLED",
    });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Từ ngày */}
      <DateInput
        value={filters.start_date ?? ""}
        onChange={(v) => handleChange({ start_date: v || null })}
        className="w-[140px] h-9 text-sm"
        placeholder="Từ ngày"
      />

      {/* Đến ngày */}
      <DateInput
        value={filters.end_date ?? ""}
        onChange={(v) => handleChange({ end_date: v || null })}
        className="w-[140px] h-9 text-sm"
        placeholder="Đến ngày"
      />

      {/* Khu vực */}
      <Select
        value={filters.area_id ?? "ALL"}
        onValueChange={handleAreaChange}
      >
        <SelectTrigger className="w-[150px] h-9 text-sm">
          <SelectValue placeholder="Chọn khu vực" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Chọn khu vực</SelectItem>
          {(areas || []).map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Tòa nhà */}
      <Select
        value={filters.building_id ?? "ALL"}
        onValueChange={handleBuildingChange}
      >
        <SelectTrigger className="w-[150px] h-9 text-sm">
          <SelectValue placeholder="Chọn tòa nhà" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Chọn tòa nhà</SelectItem>
          {filteredBuildings.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Phòng */}
      <Select
        value={filters.room_id ?? "ALL"}
        onValueChange={handleRoomChange}
      >
        <SelectTrigger className="w-[140px] h-9 text-sm">
          <SelectValue placeholder="Chọn phòng" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Chọn phòng</SelectItem>
          {(rooms || []).map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Tài khoản */}
      <Select
        value={filters.account_id ?? "ALL"}
        onValueChange={handleAccountChange}
      >
        <SelectTrigger className="w-[150px] h-9 text-sm">
          <SelectValue placeholder="Sổ quỹ" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Sổ quỹ</SelectItem>
          {(accounts || []).map((acc) => (
            <SelectItem key={acc.id} value={acc.id}>
              {acc.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Loại phiếu */}
      <Select value={filters.type ?? "ALL"} onValueChange={handleTypeChange}>
        <SelectTrigger className="w-[140px] h-9 text-sm">
          <SelectValue placeholder="Loại phiếu" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Tất cả loại</SelectItem>
          <SelectItem value="INCOME">Phiếu thu</SelectItem>
          <SelectItem value="EXPENSE">Phiếu chi</SelectItem>
        </SelectContent>
      </Select>

      {/* Trạng thái — mặc định Đã ghi nhận */}
      <Select
        value={filters.approval_status ?? "APPROVED"}
        onValueChange={handleApprovalChange}
      >
        <SelectTrigger className="w-[160px] h-9 text-sm">
          <SelectValue placeholder="Trạng thái" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="APPROVED">Đã ghi nhận</SelectItem>
          <SelectItem value="UNAPPROVED">Nháp (chưa duyệt)</SelectItem>
          <SelectItem value="CANCELLED">Đã huỷ</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
