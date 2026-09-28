// Node counterpart of src/lib/roomSaleFacts.ts; parity is checked in worker tests.
function validDay(day) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
const dateLabel = day => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
export function roomSaleFacts(input) {
  if (input.status === 'rented') return { kind: 'rented', label: 'Đã thuê / giữ chỗ', availableOn: null };
  if (input.status === 'pass') return { kind: 'pass', label: 'Khách pass phòng', availableOn: null };
  const today = validDay(input.today) ? input.today : null;
  if (input.status === 'free' && input.state === 'PREPARING') {
    const expected = validDay(input.expectedReadyOn) ? input.expectedReadyOn : null;
    if (!expected) return { kind: 'preparing', label: 'Đang chuẩn bị · chưa có ngày dự kiến', availableOn: null };
    if (!today || expected < today) return { kind: 'preparing', label: 'Đang chuẩn bị · cần xác nhận ngày sẵn sàng', availableOn: null };
    return { kind: 'preparing', label: `Đang chuẩn bị · dự kiến ${dateLabel(expected)}`, availableOn: expected };
  }
  if (input.status === 'soon') {
    const day = validDay(input.availableOn) ? input.availableOn : null;
    if (input.state === 'NOTICE_OVERDUE' || !today || !day || day < today) return { kind: 'confirm_notice', label: 'Cần xác nhận ngày trống', availableOn: null };
    return { kind: 'notice', label: `Sắp trống · ${dateLabel(day)}`, availableOn: day };
  }
  if (input.status === 'free') return { kind: 'ready', label: 'Trống sẵn', availableOn: null };
  return { kind: 'rented', label: 'Chưa xác nhận tình trạng', availableOn: null };
}
