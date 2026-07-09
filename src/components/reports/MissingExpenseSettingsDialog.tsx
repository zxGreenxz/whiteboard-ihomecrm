import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { FIXED_EXPENSE_CATEGORIES } from "@/lib/fixedExpenseCategories";
import { useUpdateBuilding } from "@/hooks/useBuildings";

// Toà đang cấu hình — lấy từ danh sách useBuildings (select *) của trang báo cáo.
interface BuildingForSettings {
  id: string;
  name: string | null;
  has_elevator?: boolean | null;
  hidden_fixed_expenses?: string[] | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  building: BuildingForSettings | null;
}

/**
 * Cài đặt cảnh báo "chưa có phiếu" (dòng vàng panel Khoản chi) theo TỪNG toà —
 * bỏ chọn hạng mục toà không dùng (vd toà xài nước giếng → tắt Nước) để khỏi
 * báo thiếu oan hằng tháng. Lưu vào buildings.hidden_fixed_expenses (mảng key
 * của FIXED_EXPENSE_CATEGORIES) — cấu hình chung mọi user, desktop + mobile.
 */
export default function MissingExpenseSettingsDialog({ open, onOpenChange, building }: Props) {
  const updateBuilding = useUpdateBuilding();
  // Tập key ĐANG TẮT cảnh báo — khởi tạo lại từ building mỗi lần mở dialog.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) setHidden(new Set(building?.hidden_fixed_expenses ?? []));
  }, [open, building]);

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const save = () => {
    if (!building) return;
    updateBuilding.mutate(
      // Cột mới chưa có trong generated types (types.ts chưa regenerate) → cast.
      { id: building.id, updates: { hidden_fixed_expenses: Array.from(hidden) } as any },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cảnh báo thiếu phiếu chi — {building?.name ?? ""}</DialogTitle>
          <DialogDescription>
            Bỏ chọn hạng mục toà này <b>không dùng</b> (vd xài nước giếng thì bỏ
            chọn Nước) — báo cáo sẽ không tô vàng &quot;chưa có phiếu&quot; hạng
            mục đó nữa. Áp dụng cho mọi người xem toà này.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          {FIXED_EXPENSE_CATEGORIES.map((cat) => {
            // Thang máy đã có cổng riêng theo cờ toà (has_elevator) — toà không
            // thang máy vốn không bao giờ báo, hiện dòng mờ cho khỏi thắc mắc.
            const gatedByElevator = !!cat.requiresElevator && !building?.has_elevator;
            return (
              <Label
                key={cat.key}
                htmlFor={`mes-${cat.key}`}
                className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-normal ${
                  gatedByElevator ? "opacity-50" : "cursor-pointer hover:bg-accent"
                }`}
              >
                <Checkbox
                  id={`mes-${cat.key}`}
                  checked={!hidden.has(cat.key)}
                  disabled={gatedByElevator}
                  onCheckedChange={() => toggle(cat.key)}
                />
                <span>{cat.label}</span>
                {gatedByElevator && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    toà không có thang máy — không báo
                  </span>
                )}
              </Label>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button onClick={save} disabled={updateBuilding.isPending || !building}>
            {updateBuilding.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
