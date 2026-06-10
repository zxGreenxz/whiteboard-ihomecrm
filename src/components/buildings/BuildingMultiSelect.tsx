import * as React from "react";
import { Check, ChevronDown, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { searchableSelectFilter } from "@/components/ui/searchable-select";
import { useBuildings } from "@/hooks/useBuildings";
import { useAreas } from "@/hooks/useAreas";
import {
  groupBuildingsByArea,
  groupSelectionState,
  toggleGroupSelection,
  toggleBuildingSelection,
  summarizeSelection,
  type BuildingLite,
  type AreaLite,
} from "@/lib/buildingGroups";

export interface BuildingMultiSelectProps {
  /** Danh sách building_id đã chọn. [] = tất cả (không lọc). */
  value: string[];
  onChange: (ids: string[]) => void;
  /**
   * Nguồn toà nhà. Mặc định tự useBuildings() — đã bị RLS cắt theo scope
   * staff nên staff chỉ thấy toà mình quản, không cần ẩn/khoá gì thêm.
   */
  buildings?: BuildingLite[];
  /** Nguồn khu vực. Mặc định tự useAreas(). */
  areas?: AreaLite[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  id?: string;
  "aria-label"?: string;
}

const triggerBaseClass =
  "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Bộ chọn NHIỀU toà nhà, nhóm theo Khu vực — component dùng chung cho mọi ô
 * lọc/scope nhiều toà (thay cặp dropdown "Khu vực" + "Toà nhà" đơn-chọn cũ).
 *
 * - Click TÊN KHU = chọn/bỏ cả nhóm toà (checkbox 3 trạng thái).
 * - Click toà = toggle toà đó. Dropdown không tự đóng khi chọn (chọn nhiều).
 * - Gõ để tìm theo tên toà + tên khu, không phân biệt dấu (theo quy ước
 *   SearchableSelect).
 * - [] = "Tất cả toà nhà". Khu vực chỉ là phím tắt chọn nhanh — sau khi chọn,
 *   bên ngoài chỉ biết tới danh sách building_id (RLS/quyền đều theo toà).
 * - N-N: 1 toà có thể thuộc nhiều khu → hiện lặp lại dưới MỖI khu chứa nó;
 *   tick ở đâu cũng đồng bộ (checked tính theo value.includes(building_id)).
 */
export function BuildingMultiSelect({
  value,
  onChange,
  buildings: buildingsProp,
  areas: areasProp,
  placeholder = "Tất cả toà nhà",
  className,
  disabled,
  align = "start",
  id,
  "aria-label": ariaLabel,
}: BuildingMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const { data: fetchedBuildings = [] } = useBuildings();
  const { data: fetchedAreas = [] } = useAreas();

  const buildings = React.useMemo<BuildingLite[]>(
    () =>
      buildingsProp ??
      (fetchedBuildings as any[]).map((b) => ({
        id: b.id,
        name: b.name,
        area_ids: b.area_ids ?? [],
      })),
    [buildingsProp, fetchedBuildings],
  );
  const areas = React.useMemo<AreaLite[]>(
    () =>
      areasProp ??
      (fetchedAreas as any[]).map((a) => ({ id: a.id, name: a.name })),
    [areasProp, fetchedAreas],
  );

  const groups = React.useMemo(
    () => groupBuildingsByArea(buildings, areas),
    [buildings, areas],
  );

  const label = React.useMemo(
    () => summarizeSelection(value, groups),
    [value, groups],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel ?? "Chọn toà nhà"}
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
                aria-label="Bỏ chọn tất cả"
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
        align={align}
        className="w-[--radix-popover-trigger-width] min-w-[260px] p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <Command filter={searchableSelectFilter}>
          <CommandInput
            placeholder="Tìm toà / khu vực..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>Không tìm thấy</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                keywords={["tất cả", "tat ca"]}
                onSelect={() => onChange([])}
                className="cursor-pointer font-medium"
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4 shrink-0",
                    value.length === 0 ? "opacity-100" : "opacity-0",
                  )}
                />
                Tất cả toà nhà
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            {groups.map((g) => {
              const ids = g.buildings.map((b) => b.id);
              const state = groupSelectionState(value, ids);
              return (
                <CommandGroup key={g.areaId ?? "__ungrouped__"}>
                  {/* Heading khu = item click được: chọn/bỏ cả nhóm */}
                  <CommandItem
                    value={`group:${g.areaId ?? "none"}`}
                    keywords={[g.areaName]}
                    onSelect={() => onChange(toggleGroupSelection(value, ids))}
                    className="cursor-pointer font-semibold text-foreground"
                  >
                    <span
                      className={cn(
                        "mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                        state !== "none"
                          ? "bg-primary text-primary-foreground"
                          : "opacity-50 [&_svg]:invisible",
                      )}
                    >
                      {state === "some" ? (
                        <Minus className="h-3 w-3" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                    </span>
                    {g.areaName}
                    <span className="ml-auto text-xs font-normal text-muted-foreground">
                      {g.buildings.length} toà
                    </span>
                  </CommandItem>
                  {g.buildings.map((b) => {
                    const checked = value.includes(b.id);
                    // value phải unique theo (khu, toà) — toà thuộc nhiều khu
                    // hiện ở nhiều nhóm, value trùng làm cmdk loạn highlight.
                    const itemValue = `${g.areaId ?? "none"}:${b.id}`;
                    return (
                      <CommandItem
                        key={itemValue}
                        value={itemValue}
                        keywords={[b.name, g.areaName]}
                        onSelect={() =>
                          onChange(toggleBuildingSelection(value, b.id))
                        }
                        className="cursor-pointer pl-7"
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4 shrink-0",
                            checked ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="line-clamp-1">{b.name}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default BuildingMultiSelect;
