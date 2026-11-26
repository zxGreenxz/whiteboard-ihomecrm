/** Public facts only. Occupancy and reservation priority are decided by the reader. */
export interface RoomSaleFactInput {
  status: string;
  state?: string | null;
  today?: string | null;
  availableOn?: string | null;
  expectedReadyOn?: string | null;
  /** Chỉ reader trong app: phòng 'rented' vì đang giữ bằng cọc chờ hợp đồng (đợt giữ chỗ #499 hoặc phiếu cọc treo). */
  hasDepositHold?: boolean;
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

/** Quá số ngày này mà phiếu cọc giữ phòng chưa thành hợp đồng thì trang Sale tô cảnh báo (không tự gỡ: tiền đã thu). */
export const DEPOSIT_HOLD_STALE_DAYS = 14;

/** Nhãn CÔNG KHAI của phòng đang giữ bằng cọc: đi vào saleFact.label ⇒ tin «Chia sẻ» gửi khách, ảnh / xuất bảng, Copilot. */
export const DEPOSIT_HOLD_PUBLIC_LABEL = 'Đang giữ chỗ';

/**
 * «Đã cọc · người nộp · N ngày» — CHỈ cho bảng Sale nội bộ (QuickRoomBoard), không bao giờ vào saleFact.label: tên người
 * nộp không được theo tin chia sẻ ra ngoài. Người xem không có deposits.view thì máy chủ không trả tên ⇒ «Đã cọc · N ngày».
 */
export function roomSaleDepositLabel(hold: { source?: 'hold' | 'voucher'; payerName?: string | null; heldDays: number }): string {
  const days = Number.isFinite(hold.heldDays) && hold.heldDays > 0 ? `${Math.floor(hold.heldDays)} ngày` : 'hôm nay';
  if (hold.source === 'voucher') return 'Đã thu · Chưa xác định lượt thuê';
  return ['Đã cọc', hold.payerName?.trim() || null, days].filter(Boolean).join(' · ');
}

export function roomSaleFacts(input: RoomSaleFactInput): RoomSaleFact {
  if (input.status === 'rented') {
    const label = input.hasDepositHold ? DEPOSIT_HOLD_PUBLIC_LABEL : 'Đã thuê / giữ chỗ';
    return { kind: 'rented', label, availableOn: null };
  }
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

/**
 * Nhịp tự đọc lại khi trang đang hiện. Mỗi lần đọc là toàn bộ kho phòng, nên đợt 4 «Tải nhẹ»
 * (25/11/2026) giãn từ 5 giây ở mọi nơi thành 30 giây cho bảng nội bộ/điện thoại và 60 giây cho
 * link công khai. Thao tác của chính người dùng vẫn hiện ngay vì mutation invalidate; quay lại tab
 * và có mạng lại vẫn đọc ngay (hook đặt refetchOnWindowFocus/refetchOnReconnect 'always').
 */
export const ROOM_SALE_POLL_MS = { internal: 30_000, public: 60_000 } as const;
export type RoomSalePollAudience = keyof typeof ROOM_SALE_POLL_MS;
/** Lỗi liên tiếp giãn gấp đôi nhịp, không quá 5 phút. */
export const ROOM_SALE_POLL_MAX_MS = 300_000;

/** TanStack also suppresses background intervals; explicit visibility handles errors consistently. */
export function roomSalePollingInterval(audience: RoomSalePollAudience, errorCount: number, visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'): number | false {
  return visible ? Math.min(ROOM_SALE_POLL_MAX_MS, ROOM_SALE_POLL_MS[audience] * 2 ** Math.min(4, Math.max(0, errorCount))) : false;
}

/** Phần state TanStack Query cần để đếm lỗi (Query thật có đủ các trường này). */
export interface RoomSalePollQuery { state: { status: string; error: unknown; errorUpdateCount: number } }
const errorCountAtLastSuccess = new WeakMap<object, number>();

/**
 * Số lần đọc lỗi LIÊN TIẾP kể từ lần đọc thành công gần nhất. `errorUpdateCount` của TanStack
 * cộng dồn cả đời query (thành công không đưa về 0), nên dùng thẳng thì lỗi lẻ tẻ trong phiên
 * cộng dồn và một lỗi đơn cũng nhảy tới trần 5 phút. TanStack gọi refetchInterval sau mọi lần
 * cập nhật query: lúc `status === 'success'` thì ghi mốc, lúc lỗi thì đếm từ mốc đó. Không ghi mốc
 * theo `error == null`: query chưa từng có dữ liệu bị đưa về `pending`, `error: null` mỗi lần đọc lại.
 */
export function roomSaleConsecutiveErrors(query: RoomSalePollQuery): number {
  const { status, error, errorUpdateCount } = query.state;
  if (status === 'success') {
    errorCountAtLastSuccess.set(query, errorUpdateCount);
    return 0;
  }
  if (!error) return 0;
  return Math.max(1, errorUpdateCount - (errorCountAtLastSuccess.get(query) ?? 0));
}

/** refetchInterval dùng chung cho bảng nội bộ, «Phòng trống» trong app và link công khai. */
export function roomSaleQueryInterval(audience: RoomSalePollAudience, query: RoomSalePollQuery): number | false {
  return roomSalePollingInterval(audience, roomSaleConsecutiveErrors(query));
}
