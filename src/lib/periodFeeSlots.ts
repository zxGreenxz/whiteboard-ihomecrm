// =============================================================================
// Kho state DÙNG CHUNG của lưới phí /thanh-toan — tách từ usePeriodFeeState V3
// (31/08, audit P3-03) để phần logic chống-đóng-trùng test được không cần
// React/Supabase. HÀNH VI GIỮ NGUYÊN VĂN; usePeriodFeeState import từ đây.
//
// Vì sao tồn tại (V3, 30/07): /thanh-toan mount ĐỒNG THỜI PeriodFeePanel và
// PeriodFeeSheet — chủ ý sản phẩm có spec bảo vệ. Trước V3 mỗi bề mặt giữ
// Record riêng ⇒ cùng một (toà × hạng mục × kỳ) đóng được HAI lần. Nay:
//   • khoá slot = `${hạng mục}|${kỳ}` — hai bề mặt cùng hạng mục đọc/ghi CÙNG
//     một ô nhớ; khác hạng mục ⇒ khoá khác, không lây tiền chéo;
//   • refcount consumer: đổi hạng mục/kỳ khi bề mặt kia còn đứng ở khoá cũ thì
//     KHÔNG xoá (bên kia đang gõ dở); về 0 mới xoá — giữ hành vi "đổi hạng mục
//     là reset sạch" của V2 bằng cấu trúc;
//   • chốt in-flight ĐỒNG BỘ (Set, không qua React state) chặn cú bấm thứ hai
//     trong khe giữa lúc RPC trả về và lúc reader refetch xong (khe 460ms).
// =============================================================================

/** Ô vừa gửi RPC xong nhưng reader chưa kịp thấy phiếu (khe refetch). */
export interface JustPaidMark {
  amount: number;
  /** true = phiếu thứ 2+ do chủ xác nhận đóng thêm. */
  force: boolean;
}

export interface FeeSlot {
  amounts: Record<string, number>;
  bookSel: Record<string, string>;
  attach: Record<string, string>;
  periodN: Record<string, number>;
  draft: Record<string, { code: string; holder: string }>;
  payingKey: string | null;
  justPaid: Record<string, JustPaidMark>;
}

export const EMPTY_SLOT: FeeSlot = Object.freeze({
  amounts: {}, bookSel: {}, attach: {}, periodN: {}, draft: {},
  payingKey: null, justPaid: {},
}) as FeeSlot;

const slotStore = new Map<string, FeeSlot>();
const slotSubs = new Map<string, Set<() => void>>();
const slotRefs = new Map<string, number>();
/** Chốt ĐỒNG BỘ theo `${scope}::${buildingId}` — chống re-entry trước cả re-render. */
export const inflightPays = new Set<string>();

export const readSlot = (scope: string): FeeSlot => slotStore.get(scope) ?? EMPTY_SLOT;

export const writeSlot = (scope: string, patch: (s: FeeSlot) => FeeSlot) => {
  slotStore.set(scope, patch(readSlot(scope)));
  slotSubs.get(scope)?.forEach((fn) => fn());
};

export const subscribeSlot = (scope: string, fn: () => void) => {
  let set = slotSubs.get(scope);
  if (!set) { set = new Set(); slotSubs.set(scope, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) slotSubs.delete(scope);
  };
};

// Đếm consumer để BIẾT KHI NÀO được xoá ô nhớ: đổi hạng mục/kỳ trong khi bề mặt
// kia vẫn ở hạng mục cũ thì KHÔNG được xoá (bên kia đang gõ dở). Về 0 mới xoá —
// giữ đúng hành vi "đổi hạng mục là reset sạch" của V2.
export const retainSlot = (scope: string) => slotRefs.set(scope, (slotRefs.get(scope) ?? 0) + 1);
export const releaseSlot = (scope: string) => {
  const n = (slotRefs.get(scope) ?? 1) - 1;
  if (n > 0) { slotRefs.set(scope, n); return; }
  slotRefs.delete(scope);
  slotStore.delete(scope);
  // CỐ TÌNH không dọn `inflightPays` ở đây: chốt phải sống đến khi RPC trả về
  // (doPay tự xoá trong finally). Dọn sớm = mở lại đúng khe re-entry cần chặn
  // cho ca "đổi hạng mục qua-lại trong lúc phiếu đang bay".
};

/** CHỈ CHO TEST: dọn sạch kho giữa các test case — production không được gọi. */
export const __resetSlotsForTest = () => {
  slotStore.clear();
  slotSubs.clear();
  slotRefs.clear();
  inflightPays.clear();
};

// ── Toán kỳ (thuần, dùng bởi hook + Panel/Sheet) ────────────────────────────

/** 'YYYY-MM' + n tháng (n có thể âm). */
export const addMonths = (ym: string, n: number): string => {
  const [y, m] = ym.slice(0, 7).split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** 'T7/2026' hoặc 'T7/2026 → T12/2026'. */
export const rangeLabel = (start: string, end: string): string => {
  const f = (ym: string) => `T${Number(ym.slice(5, 7))}/${ym.slice(0, 4)}`;
  return start === end ? f(start) : `${f(start)} → ${f(end)}`;
};
