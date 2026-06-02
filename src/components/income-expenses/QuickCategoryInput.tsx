import { useState } from "react";
import { Plus, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { normalizeLoose } from "@/lib/textMatch";
import type { IeTypeRef } from "@/lib/incomeExpenseQuickInput";

interface QuickCategoryInputProps {
  value: string;
  onChange: (v: string) => void;
  /** true khi đang ở "vùng hạng mục" & chưa khoá → cho hiện dropdown. */
  active: boolean;
  /** Query lọc (categorySearch) — dùng cho nhãn "Tạo mới". */
  query: string;
  /** Danh sách hạng mục đã lọc & xếp hạng sẵn (do dialog cha tính). */
  suggestions: IeTypeRef[];
  /** Hạng mục đang được khoá (để hiện tick). */
  lockedTypeId: string | null;
  onSelect: (type: IeTypeRef) => void;
  onCreateNew: (query: string) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  placeholder?: string;
  autoFocus?: boolean;
}

const QuickCategoryInput = ({
  value,
  onChange,
  active,
  query,
  suggestions,
  lockedTypeId,
  onSelect,
  onCreateNew,
  inputRef,
  placeholder,
  autoFocus,
}: QuickCategoryInputProps) => {
  const [focused, setFocused] = useState(false);

  const trimmed = query.trim();
  const hasExact = suggestions.some(
    (s) => normalizeLoose(s.name) === normalizeLoose(trimmed),
  );
  const showCreate = trimmed.length > 0 && !hasExact;
  const open = active && focused && (suggestions.length > 0 || showCreate);

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        // Delay blur để cú chạm vào item (pointerdown) kịp chặn mất focus.
        onBlur={() => setFocused(false)}
        className="font-mono"
      />

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              // preventDefault để giữ focus ở input (không đóng dropdown trước khi chọn).
              onPointerDown={(e) => {
                e.preventDefault();
                onSelect(s);
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent active:bg-accent"
            >
              <Check
                className={cn(
                  "h-4 w-4 shrink-0",
                  lockedTypeId === s.id ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{s.name}</span>
                {s.category && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.category}
                  </span>
                )}
              </span>
            </button>
          ))}

          {showCreate && (
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                onCreateNew(trimmed);
              }}
              className="flex w-full items-center gap-2 border-t px-3 py-2.5 text-left text-sm text-primary hover:bg-accent active:bg-accent"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="truncate">
                Tạo mới: <span className="font-medium">{trimmed}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default QuickCategoryInput;
