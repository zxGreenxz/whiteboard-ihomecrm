import * as React from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { format, getDaysInMonth, isValid, parse } from "date-fns";

import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateSegmentInputProps {
  /** Giá trị ISO yyyy-MM-dd (hoặc rỗng). */
  value?: string;
  onChange?: (iso: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  className?: string;
}

type Parts = { d: string; m: string; y: string };

const EMPTY: Parts = { d: "", m: "", y: "" };

function isoToParts(iso?: string): Parts {
  if (!iso) return EMPTY;
  const date = parse(iso, "yyyy-MM-dd", new Date());
  if (!isValid(date)) return EMPTY;
  return {
    d: format(date, "dd"),
    m: format(date, "MM"),
    y: format(date, "yyyy"),
  };
}

/** Số ngày tối đa của tháng/năm đang nhập (mặc định 31 khi chưa đủ thông tin). */
function maxDayOf(m: string, y: string): number {
  const mm = Number(m);
  if (!mm || mm < 1 || mm > 12) return 31;
  const yy = y && y.length === 4 ? Number(y) : new Date().getFullYear();
  return getDaysInMonth(new Date(yy, mm - 1, 1));
}

/** Ghép 3 phần thành ISO nếu đã đủ và hợp lệ; ngược lại trả null. */
function partsToIso(p: Parts): string | null {
  if (!p.d || !p.m || !p.y || p.y.length < 4) return null;
  const display = `${p.d.padStart(2, "0")}/${p.m.padStart(2, "0")}/${p.y}`;
  const date = parse(display, "dd/MM/yyyy", new Date());
  return isValid(date) ? format(date, "yyyy-MM-dd") : null;
}

const segInputClass =
  "bg-transparent text-center outline-none tabular-nums placeholder:text-muted-foreground/70 disabled:cursor-not-allowed";

/**
 * Ô nhập ngày dạng "phân đoạn": dd / mm / yyyy là 3 ô riêng — bấm vào từng phần
 * để sửa trực tiếp, dùng mũi tên ↑/↓ để tăng giảm, ←/→ để nhảy phần. Luôn hiển
 * thị theo thứ tự ngày/tháng/năm (không phụ thuộc locale trình duyệt). Giữ nút
 * lịch để chọn nhanh. Emit ISO yyyy-MM-dd qua onChange — drop-in cho DateInput.
 */
export const DateSegmentInput = React.forwardRef<
  HTMLDivElement,
  DateSegmentInputProps
>(function DateSegmentInput(
  { value, onChange, onBlur, name, disabled, className },
  ref,
) {
  const [parts, setParts] = React.useState<Parts>(() => isoToParts(value));
  const [editing, setEditing] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const dayRef = React.useRef<HTMLInputElement>(null);
  const monthRef = React.useRef<HTMLInputElement>(null);
  const yearRef = React.useRef<HTMLInputElement>(null);

  // Đồng bộ từ prop CHỈ khi không đang gõ — tránh nhảy con trỏ giữa chừng.
  React.useEffect(() => {
    if (editing) return;
    setParts(isoToParts(value));
  }, [value, editing]);

  const emitIfValid = (next: Parts) => {
    const iso = partsToIso(next);
    if (iso) onChange?.(iso);
  };

  const apply = (next: Parts) => {
    setEditing(true);
    setParts(next);
    emitIfValid(next);
  };

  const handleSegChange = (
    seg: keyof Parts,
    raw: string,
    nextRef?: React.RefObject<HTMLInputElement>,
  ) => {
    const max = seg === "y" ? 4 : 2;
    const digits = raw.replace(/\D/g, "").slice(0, max);
    apply({ ...parts, [seg]: digits });

    // Auto-advance: đã đủ chữ số, hoặc chữ số đầu lớn tới mức không thể có
    // chữ số thứ 2 (ngày > 3 → 4..9, tháng > 1 → 2..9).
    const n = Number(digits);
    const full =
      digits.length === max ||
      (seg === "d" && digits.length === 1 && n > 3) ||
      (seg === "m" && digits.length === 1 && n > 1);
    if (full && nextRef?.current) {
      nextRef.current.focus();
      nextRef.current.select();
    }
  };

  const step = (seg: keyof Parts, delta: number) => {
    const next: Parts = { ...parts };
    if (seg === "y") {
      const base =
        parts.y && parts.y.length === 4
          ? Number(parts.y)
          : new Date().getFullYear();
      next.y = String(Math.max(1, base + delta));
    } else {
      const max = seg === "d" ? maxDayOf(parts.m, parts.y) : 12;
      const cur = parts[seg] ? Number(parts[seg]) : delta > 0 ? 0 : 1;
      let v = cur + delta;
      if (v < 1) v = max;
      if (v > max) v = 1;
      next[seg] = String(v).padStart(2, "0");
    }
    apply(next);
  };

  const handleKeyDown = (
    seg: keyof Parts,
    e: React.KeyboardEvent<HTMLInputElement>,
    prevRef?: React.RefObject<HTMLInputElement>,
    nextRef?: React.RefObject<HTMLInputElement>,
  ) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      step(seg, e.key === "ArrowUp" ? 1 : -1);
    } else if (e.key === "ArrowRight") {
      const el = e.currentTarget;
      if (el.selectionStart === el.value.length && nextRef?.current) {
        e.preventDefault();
        nextRef.current.focus();
        nextRef.current.select();
      }
    } else if (e.key === "ArrowLeft") {
      const el = e.currentTarget;
      if (el.selectionStart === 0 && prevRef?.current) {
        e.preventDefault();
        prevRef.current.focus();
        prevRef.current.select();
      }
    } else if (e.key === "Backspace" && !e.currentTarget.value && prevRef?.current) {
      e.preventDefault();
      prevRef.current.focus();
      prevRef.current.select();
    }
  };

  const commit = () => {
    if (!parts.d && !parts.m && !parts.y) {
      onChange?.("");
      return;
    }
    if (parts.d && parts.m && parts.y && parts.y.length === 4) {
      const clampedDay = Math.min(
        Number(parts.d),
        maxDayOf(parts.m, parts.y),
      );
      const display = `${String(clampedDay).padStart(2, "0")}/${parts.m.padStart(
        2,
        "0",
      )}/${parts.y}`;
      const date = parse(display, "dd/MM/yyyy", new Date());
      if (isValid(date)) {
        const iso = format(date, "yyyy-MM-dd");
        onChange?.(iso);
        setParts(isoToParts(iso));
        return;
      }
    }
    // Chưa đủ / không hợp lệ → quay về giá trị gốc.
    setParts(isoToParts(value));
  };

  const handleCalendarSelect = (d?: Date) => {
    if (!d) return;
    const iso = format(d, "yyyy-MM-dd");
    onChange?.(iso);
    setParts(isoToParts(iso));
    setOpen(false);
  };

  const selectedDate = React.useMemo(() => {
    if (!value) return undefined;
    const d = parse(value, "yyyy-MM-dd", new Date());
    return isValid(d) ? d : undefined;
  }, [value]);

  return (
    <div
      ref={ref}
      className={cn(
        "flex h-10 w-full items-center rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      onFocus={() => setEditing(true)}
      onBlur={(e) => {
        // Chỉ commit khi focus rời hẳn khỏi cụm ô (kể cả nút lịch).
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setEditing(false);
          commit();
          onBlur?.();
        }
      }}
    >
      <input
        ref={dayRef}
        name={name}
        aria-label="Ngày"
        inputMode="numeric"
        placeholder="dd"
        disabled={disabled}
        value={parts.d}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => handleSegChange("d", e.target.value, monthRef)}
        onKeyDown={(e) => handleKeyDown("d", e, undefined, monthRef)}
        className={cn(segInputClass, "w-[2.2ch]")}
      />
      <span className="px-0.5 text-muted-foreground">/</span>
      <input
        ref={monthRef}
        aria-label="Tháng"
        inputMode="numeric"
        placeholder="mm"
        disabled={disabled}
        value={parts.m}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => handleSegChange("m", e.target.value, yearRef)}
        onKeyDown={(e) => handleKeyDown("m", e, dayRef, yearRef)}
        className={cn(segInputClass, "w-[2.2ch]")}
      />
      <span className="px-0.5 text-muted-foreground">/</span>
      <input
        ref={yearRef}
        aria-label="Năm"
        inputMode="numeric"
        placeholder="yyyy"
        disabled={disabled}
        value={parts.y}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => handleSegChange("y", e.target.value)}
        onKeyDown={(e) => handleKeyDown("y", e, monthRef, undefined)}
        className={cn(segInputClass, "w-[4.2ch]")}
      />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Mở lịch"
            className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <CalendarIcon className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={handleCalendarSelect}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
});
