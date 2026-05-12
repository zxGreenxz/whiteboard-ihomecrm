import * as React from "react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface CurrencyInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "type"
  > {
  value?: number | null;
  onChange?: (value: number) => void;
  /** Hiển thị suffix " đ" bên trong ô (tự padding-right). Default: true */
  suffix?: boolean;
  className?: string;
}

function formatThousands(n: number): string {
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("vi-VN").format(Math.trunc(n));
}

function parseDigits(raw: string): number {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return 0;
  return Number(digits);
}

/**
 * Input cho số tiền VND:
 * - Hiển thị dấu chấm phân ngàn (1.000.000)
 * - Không hiển thị "0" mặc định khi rỗng/undefined → user gõ liền
 * - onChange trả về number thuần
 * - Suffix "đ" trong ô (optional)
 */
export const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput(
    { value, onChange, onBlur, suffix = true, className, placeholder, ...rest },
    ref
  ) {
    const [text, setText] = React.useState<string>(() =>
      value && value !== 0 ? formatThousands(value) : ""
    );
    const [focused, setFocused] = React.useState(false);

    React.useEffect(() => {
      if (focused) return;
      if (value == null || value === 0) {
        setText("");
      } else {
        setText(formatThousands(value));
      }
    }, [value, focused]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const num = parseDigits(raw);
      setText(num === 0 ? raw.replace(/\D/g, "") === "" ? "" : "0" : formatThousands(num));
      onChange?.(num);
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      setFocused(true);
      if (value === 0 || value == null) {
        setText("");
      }
      rest.onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      setFocused(false);
      if (value == null || value === 0) {
        setText("");
      } else {
        setText(formatThousands(value));
      }
      onBlur?.(e);
    };

    return (
      <div className="relative w-full">
        <Input
          ref={ref}
          inputMode="numeric"
          placeholder={placeholder ?? "0"}
          {...rest}
          value={text}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={cn(suffix ? "pr-8" : undefined, className)}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            đ
          </span>
        )}
      </div>
    );
  }
);
