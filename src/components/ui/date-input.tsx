import * as React from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { format, isValid, parse } from "date-fns";

import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateInputProps {
  value?: string;
  onChange?: (iso: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

function isoToDisplay(iso?: string): string {
  if (!iso) return "";
  const d = parse(iso, "yyyy-MM-dd", new Date());
  return isValid(d) ? format(d, "dd/MM/yyyy") : "";
}

function displayToIso(display: string): string | null {
  const d = parse(display, "dd/MM/yyyy", new Date());
  return isValid(d) ? format(d, "yyyy-MM-dd") : null;
}

function maskDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length > 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }
  if (digits.length > 2) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  return digits;
}

export const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(
  function DateInput(
    {
      value,
      onChange,
      onBlur,
      name,
      disabled,
      placeholder = "dd/mm/yyyy",
      className,
    },
    ref
  ) {
    const [text, setText] = React.useState(() => isoToDisplay(value));
    const [open, setOpen] = React.useState(false);

    React.useEffect(() => {
      setText(isoToDisplay(value));
    }, [value]);

    const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setText(maskDigits(e.target.value));
    };

    const commit = () => {
      if (!text) {
        onChange?.("");
        return;
      }
      const iso = displayToIso(text);
      if (iso) {
        onChange?.(iso);
      } else {
        setText(isoToDisplay(value));
      }
    };

    const handleSelect = (d?: Date) => {
      if (!d) return;
      const iso = format(d, "yyyy-MM-dd");
      onChange?.(iso);
      setText(format(d, "dd/MM/yyyy"));
      setOpen(false);
    };

    const selectedDate = React.useMemo(() => {
      if (!value) return undefined;
      const d = parse(value, "yyyy-MM-dd", new Date());
      return isValid(d) ? d : undefined;
    }, [value]);

    return (
      <div className={cn("relative", className)}>
        <Input
          ref={ref}
          name={name}
          value={text}
          onChange={handleTextChange}
          onBlur={() => {
            commit();
            onBlur?.();
          }}
          disabled={disabled}
          placeholder={placeholder}
          inputMode="numeric"
          className="pr-9"
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Mở lịch"
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <CalendarIcon className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={handleSelect}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>
    );
  }
);
