import { SolarDate } from '@nghiavuive/lunar_date_vi';
import { addDaysISO, formatISODayMonth } from '@/lib/vnDate';

export function lunarDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return new SolarDate({ year, month, day }).toLunarDate().get();
}
export function lunarLabel(iso: string): string {
  const lunar = lunarDate(iso);
  return `${lunar.day}/${lunar.month}${lunar.leap_month ? ' nhuận' : ''} âm`;
}
export function dayLabel(iso: string, today: string, overdue = false): string {
  if (iso === today) return `Hôm nay · ${formatISODayMonth(iso)}`;
  const weekday = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  return `${overdue && iso < today ? 'Chưa xong · ' : ''}${weekday} ${formatISODayMonth(iso)}`;
}
export function monthCells(month: string): string[] {
  const first = `${month}-01`;
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const [year, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((weekday + days) / 7) * 7 }, (_, i) => addDaysISO(first, i - weekday)!);
}
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7);
  return next < '1900-01' ? '1900-01' : next > '2199-12' ? '2199-12' : next;
}
const solarHolidays: Record<string, string> = {
  '01-01': 'Tết Dương lịch', '03-08': 'Quốc tế Phụ nữ', '04-30': 'Giải phóng miền Nam',
  '05-01': 'Quốc tế Lao động', '06-01': 'Quốc tế Thiếu nhi', '09-02': 'Quốc khánh',
  '10-20': 'Phụ nữ Việt Nam', '11-20': 'Nhà giáo Việt Nam', '12-24': 'Đêm Giáng sinh', '12-25': 'Giáng sinh',
};
const lunarHolidays: Record<string, string> = {
  '1/1': 'Tết Nguyên Đán', '2/1': 'Mùng 2 Tết', '3/1': 'Mùng 3 Tết', '15/1': 'Rằm tháng Giêng',
  '10/3': 'Giỗ Tổ Hùng Vương', '15/4': 'Phật Đản', '5/5': 'Tết Đoan Ngọ', '15/7': 'Vu Lan',
  '15/8': 'Tết Trung Thu', '23/12': 'Ông Công Ông Táo',
};
export function holiday(iso: string): string | undefined {
  const lunar = lunarDate(iso);
  return solarHolidays[iso.slice(5)] ?? (!lunar.leap_month ? lunarHolidays[`${lunar.day}/${lunar.month}`] : undefined);
}
