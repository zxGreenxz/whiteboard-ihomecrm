import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBuildings } from "@/hooks/useBuildings";
import type { VehicleFilters, VehicleType } from "@/types/vehicle";

interface VehicleFilterPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: VehicleFilters;
  onApply: (next: VehicleFilters) => void;
  emptyFilters: VehicleFilters;
  side?: "right" | "bottom";
}

const TYPE_OPTIONS: { value: VehicleType | "ALL"; label: string }[] = [
  { value: "ALL", label: "Tất cả" },
  { value: "MOTORBIKE", label: "Xe máy" },
  { value: "CAR", label: "Ô tô" },
  { value: "ELECTRIC_BIKE", label: "Xe điện" },
  { value: "BICYCLE", label: "Xe đạp" },
  { value: "OTHER", label: "Khác" },
];

const SEG_BUTTON =
  "flex-1 px-3 py-1.5 text-sm rounded-md transition-colors border";
const SEG_ACTIVE = "bg-primary text-primary-foreground border-primary";
const SEG_IDLE = "bg-background hover:bg-accent border-input";

export default function VehicleFilterPanel({
  open,
  onOpenChange,
  filters,
  onApply,
  emptyFilters,
  side = "bottom",
}: VehicleFilterPanelProps) {
  const [draft, setDraft] = useState<VehicleFilters>(filters);

  useEffect(() => {
    if (open) setDraft(filters);
  }, [open, filters]);

  const { data: buildings } = useBuildings();

  const patch = (p: Partial<VehicleFilters>) =>
    setDraft((d) => ({ ...d, ...p }));

  const handleReset = () => setDraft(emptyFilters);

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
            ? "h-[80vh] w-full p-0 flex flex-col rounded-t-2xl"
            : "sm:max-w-md w-full p-0 flex flex-col"
        }
      >
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle>Bộ lọc</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Loại xe — segmented control 2 hàng */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Loại phương tiện</Label>
            <div className="grid grid-cols-3 gap-2">
              {TYPE_OPTIONS.map((opt) => {
                const current = draft.vehicle_type ?? "ALL";
                const active = current === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${SEG_BUTTON} ${active ? SEG_ACTIVE : SEG_IDLE}`}
                    onClick={() =>
                      patch({
                        vehicle_type:
                          opt.value === "ALL"
                            ? undefined
                            : (opt.value as VehicleType),
                      })
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tòa nhà */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Tòa nhà</Label>
            <Select
              value={draft.building_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ building_id: v === "ALL" ? undefined : v })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn tòa nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả tòa nhà</SelectItem>
                {(buildings || []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
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
