import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { uniqueRoomNames, roomIdsByName, roomNameFromIds } from "@/lib/roomSort";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useAccounts } from "@/hooks/useAccounts";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useStaffUsers } from "@/hooks/useStaffUsers";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";

interface IncomeExpenseFilterPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: IncomeExpenseFilters;
  onApply: (next: IncomeExpenseFilters) => void;
  /** Filters trống — dùng khi Reset (giữ approval_status mặc định "ALL_ACTIVE"). */
  emptyFilters: IncomeExpenseFilters;
  /** Vị trí drawer: desktop "right", mobile "bottom" */
  side?: "right" | "bottom";
}

const STATUS_OPTIONS = [
  { value: "ALL_ACTIVE", label: "Tất cả" },
  { value: "APPROVED", label: "Đã ghi nhận" },
  { value: "UNAPPROVED", label: "Nháp" },
  { value: "CANCELLED", label: "Đã huỷ" },
] as const;

const TYPE_OPTIONS = [
  { value: "ALL", label: "Tất cả" },
  { value: "INCOME", label: "Phiếu thu" },
  { value: "EXPENSE", label: "Phiếu chi" },
] as const;

const VERIFIED_OPTIONS = [
  { value: "ALL", label: "Tất cả" },
  { value: "VERIFIED", label: "Đã check" },
  { value: "UNVERIFIED", label: "Chưa check" },
] as const;

const SEG_BUTTON =
  "flex-1 px-3 py-1.5 text-sm rounded-md transition-colors border";
const SEG_ACTIVE = "bg-primary text-primary-foreground border-primary";
const SEG_IDLE = "bg-background hover:bg-accent border-input";

