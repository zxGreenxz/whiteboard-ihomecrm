import { useState, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface Props {
  /** Ghi chú hiện tại — null/'' = chưa có. */
  value: string | null | undefined;
  onChange: (next: string) => void;
  /** Bật triangle khi discount > 0. */
  disabled?: boolean;
  /** Class extra cho wrapper triangle (vị trí). */
  className?: string;
}

/**
 * Tam giác đỏ ở góc trên-phải ô Giảm trừ. Bấm vào mở popover textarea để
 * sửa ghi chú. Hover lên tam giác show tooltip ghi chú hiện tại.
 */
export function DiscountNoteTrigger({
  value,
  onChange,
  disabled,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    if (open) setDraft(value ?? "");
  }, [open, value]);

  const hasNote = !!(value && value.trim().length > 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={hasNote ? value! : "Bấm để thêm ghi chú"}
          aria-label="Ghi chú giảm trừ"
          className={
            "absolute top-0 right-0 w-0 h-0 cursor-pointer disabled:cursor-not-allowed " +
            "border-t-[10px] border-l-[10px] border-l-transparent " +
            (disabled
              ? "border-t-zinc-300"
              : hasNote
                ? "border-t-red-600 hover:border-t-red-700"
                : "border-t-red-400 hover:border-t-red-600") +
            (className ? ` ${className}` : "")
          }
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-72 space-y-2"
        align="end"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-medium text-zinc-700">
          Ghi chú giảm trừ
        </div>
        <Textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='VD: "Nợ 500.000 Tiền Thối", "Khuyến mãi đầu tháng"...'
          className="text-sm"
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setOpen(false)}
          >
            Huỷ
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onChange(draft.trim());
              setOpen(false);
            }}
          >
            Lưu
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
