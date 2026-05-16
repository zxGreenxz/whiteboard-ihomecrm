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
import { useRooms } from "@/hooks/useRooms";
import { useDistinctVehicleValues } from "@/hooks/useVehicles";
import type { VehicleFilters } from "@/types/vehicle";

interface VehicleFilterPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: VehicleFilters;
  onApply: (next: VehicleFilters) => void;
  emptyFilters: VehicleFilters;
  side?: "right" | "bottom";
}

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
  const { data: rooms } = useRooms(draft.building_id);
  const { data: distinct } = useDistinctVehicleValues(draft.vehicle_type);

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
            ? "h-[85vh] w-full p-0 flex flex-col rounded-t-2xl"
            : "sm:max-w-md w-full p-0 flex flex-col"
        }
      >
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle>Bộ lọc</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Tòa nhà */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Tòa nhà</Label>
            <Select
              value={draft.building_id ?? "ALL"}
              onValueChange={(v) =>
                patch({
                  building_id: v === "ALL" ? undefined : v,
                  room_id: undefined,
                })
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

          {/* Phòng */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Phòng</Label>
            <Select
              value={draft.room_id ?? "ALL"}
              onValueChange={(v) =>
                patch({ room_id: v === "ALL" ? undefined : v })
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

          {/* Dòng xe */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Dòng xe</Label>
            <Select
              value={draft.vehicle_name ?? "ALL"}
              onValueChange={(v) =>
                patch({ vehicle_name: v === "ALL" ? undefined : v })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn dòng xe" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả dòng xe</SelectItem>
                {(distinct?.vehicleNames || []).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Màu */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Màu</Label>
            <Select
              value={draft.color ?? "ALL"}
              onValueChange={(v) =>
                patch({ color: v === "ALL" ? undefined : v })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn màu" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Tất cả màu</SelectItem>
                {(distinct?.colors || []).map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
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
