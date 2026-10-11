import * as React from "react";

import { cn } from "@/lib/utils";

interface MonthInputProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'onBlur'> {
  /** Giá trị 'YYYY-MM' (rỗng = chưa chọn). */
  value?: string;
  onChange?: (month: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  className?: string;
}

/** 'YYYY-MM' → '10/2026'; giá trị không hợp lệ/rỗng → null. */
export function monthInputLabel(value: string | undefined): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? "");
  return m ? `${Number(m[2])}/${m[1]}` : null;
}

/**
 * Ô chọn Tháng/Năm (value 'YYYY-MM'). Dùng cho "kỳ áp dụng" của hạng mục thu/chi.
 *
 * K11-60 (C-10): `<input type="month">` gốc hiện theo NGÔN NGỮ TRÌNH DUYỆT ("October
 * 2026" trên Chrome tiếng Anh) — thuộc tính lang của trang không đổi được. Vì vậy ô
 * hiển thị chữ do app định dạng ("10/2026"); input gốc vẫn nằm phủ trong suốt phía
 * trên để giữ bàn phím, form, aria và bảng chọn của hệ điều hành (bấm là mở bảng chọn
 * qua showPicker khi trình duyệt hỗ trợ).
 */
export const MonthInput = React.forwardRef<HTMLInputElement, MonthInputProps>(
  function MonthInput({ value, onChange, onBlur, onClick, name, disabled, className, placeholder, ...props }, ref) {
    const label = monthInputLabel(value);
    return (
      <div className="relative w-full">
        <input
          {...props}
          ref={ref}
          type="month"
          lang="vi"
          name={name}
          value={value ?? ""}
          onChange={(e) => onChange?.(e.target.value)}
          onClick={(e) => {
            onClick?.(e);
            try {
              e.currentTarget.showPicker?.();
            } catch {
              /* Trình duyệt chặn mở bảng chọn (không phải thao tác người dùng): vẫn gõ/phím được. */
            }
          }}
          onBlur={onBlur}
          disabled={disabled}
          className="peer absolute inset-0 z-[1] h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <div
          aria-hidden="true"
          data-month-display=""
          className={cn(
            "pointer-events-none flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background md:text-sm",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 peer-aria-[invalid=true]:border-destructive",
            !label && "text-muted-foreground",
            className,
          )}
        >
          {label ?? placeholder ?? "Chọn tháng"}
        </div>
      </div>
    );
  }
);
