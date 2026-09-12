import { differenceInCalendarDays, isValid, parse } from 'date-fns';

export interface DueBadge {
  label: string;
  tone: 'danger' | 'warn';
}

/**
 * Nhãn hạn thanh toán trên dải ngữ cảnh. Chỉ có ý nghĩa khi đang sửa hoá đơn
 * đã tồn tại; hoá đơn mới thì hạn do người dùng đặt, không cảnh báo.
 */
export function dueBadge(dueIso: string | undefined, isEdit: boolean, today = new Date()): DueBadge | null {
  if (!isEdit || !dueIso) return null;
  const due = parse(dueIso, 'yyyy-MM-dd', new Date());
  if (!isValid(due)) return null;
  const left = differenceInCalendarDays(due, today);
  if (left < 0) return { label: 'quá hạn', tone: 'danger' };
  if (left <= 3) return { label: left === 0 ? 'đến hạn hôm nay' : `còn ${left} ngày`, tone: 'warn' };
  return null;
}
