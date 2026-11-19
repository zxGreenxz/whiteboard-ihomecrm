// Ô chọn giờ 0..23 cho khung giờ yên. Dùng danh sách chọn thay ô gõ số: giờ chỉ có 24 giá
// trị hợp lệ, gõ tay chỉ đẻ thêm trạng thái "đang nhập sai" phải chặn trước khi lưu.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatHour } from "@/lib/notifications/settingsDisplay";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function HourSelect({ value, onChange, disabled, label, className }: {
  value: number;
  onChange: (hour: number) => void;
  disabled?: boolean;
  /** Nhãn cho trình đọc màn hình (vd "Giờ bắt đầu yên"). */
  label: string;
  className?: string;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger aria-label={label} className={className ?? "w-[96px]"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {HOURS.map((hour) => (
          <SelectItem key={hour} value={String(hour)}>{formatHour(hour)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
