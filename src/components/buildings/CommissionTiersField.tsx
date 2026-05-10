import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CommissionTier } from "@/types/building";

interface CommissionTiersFieldProps {
  value: CommissionTier[];
  onChange: (tiers: CommissionTier[]) => void;
}

export function CommissionTiersField({ value, onChange }: CommissionTiersFieldProps) {
  const tiers = Array.isArray(value) ? value : [];

  const updateTier = (idx: number, patch: Partial<CommissionTier>) => {
    onChange(tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  };

  const addTier = () => {
    onChange([...tiers, { min_months: 0, max_months: 0, rate_percent: 0 }]);
  };

  const removeTier = (idx: number) => {
    onChange(tiers.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label>Cấu hình hoa hồng môi giới</Label>
          <p className="text-xs text-muted-foreground mt-1">
            % tiền phòng trả cho môi giới theo số tháng hợp đồng. Số tháng nằm
            trong khoảng [Từ, Đến] sẽ áp dụng tỷ lệ tương ứng.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addTier}>
          <Plus className="h-4 w-4 mr-1" /> Thêm mốc
        </Button>
      </div>

      {tiers.length === 0 ? (
        <div className="border rounded-md p-4 text-center text-sm text-muted-foreground">
          Chưa có mốc hoa hồng. Bấm "Thêm mốc" để bắt đầu.
        </div>
      ) : (
        <div className="border rounded-md overflow-hidden">
          <div className="grid grid-cols-12 gap-2 p-2 bg-muted text-xs font-medium">
            <div className="col-span-3">Từ tháng</div>
            <div className="col-span-3">Đến tháng</div>
            <div className="col-span-4">% tiền phòng</div>
            <div className="col-span-2 text-right">Thao tác</div>
          </div>

          {tiers.map((tier, idx) => (
            <div
              key={idx}
              className="grid grid-cols-12 gap-2 p-2 items-center border-t"
            >
              <div className="col-span-3">
                <Input
                  type="number"
                  min={0}
                  className="h-8"
                  value={tier.min_months}
                  onChange={(e) =>
                    updateTier(idx, { min_months: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="col-span-3">
                <Input
                  type="number"
                  min={0}
                  className="h-8"
                  value={tier.max_months}
                  onChange={(e) =>
                    updateTier(idx, { max_months: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="col-span-4">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  className="h-8"
                  value={tier.rate_percent}
                  onChange={(e) =>
                    updateTier(idx, {
                      rate_percent: Number(e.target.value) || 0,
                    })
                  }
                />
              </div>
              <div className="col-span-2 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => removeTier(idx)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
