import { useState, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { SlidersHorizontal, X } from "lucide-react";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";

interface IncomeExpenseFiltersProps {
  filters: IncomeExpenseFilters;
  onChange: (filters: IncomeExpenseFilters) => void;
}

const TYPE_OPTIONS = [
  { value: "INCOME", label: "Phiếu thu" },
  { value: "EXPENSE", label: "Phiếu chi" },
] as const;

const APPROVAL_STATUS_OPTIONS = [
  { value: "APPROVED", label: "Đã duyệt" },
  { value: "UNAPPROVED", label: "Chưa duyệt" },
] as const;

const EMPTY_FILTERS: IncomeExpenseFilters = {
  building_id: null,
  room_id: null,
  cash_book_id: null,
  type: null,
  start_date: null,
  end_date: null,
  approval_status: null,
};

export function IncomeExpenseFiltersBar({
  filters,
  onChange,
}: IncomeExpenseFiltersProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localFilters, setLocalFilters] = useState<IncomeExpenseFilters>(filters);

  const { data: buildings } = useBuildings();
  const { data: rooms } = useRooms(localFilters.building_id ?? undefined);

  // Sync local state when parent filters change (e.g. external reset)
  useEffect(() => {
    setLocalFilters(filters);
  }, [filters]);

  const updateLocal = (patch: Partial<IncomeExpenseFilters>) => {
    setLocalFilters((prev) => ({ ...prev, ...patch }));
  };

  const applyFilters = () => {
    onChange(localFilters);
  };

  const clearFilters = () => {
    const cleared = { ...EMPTY_FILTERS };
    setLocalFilters(cleared);
    onChange(cleared);
  };

  const hasActiveFilters =
    filters.building_id ||
    filters.room_id ||
    filters.type ||
    filters.start_date ||
    filters.end_date ||
    filters.approval_status;

  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className={hasActiveFilters ? "border-primary text-primary" : ""}
      >
        <SlidersHorizontal className="h-4 w-4 mr-2" />
        Lọc
        {hasActiveFilters && (
          <span className="ml-1 h-5 w-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center">
            !
          </span>
        )}
      </Button>

      {isOpen && (
        <div className="mt-3 p-4 border rounded-lg bg-background space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {/* Căn hộ */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Căn hộ
              </label>
              <Select
                value={localFilters.building_id ?? "ALL"}
                onValueChange={(v) =>
                  updateLocal({
                    building_id: v === "ALL" ? null : v,
                    room_id: null,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn căn hộ" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Tất cả</SelectItem>
                  {(buildings || []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Phòng - cascade filtered by Căn hộ */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Phòng
              </label>
              <Select
                value={localFilters.room_id ?? "ALL"}
                onValueChange={(v) =>
                  updateLocal({ room_id: v === "ALL" ? null : v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn phòng" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Tất cả</SelectItem>
                  {(rooms || []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Sổ quỹ - placeholder */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Sổ quỹ
              </label>
              <Select value="ALL" disabled>
                <SelectTrigger>
                  <SelectValue placeholder="Chọn sổ quỹ" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Tất cả</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Loại phiếu */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Loại phiếu
              </label>
              <Select
                value={localFilters.type ?? "ALL"}
                onValueChange={(v) =>
                  updateLocal({
                    type:
                      v === "ALL"
                        ? null
                        : (v as "INCOME" | "EXPENSE"),
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Loại phiếu" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Tất cả</SelectItem>
                  {TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Từ ngày */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Từ ngày
              </label>
              <Input
                type="date"
                value={localFilters.start_date ?? ""}
                onChange={(e) =>
                  updateLocal({
                    start_date: e.target.value || null,
                  })
                }
              />
            </div>

            {/* Đến ngày */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Đến ngày
              </label>
              <Input
                type="date"
                value={localFilters.end_date ?? ""}
                onChange={(e) =>
                  updateLocal({
                    end_date: e.target.value || null,
                  })
                }
              />
            </div>

            {/* Trạng thái duyệt */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Trạng thái duyệt
              </label>
              <Select
                value={localFilters.approval_status ?? "ALL"}
                onValueChange={(v) =>
                  updateLocal({
                    approval_status:
                      v === "ALL"
                        ? null
                        : (v as "APPROVED" | "UNAPPROVED"),
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Trạng thái" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Tất cả</SelectItem>
                  {APPROVAL_STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-2">
            <Button size="sm" onClick={applyFilters}>
              Áp dụng
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
            >
              <X className="h-4 w-4 mr-1" />
              Xoá bộ lọc
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
