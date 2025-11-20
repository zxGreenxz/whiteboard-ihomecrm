import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { format, subDays, startOfMonth, endOfMonth, startOfYear, endOfYear } from "date-fns";
import { vi } from "date-fns/locale";
import { DateRange } from "react-day-picker";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange | undefined) => void;
  className?: string;
}

export function DateRangePicker({
  value,
  onChange,
  className,
}: DateRangePickerProps) {
  const [date, setDate] = useState<DateRange | undefined>(value);

  const handleDateChange = (newDate: DateRange | undefined) => {
    setDate(newDate);
    onChange?.(newDate);
  };

  const handlePresetClick = (preset: "today" | "week" | "month" | "year" | "30days" | "90days") => {
    const today = new Date();
    let from: Date;
    let to: Date = today;

    switch (preset) {
      case "today":
        from = today;
        break;
      case "week":
        from = subDays(today, 7);
        break;
      case "month":
        from = startOfMonth(today);
        to = endOfMonth(today);
        break;
      case "year":
        from = startOfYear(today);
        to = endOfYear(today);
        break;
      case "30days":
        from = subDays(today, 30);
        break;
      case "90days":
        from = subDays(today, 90);
        break;
      default:
        from = today;
    }

    const newRange = { from, to };
    handleDateChange(newRange);
  };

  return (
    <div className={cn("grid gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant={"outline"}
            className={cn(
              "w-[300px] justify-start text-left font-normal",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "dd/MM/yyyy", { locale: vi })} -{" "}
                  {format(date.to, "dd/MM/yyyy", { locale: vi })}
                </>
              ) : (
                format(date.from, "dd/MM/yyyy", { locale: vi })
              )
            ) : (
              <span>Chọn khoảng thời gian</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="flex">
            {/* Preset buttons */}
            <div className="flex flex-col gap-1 border-r p-3">
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => handlePresetClick("today")}
              >
                Hôm nay
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => handlePresetClick("week")}
              >
                7 ngày
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => handlePresetClick("30days")}
              >
                30 ngày
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => handlePresetClick("90days")}
              >
                90 ngày
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => handlePresetClick("month")}
              >
                Tháng này
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => handlePresetClick("year")}
              >
                Năm nay
              </Button>
            </div>
            {/* Calendar */}
            <Calendar
              initialFocus
              mode="range"
              defaultMonth={date?.from}
              selected={date}
              onSelect={handleDateChange}
              numberOfMonths={2}
              locale={vi}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
