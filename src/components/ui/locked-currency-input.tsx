import * as React from "react";
import { Pencil } from "lucide-react";

import { cn, formatVND } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";

interface LockedCurrencyInputProps {
  value?: number | null;
  onChange?: (value: number) => void;
  onBlur?: () => void;
  name?: string;
  /** true = ô xám, chỉ đọc, có nút bút chì để mở khoá. */
  locked: boolean;
  onUnlock: () => void;
  /** Tooltip/aria cho nút bút chì. */
  unlockLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Ô tiền "theo mặc định" — xám + chỉ đọc, cuối ô có cây bút để mở khoá sửa tay.
 *
 * Dùng cho Tiền thuê (mặc định = giá niêm yết của phòng) và Tiền cọc (mặc định
 * = tiền thuê). Mục đích: người nhập không vô tình sửa giá, và mỗi lần sửa đều
 * là hành động CÓ CHỦ Ý — nhờ đó dấu vết trong `room_price_history` và ghi chú
 * điều chỉnh cọc phản ánh đúng ý định, không phải lỗi gõ nhầm.
 *
 * Mở khoá rồi thì KHÔNG tự khoá lại (khoá lại sẽ nuốt mất số user vừa gõ).
 */
export function LockedCurrencyInput({
  value,
  onChange,
  onBlur,
  name,
  locked,
  onUnlock,
  unlockLabel = "Sửa giá",
  disabled,
  className,
}: LockedCurrencyInputProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Vừa mở khoá → đưa con trỏ vào ô luôn, khỏi phải bấm thêm lần nữa.
  const wasLocked = React.useRef(locked);
  React.useEffect(() => {
    if (wasLocked.current && !locked) inputRef.current?.focus();
    wasLocked.current = locked;
  }, [locked]);

  if (!locked) {
    return (
      <CurrencyInput
        ref={inputRef}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        name={name}
        disabled={disabled}
        className={className}
      />
    );
  }

  return (
    <div className="relative w-full">
      <Input
        readOnly
        tabIndex={-1}
        name={name}
        value={formatVND(value ?? 0)}
        disabled={disabled}
        className={cn("bg-muted pr-10 cursor-default", className)}
      />
      <button
        type="button"
        onClick={onUnlock}
        disabled={disabled}
        title={unlockLabel}
        aria-label={unlockLabel}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
