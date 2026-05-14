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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useAccounts } from "@/hooks/useAccounts";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
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
            <Select
              value={draft.area_id ?? "ALL"}
              onValueChange={(v) =>
                patch({
                  area_id: v === "ALL" ? null : v,
                  building_id: null,
                  room_id: null,
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn khu vực" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả khu vực</SelectItem>
                {(areas || []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Tòa nhà */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Tòa nhà</Label>
            <Select
              value={draft.building_id ?? "ALL"}
              onValueChange={(v) =>
                patch({
                  building_id: v === "ALL" ? null : v,
                  room_id: null,
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn tòa nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả tòa nhà</SelectItem>
                {filteredBuildings.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Phòng */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Phòng</Label>
            <Select
              value={draft.room_id ?? "ALL"}
              onValueChange={(v) =>
                patch({
                  room_id: v === "ALL" ? null : v,
                })
              }
              disabled={!draft.building_id}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn phòng" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả phòng</SelectItem>
                {(rooms || []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Sổ quỹ */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Sổ quỹ</Label>
            <Select
              value={draft.account_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ account_id: v === "ALL" ? null : v })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn sổ quỹ" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả sổ quỹ</SelectItem>
                {(accounts || []).map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Hạng mục thu */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Hạng mục thu</Label>
            <Select
              value={draft.income_type_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ income_type_id: v === "ALL" ? null : v })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Tất cả hạng mục thu" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả hạng mục thu</SelectItem>
                {(incomeTypes || []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Hạng mục chi */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Hạng mục chi</Label>
            <Select
              value={draft.expense_type_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ expense_type_id: v === "ALL" ? null : v })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Tất cả hạng mục chi" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả hạng mục chi</SelectItem>
                {(expenseTypes || []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
