import * as React from "react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface NumberInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "type"
  > {
  value?: number | null;
  onChange?: (value: number) => void;
  /** Cho phép số thập phân. Default: false (integer) */
  allowDecimal?: boolean;
  /** Min/max validation hint, không cứng. */
  min?: number;
  max?: number;
  className?: string;
}

/**
 * Input cho số (count, quantity, percent, chỉ số đồng hồ...):
 * - Không hiển thị "0" mặc định khi rỗng/undefined
 * - onChange trả về number thuần
 * - Cho phép integer hoặc decimal
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      value,
      onChange,
      onBlur,
      onFocus,
      allowDecimal = false,
      min,
      max,
      className,
      placeholder,
      ...rest
    },
    ref
  ) {
    const [text, setText] = React.useState<string>(() =>
      value == null || value === 0 ? "" : String(value)
    );
    const [focused, setFocused] = React.useState(false);

    React.useEffect(() => {
      if (focused) return;
      if (value == null || (typeof value === "number" && value === 0)) {
        setText("");
      } else {
        setText(String(value));
      }
    }, [value, focused]);

    const clamp = (n: number) => {
      let v = n;
      if (typeof min === "number" && v < min) v = min;
      if (typeof max === "number" && v > max) v = max;
      return v;
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      if (raw === "") {
        setText("");
        onChange?.(0);
        return;
      }
      const cleaned = allowDecimal
        ? raw.replace(/[^\d.,-]/g, "").replace(",", ".")
        : raw.replace(/[^\d-]/g, "");
      setText(cleaned);
      const num = allowDecimal ? parseFloat(cleaned) : parseInt(cleaned, 10);
      if (!Number.isNaN(num)) {
        onChange?.(clamp(num));
      }
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      setFocused(true);
      if (value === 0 || value == null) {
        setText("");
      }
      onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      setFocused(false);
      if (value == null || value === 0) {
        setText("");
      } else {
        setText(String(value));
      }
      onBlur?.(e);
    };

    return (
      <Input
        ref={ref}
        inputMode={allowDecimal ? "decimal" : "numeric"}
        placeholder={placeholder ?? "0"}
        {...rest}
        value={text}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={cn(className)}
      />
    );
  }
);