export function IncomeExpenseFilterPanel({
  open,
  onOpenChange,
  filters,
  onApply,
  emptyFilters,
  side = "right",
}: IncomeExpenseFilterPanelProps) {
  // Local draft — chỉ commit khi bấm "Áp dụng"
  const [draft, setDraft] = useState<IncomeExpenseFilters>(filters);

  useEffect(() => {
    if (open) setDraft(filters);
  }, [open, filters]);

  const { data: areas } = useAreas();
  const { data: allBuildings } = useBuildings({ includeVirtual: true });
  const { data: rooms } = useRooms(draft.building_id ?? undefined);
  const { data: accounts } = useAccounts();
  const { data: incomeTypes } = useIncomeExpenseTypes("income");
  const { data: expenseTypes } = useIncomeExpenseTypes("expense");
  const { data: staffUsers } = useStaffUsers();

  const filteredBuildings = draft.area_id
    ? (allBuildings || []).filter((b) => b.area_id === draft.area_id)
    : allBuildings || [];

  const patch = (p: Partial<IncomeExpenseFilters>) =>
    setDraft((d) => ({ ...d, ...p }));

  const handleReset = () => {
    setDraft(emptyFilters);
  };

  const handleApply = () => {
    onApply(draft);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={
          side === "bottom"
            ? "h-[90vh] w-full p-0 flex flex-col rounded-t-2xl"
            : "sm:max-w-md w-full p-0 flex flex-col"
        }
      >
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle>Bộ lọc</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Thời gian */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Thời gian</Label>
            <div className="grid grid-cols-2 gap-2">
              <DateInput
                value={draft.start_date ?? ""}
                onChange={(v) => patch({ start_date: v || null })}
                placeholder="Từ ngày"
              />
              <DateInput
                value={draft.end_date ?? ""}
                onChange={(v) => patch({ end_date: v || null })}
                placeholder="Đến ngày"
              />
            </div>
          </div>

          {/* Trạng thái — segmented control */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Trạng thái</Label>
            <div className="flex gap-2">
              {STATUS_OPTIONS.map((opt) => {
                const active =
                  (draft.approval_status ?? "ALL_ACTIVE") === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${SEG_BUTTON} ${active ? SEG_ACTIVE : SEG_IDLE}`}
                    onClick={() =>
                      patch({
                        approval_status: opt.value as
                          | "ALL_ACTIVE"
                          | "APPROVED"
                          | "UNAPPROVED"
                          | "CANCELLED",
                      })
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Kiểm tra — segmented control */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Kiểm tra</Label>
            <div className="flex gap-2">
              {VERIFIED_OPTIONS.map((opt) => {
                const current = draft.verified_status ?? "ALL";
                const active = current === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${SEG_BUTTON} ${active ? SEG_ACTIVE : SEG_IDLE}`}
                    onClick={() =>
                      patch({
                        verified_status:
                          opt.value === "ALL"
                            ? null
                            : (opt.value as "VERIFIED" | "UNVERIFIED"),
                      })
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Loại phiếu — segmented control */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Loại phiếu</Label>
            <div className="flex gap-2">
              {TYPE_OPTIONS.map((opt) => {
                const current = draft.type ?? "ALL";
                const active = current === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${SEG_BUTTON} ${active ? SEG_ACTIVE : SEG_IDLE}`}
                    onClick={() =>
                      patch({
                        type:
                          opt.value === "ALL"
                            ? null
                            : (opt.value as "INCOME" | "EXPENSE"),
                      })
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Khu vực */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Khu vực</Label>
            <SearchableSelect
              value={draft.area_id ?? "ALL"}
              onValueChange={(v) =>
                patch({
                  area_id: v === "ALL" ? null : v,
                  building_id: null,
                  room_id: null,
                  room_ids: null,
                })
              }
              placeholder="Chọn khu vực"
              options={[
                { value: "ALL", label: "Tất cả khu vực" },
                ...(areas || []).map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          </div>

          {/* Tòa nhà */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Tòa nhà</Label>
            <SearchableSelect
              value={draft.building_id ?? "ALL"}
              onValueChange={(v) =>
                patch({
                  building_id: v === "ALL" ? null : v,
                  room_id: null,
                  room_ids: null,
                })
              }
              placeholder="Chọn tòa nhà"
              options={[
                { value: "ALL", label: "Tất cả tòa nhà" },
                ...filteredBuildings.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
          </div>

          {/* Phòng — gộp theo tên (nhiều toà cùng "101" → 1 mục) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Phòng</Label>
            <SearchableSelect
              value={
                roomNameFromIds(rooms || [], draft.room_ids) ??
                (draft.room_id
                  ? (rooms || []).find((r) => r.id === draft.room_id)?.name
                  : undefined) ??
                "ALL"
              }
              onValueChange={(name) =>
                patch({
                  room_id: null,
                  room_ids:
                    name === "ALL" ? null : roomIdsByName(rooms || [], name),
                })
              }
              placeholder="Chọn phòng"
              options={[
                { value: "ALL", label: "Tất cả phòng" },
                ...uniqueRoomNames(rooms || []).map((n) => ({
                  value: n,
                  label: n,
                })),
              ]}
            />
          </div>

          {/* Sổ quỹ */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Sổ quỹ</Label>
            <SearchableSelect
              value={draft.account_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ account_id: v === "ALL" ? null : v })
              }
              placeholder="Chọn sổ quỹ"
              options={[
                { value: "ALL", label: "Tất cả sổ quỹ" },
                ...(accounts || []).map((acc) => ({ value: acc.id, label: acc.name })),
              ]}
            />
          </div>

          {/* Hạng mục thu */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Hạng mục thu</Label>
            <SearchableSelect
              value={draft.income_type_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ income_type_id: v === "ALL" ? null : v })
              }
              placeholder="Tất cả hạng mục thu"
              options={[
                { value: "ALL", label: "Tất cả hạng mục thu" },
                ...(incomeTypes || []).map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          </div>

          {/* Hạng mục chi */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Hạng mục chi</Label>
            <SearchableSelect
              value={draft.expense_type_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ expense_type_id: v === "ALL" ? null : v })
              }
              placeholder="Tất cả hạng mục chi"
              options={[
                { value: "ALL", label: "Tất cả hạng mục chi" },
                ...(expenseTypes || []).map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          </div>

          {/* Người tạo phiếu */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Người tạo phiếu</Label>
            <SearchableSelect
              value={draft.creator_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ creator_id: v === "ALL" ? null : v })
              }
              placeholder="Tất cả người tạo"
              options={[
                { value: "ALL", label: "Tất cả người tạo" },
                ...(staffUsers || []).map((u) => ({
                  value: u.id,
                  label: u.full_name || u.email || "—",
                })),
              ]}
            />
          </div>
        </div>

        <div className="flex gap-2 px-5 py-4 border-t bg-background">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleReset}
            type="button"
          >
            Reset
          </Button>
          <Button className="flex-1" onClick={handleApply} type="button">
            Áp dụng
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default IncomeExpenseFilterPanel;
