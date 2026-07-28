import { SearchableSelect } from "@/components/ui/searchable-select";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import { uniqueRoomNames, roomIdsByName, roomNameFromIds } from "@/lib/roomSort";
import { DateInput } from "@/components/ui/date-input";
import { useRooms } from "@/hooks/useRooms";
import { useAccounts } from "@/hooks/useAccounts";
import {
  useIncomeExpenseTypes,
  useIncomeExpenseTypeCategories,
} from "@/hooks/useIncomeExpenseTypes";
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
  // Lọc toà đơn-chọn (BuildingFilterSelect) — state giữ shape mảng 0/1 phần tử.
  const buildingIds = filters.building_ids ?? [];
  // Phòng chỉ lọc được khi chọn đúng 1 toà (cascade phòng theo toà đơn).
  const singleBuildingId =
    buildingIds.length === 1 ? buildingIds[0] : undefined;

  const { data: rooms } = useRooms(singleBuildingId);
  const { data: accounts } = useAccounts();
  const { data: incomeTypes } = useIncomeExpenseTypes("income");
  const { data: expenseTypes } = useIncomeExpenseTypes("expense");
  const { data: typeCategories } = useIncomeExpenseTypeCategories();
  const { data: staffUsers } = useStaffUsers();

  const handleChange = (patch: Partial<IncomeExpenseFilters>) => {
    onChange({ ...filters, ...patch });
  };

  const handleBuildingIdsChange = (ids: string[]) => {
    handleChange({
      building_ids: ids,
      // Legacy single-select — null để không sót filter cũ
      building_id: null,
      // Đổi toà thì reset phòng (danh sách phòng phụ thuộc toà)
      room_id: null,
      room_ids: null,
    });
  };

  // Lọc theo TÊN phòng (gộp phòng cùng tên ở mọi toà nhà → 1 lựa chọn).
  const handleRoomChange = (name: string) => {
    handleChange({
      room_id: null,
      room_ids: name === "ALL" ? null : roomIdsByName(rooms || [], name),
    });
  };

  const roomValue =
    roomNameFromIds(rooms || [], filters.room_ids) ??
    (filters.room_id
      ? (rooms || []).find((r) => r.id === filters.room_id)?.name
      : undefined) ??
    "ALL";

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

  const handleTypeCategoryChange = (value: string) => {
    handleChange({ type_category: value === "ALL" ? null : value });
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
      approval_status: value as IncomeExpenseFilters["approval_status"],
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

      {/* Tòa nhà — 1 toà hoặc tất cả, danh sách phẳng A→Z */}
      {/*
        includeVirtual: phiếu thu chi GHI ĐƯỢC vào toà ảo ("Kho Văn Phòng
        Chung") qua form, nên ô lọc phải chọn được nó — thiếu cờ này thì 101
        phiếu của nó không lọc ra được ở đây (đo trên prod 27/07/2026).
      */}
      <BuildingFilterSelect
        value={buildingIds}
        onChange={handleBuildingIdsChange}
        includeVirtual
        className="w-full sm:w-[260px] h-9 text-sm"
      />

      {/* Phòng — chỉ enable khi chọn đúng 1 toà */}
      <SearchableSelect
        value={singleBuildingId ? roomValue : undefined}
        onValueChange={handleRoomChange}
        disabled={!singleBuildingId}
        className="w-[140px] h-9 text-sm"
        placeholder={
          singleBuildingId ? "Chọn phòng" : "Chọn đúng 1 tòa để lọc phòng"
        }
        options={[
          { value: "ALL", label: "Chọn phòng" },
          ...uniqueRoomNames(rooms || []).map((n) => ({ value: n, label: n })),
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

      {/* Nhóm (Loại) hạng mục */}
      <SearchableSelect
        value={filters.type_category ?? "ALL"}
        onValueChange={handleTypeCategoryChange}
        className="w-[170px] h-9 text-sm"
        placeholder="Nhóm (Loại)"
        options={[
          { value: "ALL", label: "Nhóm (Loại)" },
          ...(typeCategories || []).map((c) => ({ value: c, label: c })),
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
          { value: "UNAPPROVED", label: "Chờ duyệt" },
          // V2 §12.1: trạng thái composite duyệt × tiền.
          { value: "APPROVED_UNPOSTED", label: "Đã duyệt - Chưa thu/chi" },
          { value: "POSTED", label: "Đã thu/chi" },
          { value: "REVERSED", label: "Đã hoàn tác" },
          { value: "APPROVED", label: "Đã duyệt (tất cả)" },
          { value: "CANCELLED", label: "Đã huỷ" },
        ]}
      />
    </div>
  );
}
