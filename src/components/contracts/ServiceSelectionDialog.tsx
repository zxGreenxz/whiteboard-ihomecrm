import { useState, useMemo, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Loader2 } from "lucide-react";
import { useServices } from "@/hooks/useServices";

export interface ServiceBasic {
  id: string;
  name: string;
  unit_price: number;
  unit: string | null;
  type: string;
  pricing_type: string | null;
}

interface ServiceSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedServiceIds: string[];
  onSelect: (services: ServiceBasic[]) => void;
  buildingId?: string;
}

function formatVND(amount: number): string {
  return new Intl.NumberFormat("vi-VN").format(amount) + " đ";
}

export function ServiceSelectionDialog({
  open,
  onOpenChange,
  selectedServiceIds,
  onSelect,
  buildingId,
}: ServiceSelectionDialogProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  // Hiển thị TOÀN BỘ dịch vụ trong danh mục (page Dịch vụ), không lọc theo
  // toà — để user gán bất kỳ dịch vụ nào cho HĐ (vd loại điện khác mặc định
  // toà). buildingId chỉ dùng để gắn nhãn "toà" cho dịch vụ là mặc định.
  const { data: services = [], isLoading } = useServices();

  // Reset checked state when dialog opens
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setCheckedIds(new Set(selectedServiceIds));
        setSearchTerm("");
      }
      onOpenChange(nextOpen);
    },
    [selectedServiceIds, onOpenChange]
  );

  // Filter services by search term (name)
  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return services;
    const term = searchTerm.trim().toLowerCase();
    return services.filter((s) => s.name?.toLowerCase().includes(term));
  }, [services, searchTerm]);

  const toggleService = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const selected: ServiceBasic[] = services
      .filter((s) => checkedIds.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        unit_price: s.unit_price,
        unit: s.unit ?? null,
        type: s.type,
        pricing_type: s.pricing_type ?? null,
      }));
    onSelect(selected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Chọn dịch vụ</DialogTitle>
        </DialogHeader>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm theo tên dịch vụ..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Service list */}
        <ScrollArea className="h-[360px] border rounded-md">
          {isLoading ? (
            <div className="flex items-center justify-center h-full py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full py-10 text-sm text-muted-foreground">
              Không tìm thấy dịch vụ
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map((service) => {
                const isChecked = checkedIds.has(service.id);
                return (
                  <label
                    key={service.id}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleService(service.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate flex items-center gap-2">
                        <span className="truncate">{service.name}</span>
                        {buildingId &&
                          (service as any).building_services?.some(
                            (bs: { building_id: string; is_active: boolean }) =>
                              bs.building_id === buildingId && bs.is_active,
                          ) && (
                            <span className="shrink-0 text-[10px] font-normal bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                              toà
                            </span>
                          )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatVND(service.unit_price)}
                        {service.unit && ` / ${service.unit}`}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button onClick={handleConfirm}>
            Xác nhận{checkedIds.size > 0 && ` (${checkedIds.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
