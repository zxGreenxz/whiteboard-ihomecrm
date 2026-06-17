import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn, normalizeVietnamese } from "@/lib/utils";
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

export interface SearchableSelectOption {
  /** Giá trị thật được emit qua onValueChange (id, enum...). */
  value: string;
  /** Nội dung hiển thị trong dropdown + trên trigger. */
  label: React.ReactNode;
  /** Text tìm kiếm thêm/thay thế. Mặc định lấy từ `label` nếu label là string. */
  keywords?: string | string[];
  disabled?: boolean;
  /**
   * Nhãn nhóm tuỳ chọn. Khi ít nhất một option có `group`, danh sách được gom
   * theo nhóm (heading hiển thị, thứ tự nhóm theo lần xuất hiện đầu tiên). cmdk
   * tự ẩn nhóm rỗng khi lọc.
   */
  group?: string;
}

export interface SearchableSelectProps {
  value?: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  /** Hiển thị khi chưa chọn gì (hoặc value không khớp option nào). */
  placeholder?: React.ReactNode;
  /** Placeholder cho ô tìm kiếm trong dropdown. */
  searchPlaceholder?: string;
  /** Text khi không tìm thấy option nào. */
  emptyText?: string;
  /** Class cho nút trigger (width, height... — ghi đè base như SelectTrigger). */
  className?: string;
  /** Class cho phần PopoverContent. */
  contentClassName?: string;
  disabled?: boolean;
  /** Bật/tắt ô tìm kiếm. Mặc định true (cho phép gõ để lọc nhanh). */
  searchable?: boolean;
  align?: "start" | "center" | "end";
  id?: string;
  "aria-label"?: string;
}

/** Text dùng để so khớp tìm kiếm của một option. */
function optionSearchText(opt: SearchableSelectOption): string[] {
  const extra = Array.isArray(opt.keywords)
    ? opt.keywords
    : opt.keywords
      ? [opt.keywords]
      : [];
  const labelText = typeof opt.label === "string" ? opt.label : "";
  return [labelText, ...extra].filter(Boolean);
}

/**
 * Filter cho cmdk: so khớp không phân biệt dấu tiếng Việt, hỗ trợ nhiều từ khoá
 * (mọi token trong query phải xuất hiện). Tách riêng để test thuần logic.
 * `value` ở đây là chuỗi tìm kiếm đã được nhồi sẵn (xem `SearchableSelect`).
 */
export function searchableSelectFilter(
  value: string,
  search: string,
  keywords?: string[],
): number {
  const haystack = normalizeVietnamese([value, ...(keywords ?? [])].join(" "));
  const terms = normalizeVietnamese(search).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;
  return terms.every((t) => haystack.includes(t)) ? 1 : 0;
}

const triggerBaseClass =
  "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Dropdown lọc có ô tìm kiếm (combobox). Thay thế trực tiếp cho `<Select>` ở các
 * ô lọc: click ra dropdown đầy đủ + gõ để tìm nhanh option. Trigger giữ nguyên
 * giao diện như `SelectTrigger`. Dữ liệu truyền qua `options` (cần để hiển thị
 * nhãn của value đang chọn ngay cả khi dropdown đóng).
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder = "Tìm...",
  emptyText = "Không tìm thấy",
  className,
  contentClassName,
  disabled,
  searchable = true,
  align = "start",
  id,
  "aria-label": ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const selected = React.useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );

  // Gom theo nhóm khi có `group`; giữ thứ tự nhóm theo lần xuất hiện đầu tiên.
  const grouped = React.useMemo(() => {
    if (!options.some((o) => o.group)) return null;
    const order: string[] = [];
    const map = new Map<string, SearchableSelectOption[]>();
    for (const o of options) {
      const g = o.group ?? "";
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(o);
    }
    return order.map((g) => [g, map.get(g)!] as const);
  }, [options]);

  const handleSelect = (next: string) => {
    onValueChange(next);
    setOpen(false);
    setQuery("");
  };

  const renderItem = (opt: SearchableSelectOption) => (
    <CommandItem
      key={opt.value}
      value={opt.value}
      keywords={optionSearchText(opt)}
      disabled={opt.disabled}
      onSelect={() => handleSelect(opt.value)}
      className="cursor-pointer"
    >
      <Check
        className={cn(
          "mr-2 h-4 w-4 shrink-0",
          value === opt.value ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="line-clamp-1">{opt.label}</span>
    </CommandItem>
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
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(triggerBaseClass, className)}
        >
          <span
            className={cn(
              "line-clamp-1 text-left",
              !selected && "text-muted-foreground",
            )}
          >
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn("w-[--radix-popover-trigger-width] p-0", contentClassName)}
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <Command filter={searchableSelectFilter}>
          {searchable && (
            <CommandInput
              placeholder={searchPlaceholder}
              value={query}
              onValueChange={setQuery}
            />
          )}
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {grouped ? (
              grouped.map(([heading, opts]) => (
                <CommandGroup
                  key={heading || "__ungrouped"}
                  heading={heading || undefined}
                >
                  {opts.map(renderItem)}
                </CommandGroup>
              ))
            ) : (
              <CommandGroup>{options.map(renderItem)}</CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default SearchableSelect;
