import * as React from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { searchableSelectFilter } from "@/components/ui/searchable-select";
import { useAreas } from "@/hooks/useAreas";

export interface AreaMultiSelectProps {
  /** Danh sách area_id đã chọn. */
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

const triggerBaseClass =
  "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Bộ chọn NHIỀU khu vực — dùng cho phạm vi nhân viên theo nhóm (LIVE):
 * gán khu thay vì tick từng toà; toà thêm/bớt khỏi khu sau này tự đổi phạm vi
 * (DB resolve qua area_buildings, không snapshot). Style đồng bộ
 * BuildingMultiSelect.
 */
export function AreaMultiSelect({
  value,
  onChange,
  placeholder = "Chọn khu vực",
  className,
  disabled,
  id,
}: AreaMultiSelectProps) {
  const [open, setOpen] = React.useState(false);

  const { data: areasData } = useAreas();
  const areas = React.useMemo(
    () =>
      (Array.isArray(areasData) ? (areasData as any[]) : []).map((a) => ({
        id: a.id as string,
        name: a.name as string,
        buildingsCount: (a.buildings_count as number) ?? 0,
      })),
    [areasData],
  );

  const label = React.useMemo(() => {
    if (value.length === 0) return "";
    const names = areas
      .filter((a) => value.includes(a.id))
      .map((a) => a.name);
    return names.join(", ") || `${value.length} khu`;
  }, [value, areas]);

  const toggle = (areaId: string) => {
    onChange(
      value.includes(areaId)
        ? value.filter((x) => x !== areaId)
        : [...value, areaId],
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label="Chọn khu vực"
          disabled={disabled}
          className={cn(triggerBaseClass, className)}
        >
          <span
            className={cn(
              "line-clamp-1 text-left",
              !label && "text-muted-foreground",
            )}
          >
            {label || placeholder}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {value.length > 0 && (
              <X
                className="h-4 w-4 opacity-50 hover:opacity-100"
                aria-label="Bỏ chọn tất cả khu"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange([]);
                }}
              />
            )}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[--radix-popover-trigger-width] min-w-[240px] p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <Command filter={searchableSelectFilter}>
          <CommandInput placeholder="Tìm khu vực..." />
          <CommandList>
            <CommandEmpty>
              {areas.length === 0
                ? "Chưa có khu vực nào — tạo ở Toà nhà → Quản lý khu vực"
                : "Không tìm thấy"}
            </CommandEmpty>
            <CommandGroup>
              {areas.map((a) => {
                const checked = value.includes(a.id);
                return (
                  <CommandItem
                    key={a.id}
                    value={a.id}
                    keywords={[a.name]}
                    onSelect={() => toggle(a.id)}
                    className="cursor-pointer"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 shrink-0",
                        checked ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="line-clamp-1">{a.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {a.buildingsCount} toà
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default AreaMultiSelect;
