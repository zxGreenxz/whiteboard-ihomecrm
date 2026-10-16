/** Public facts only. Occupancy and reservation priority are decided by the reader. */
export interface RoomSaleFactInput {
  status: string;
  state?: string | null;
  today?: string | null;
  availableOn?: string | null;
  expectedReadyOn?: string | null;
}

export interface RoomSaleFact {
  kind: 'ready' | 'notice' | 'confirm_notice' | 'preparing' | 'rented' | 'pass';
  label: string;
  availableOn: string | null;
}

function validDay(day: string | null | undefined): day is string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function dateLabel(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

export function roomSaleFacts(input: RoomSaleFactInput): RoomSaleFact {
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
    const date = validDay(input.availableOn) ? input.availableOn : null;
    if (input.state === 'NOTICE_OVERDUE' || !today || !date || date < today) {
      return { kind: 'confirm_notice', label: 'Cần xác nhận ngày trống', availableOn: null };
    }
    return { kind: 'notice', label: `Sắp trống · ${dateLabel(date)}`, availableOn: date };
  }
  if (input.status === 'free') return { kind: 'ready', label: 'Trống sẵn', availableOn: null };
  return { kind: 'rented', label: 'Chưa xác nhận tình trạng', availableOn: null };
}

/** Liên hệ của phòng khách pass đúng như reader trả (contact_manager ⇒ reader đã che SĐT/tên). */
export interface RoomSalePassContact {
  contactManager?: boolean | null;
  phone?: string | null;
  name?: string | null;
}

/** Trạng thái được chào trên trang Sale Phòng/link chia sẻ và ảnh "Danh sách phòng trống". */
export const ROOM_SALE_LISTED_STATUSES = ['free', 'soon', 'pass'] as const;

/** Giá đăng: phòng khách pass ưu tiên giá pass; còn lại là giá thuê. VND, không làm tròn. */
export function roomSaleListedPrice(status: string, rentPrice: number | null | undefined, passPrice: number | null | undefined): number | null {
  return (status === 'pass' && passPrice != null ? passPrice : rentPrice) ?? null;
}

function passWho(contact: RoomSalePassContact): string {
  return [contact.phone, contact.name ? `(${contact.name})` : ''].filter(Boolean).join(' ');
}

/** Cột TÌNH TRẠNG của phòng khách pass trên bảng/ảnh (in hoa như file Excel Sale gửi Zalo). */
export function roomSalePassStatusLines(contact: RoomSalePassContact): string[] {
  if (contact.contactManager) return ['KHÁCH PASS PHÒNG', 'LIÊN HỆ ADMIN IHOME MỞ CỬA'];
  const who = passWho(contact);
  return who ? ['KHÁCH PASS PHÒNG:', who] : ['KHÁCH PASS PHÒNG'];
}

/** Cùng nội dung một dòng cho tin nhắn (Hermes, bản tin nhóm); SQL hermes_group_room_fact_v1 in y hệt. */
export function roomSalePassLabel(contact: RoomSalePassContact): string {
  if (contact.contactManager) return 'Khách pass phòng · Liên hệ admin iHome mở cửa';
  const who = passWho(contact);
  return who ? `Khách pass phòng: ${who}` : 'Khách pass phòng';
}

/** TanStack also suppresses background intervals; explicit visibility handles errors consistently. */
export function roomSalePollingInterval(errorCount: number, visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'): number | false {
  return visible ? Math.min(60_000, 5_000 * 2 ** Math.min(4, Math.max(0, errorCount))) : false;
}
