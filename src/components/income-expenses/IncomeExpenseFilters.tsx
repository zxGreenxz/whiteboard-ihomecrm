import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateInput } from "@/components/ui/date-input";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useAccounts } from "@/hooks/useAccounts";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useStaffUsers } from "@/hooks/useStaffUsers";
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
  const { data: incomeTypes } = useIncomeExpenseTypes("income");
  const { data: expenseTypes } = useIncomeExpenseTypes("expense");
  const { data: staffUsers } = useStaffUsers();

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

  const handleIncomeTypeChange = (value: string) => {
    handleChange({ income_type_id: value === "ALL" ? null : value });
  };

  const handleExpenseTypeChange = (value: string) => {
    handleChange({ expense_type_id: value === "ALL" ? null : value });
  };

  const handleCreatorChange = (value: string) => {
    handleChange({ creator_id: value === "ALL" ? null : value });
  };

  const handleVerifiedChange = (value: string) => {
    handleChange({
      verified_status:
        value === "ALL"
          ? null
          : (value as "VERIFIED" | "UNVERIFIED"),
    });
  };

  const handleApprovalChange = (value: string) => {
    handleChange({
      approval_status: value as
        | "UNAPPROVED"
        | "APPROVED"
        | "CANCELLED"
        | "ALL_ACTIVE",
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
      <SearchableSelect
        value={filters.area_id ?? "ALL"}
        onValueChange={handleAreaChange}
        className="w-[150px] h-9 text-sm"
        placeholder="Chọn khu vực"
        options={[
          { value: "ALL", label: "Chọn khu vực" },
          ...(areas || []).map((a) => ({ value: a.id, label: a.name })),
        ]}
      />

      {/* Tòa nhà */}
      <SearchableSelect
        value={filters.building_id ?? "ALL"}
        onValueChange={handleBuildingChange}
        className="w-[150px] h-9 text-sm"
        placeholder="Chọn tòa nhà"
        options={[
          { value: "ALL", label: "Chọn tòa nhà" },
          ...filteredBuildings.map((b) => ({ value: b.id, label: b.name })),
        ]}
      />

      {/* Phòng */}
      <SearchableSelect
        value={filters.room_id ?? "ALL"}
        onValueChange={handleRoomChange}
        className="w-[140px] h-9 text-sm"
        placeholder="Chọn phòng"
        options={[
          { value: "ALL", label: "Chọn phòng" },
          ...(rooms || []).map((r) => ({ value: r.id, label: r.name })),
        ]}
      />

      {/* Tài khoản */}
      <SearchableSelect
        value={filters.account_id ?? "ALL"}
        onValueChange={handleAccountChange}
        className="w-[150px] h-9 text-sm"
        placeholder="Sổ quỹ"
        options={[
          { value: "ALL", label: "Sổ quỹ" },
          ...(accounts || []).map((acc) => ({ value: acc.id, label: acc.name })),
        ]}
      />

      {/* Hạng mục thu */}
      <SearchableSelect
        value={filters.income_type_id ?? "ALL"}
        onValueChange={handleIncomeTypeChange}
        className="w-[160px] h-9 text-sm"
        placeholder="Hạng mục thu"
        options={[
          { value: "ALL", label: "Hạng mục thu" },
          ...(incomeTypes || []).map((t) => ({ value: t.id, label: t.name })),
        ]}
      />

      {/* Hạng mục chi */}
      <SearchableSelect
        value={filters.expense_type_id ?? "ALL"}
        onValueChange={handleExpenseTypeChange}
        className="w-[160px] h-9 text-sm"
        placeholder="Hạng mục chi"
        options={[
          { value: "ALL", label: "Hạng mục chi" },
          ...(expenseTypes || []).map((t) => ({ value: t.id, label: t.name })),
        ]}
      />

      {/* Loại phiếu */}
      <SearchableSelect
        value={filters.type ?? "ALL"}
        onValueChange={handleTypeChange}
        className="w-[140px] h-9 text-sm"
        placeholder="Loại phiếu"
        options={[
          { value: "ALL", label: "Tất cả loại" },
          { value: "INCOME", label: "Phiếu thu" },
          { value: "EXPENSE", label: "Phiếu chi" },
        ]}
      />

      {/* Người tạo phiếu */}
      <SearchableSelect
        value={filters.creator_id ?? "ALL"}
        onValueChange={handleCreatorChange}
        className="w-[150px] h-9 text-sm"
        placeholder="Người tạo"
        options={[
          { value: "ALL", label: "Người tạo" },
          ...(staffUsers || []).map((u) => ({
            value: u.id,
            label: u.full_name || u.email || "—",
          })),
        ]}
      />

      {/* Đã kiểm tra */}
      <SearchableSelect
        value={filters.verified_status ?? "ALL"}
        onValueChange={handleVerifiedChange}
        className="w-[140px] h-9 text-sm"
        placeholder="Kiểm tra"
        options={[
          { value: "ALL", label: "Tất cả" },
          { value: "VERIFIED", label: "Đã check" },
          { value: "UNVERIFIED", label: "Chưa check" },
        ]}
      />

      {/* Trạng thái — mặc định Tất cả (Đã ghi nhận + Nháp) */}
      <SearchableSelect
        value={filters.approval_status ?? "ALL_ACTIVE"}
        onValueChange={handleApprovalChange}
        className="w-[160px] h-9 text-sm"
        placeholder="Trạng thái"
        options={[
          { value: "ALL_ACTIVE", label: "Tất cả" },
          { value: "APPROVED", label: "Đã ghi nhận" },
          { value: "UNAPPROVED", label: "Nháp (chưa duyệt)" },
          { value: "CANCELLED", label: "Đã huỷ" },
        ]}
      />
    </div>
  );
}
