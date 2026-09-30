import * as React from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { format, isValid, parse } from "date-fns";

import { cn } from "@/lib/utils";
import { useInputDraftGuard } from '@/lib/inputDraftValidation';
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateInputProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'onBlur'> {
  value?: string;
  onChange?: (iso: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Class cho chính ô input (chiều cao, viền…); `className` là cho khung bọc. */
  inputClassName?: string;
}

function isoToDisplay(iso?: string): string {
  if (!iso) return "";
  const d = parse(iso, "yyyy-MM-dd", new Date());
  return isValid(d) ? format(d, "dd/MM/yyyy") : "";
}

function displayToIso(display: string): string | null {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(display)) return null;
  const d = parse(display, "dd/MM/yyyy", new Date());
  return isValid(d) && format(d,"dd/MM/yyyy") === display ? format(d, "yyyy-MM-dd") : null;
}

function maskDigits(raw: string): string {
  if (!/^[\d/]*$/.test(raw) || raw.replace(/\//g, "").length > 8) return raw;
  const digits = raw.replace(/\//g, "");
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
      inputClassName,
      ...inputProps
    },
    ref
  ) {
    const [text, setText] = React.useState(() => isoToDisplay(value));
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const inputRef=React.useRef<HTMLInputElement|null>(null);
    const errorId=React.useId()+'-date-error';
    const lastEmitted=React.useRef<string>();
    const setRef=React.useCallback((node:HTMLInputElement|null)=>{inputRef.current=node;if(typeof ref==='function')ref(node);else if(ref)ref.current=node;},[ref]);
    useInputDraftGuard(inputRef,error);

    React.useEffect(() => {
      if (value===lastEmitted.current) return;
      setText(isoToDisplay(value));setError(undefined);
    }, [value]);

    const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const next=maskDigits(e.target.value);setText(next);
      const iso=displayToIso(next);
      setError(!next||iso?undefined:'Nhập ngày hợp lệ theo dạng dd/mm/yyyy, ví dụ 29/10/2026.');
      if(!next||iso){lastEmitted.current=iso??'';onChange?.(iso??'');}
    };

    const commit = () => {
      if (!text) {
        setError(undefined);lastEmitted.current="";onChange?.("");
        return;
      }
      const iso = displayToIso(text);
      if (iso) {
        setError(undefined);lastEmitted.current=iso;onChange?.(iso);
      } else {
        setError("Nhập ngày hợp lệ theo dạng dd/mm/yyyy, ví dụ 29/10/2026.");
      }
    };

    const handleSelect = (d?: Date) => {
      if (!d) return;
      const iso = format(d, "yyyy-MM-dd");
      setError(undefined);lastEmitted.current=iso;onChange?.(iso);
      setText(format(d, "dd/MM/yyyy"));
      setOpen(false);
    };

    const selectedDate = React.useMemo(() => {
      if (!value) return undefined;
      const d = parse(value, "yyyy-MM-dd", new Date());
      return isValid(d) ? d : undefined;
    }, [value]);

    return (
      <div className={className}>
      <div className="relative">
        <Input
          {...inputProps}
          ref={setRef}
          aria-invalid={error?true:inputProps["aria-invalid"]}
          aria-describedby={[inputProps["aria-describedby"],error?errorId:undefined].filter(Boolean).join(" ")||undefined}
          data-input-error={error?"true":undefined}
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
          className={cn("pr-9", inputClassName)}
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
      {error&&<p id={errorId} role="alert" className="mt-1 text-sm font-medium text-destructive">{error}</p>}
      </div>
    );
  }
);
