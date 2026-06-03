import * as React from "react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface MonthInputProps {
  /** Giá trị 'YYYY-MM' (rỗng = chưa chọn). */
  value?: string;
  onChange?: (month: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Ô chọn Tháng/Năm dùng native `<input type="month">` (value 'YYYY-MM').
 * Dùng cho "kỳ áp dụng" của hạng mục thu/chi.
 */
export const MonthInput = React.forwardRef<HTMLInputElement, MonthInputProps>(
  function MonthInput({ value, onChange, onBlur, name, disabled, className }, ref) {
    return (
      <Input
        ref={ref}
        type="month"
        name={name}
        value={value ?? ""}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={onBlur}
        disabled={disabled}
        className={cn(className)}
      />
    );
  }
);
