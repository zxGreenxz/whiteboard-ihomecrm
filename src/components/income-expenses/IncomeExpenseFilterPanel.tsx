import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useBeds } from "@/hooks/useBeds";
import { useAccounts } from "@/hooks/useAccounts";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";

interface IncomeExpenseFilterPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: IncomeExpenseFilters;
  onApply: (next: IncomeExpenseFilters) => void;
  /** Filters trống — dùng khi Reset (giữ approval_status mặc định "APPROVED"). */
  emptyFilters: IncomeExpenseFilters;
  /** Vị trí drawer: desktop "right", mobile "bottom" */
  side?: "right" | "bottom";
}

const STATUS_OPTIONS = [
  { value: "APPROVED", label: "Đã ghi nhận" },
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
  const { data: allBuildings } = useBuildings();
  const { data: rooms } = useRooms(draft.building_id ?? undefined);
  const { data: beds } = useBeds(draft.room_id ?? undefined);
  const { data: accounts } = useAccounts();
  const { data: types } = useIncomeExpenseTypes();

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
              <Input
                type="date"
                value={draft.start_date ?? ""}
                onChange={(e) =>
                  patch({ start_date: e.target.value || null })
                }
                placeholder="Từ ngày"
              />
              <Input
                type="date"
                value={draft.end_date ?? ""}
                onChange={(e) =>
                  patch({ end_date: e.target.value || null })
                }
                placeholder="Đến ngày"
              />
            </div>
          </div>

          {/* Trạng thái — segmented control */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Trạng thái</Label>
            <div className="flex gap-2">
              {STATUS_OPTIONS.map((opt) => {
                const active = (draft.approval_status ?? "APPROVED") === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${SEG_BUTTON} ${active ? SEG_ACTIVE : SEG_IDLE}`}
                    onClick={() =>
                      patch({
                        approval_status: opt.value as
                          | "APPROVED"
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
                  bed_id: null,
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
                  bed_id: null,
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
                  bed_id: null,
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

          {/* Giường */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Giường</Label>
            <Select
              value={draft.bed_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ bed_id: v === "ALL" ? null : v })
              }
              disabled={!draft.room_id}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn giường" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả giường</SelectItem>
                {(beds || []).map((bed) => (
                  <SelectItem key={bed.id} value={bed.id}>
                    {bed.name}
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

          {/* Loại thu chi (placeholder — chưa map filter, để tham khảo Resident) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-muted-foreground">
              Loại thu chi
            </Label>
            <Select disabled>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    types && types.length
                      ? `Có ${types.length} loại — sắp hỗ trợ lọc`
                      : "Loại thu chi"
                  }
                />
              </SelectTrigger>
              <SelectContent />
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
