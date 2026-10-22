import type { LuckyPublicState } from '@/lib/luckyDrawApi';

/**
 * Sự kiện quay số đã quay XONG HẾT chưa — lúc đó trang công khai chuyển sang
 * hỏi THƯA (xem `nhipHoiSauKhiXong`). (21/10/2026, plan realtime + thông báo,
 * A9 — RT-OTHER-6; sửa 22/10/2026 theo review RT-CLIENT-2.)
 *
 * Trước đây trang người xem vẫn hỏi 10 s/lần sau khi đã quay, và màn chiếu hỏi
 * 5 s/lần mãi mãi, kể cả tab bỏ quên ở nền (refetchIntervalInBackground). Link
 * công khai gửi cho nhiều khách nên mỗi tab quên là một vòng gọi RPC vô hạn.
 *
 * - Sự kiện chia lượt: xong khi MỌI lượt đã 'drawn'.
 * - Sự kiện một giải kiểu cũ (rounds rỗng): xong khi event 'drawn' hoặc 'closed'.
 * Chưa đọc được trạng thái thì CHƯA xong (tiếp tục hỏi).
 */
export function daQuayXong(state: LuckyPublicState | undefined): boolean {
  if (!state?.ok || !state.event) return false;
  const rounds = state.rounds ?? [];
  if (rounds.length > 0) return rounds.every((round) => round.status === 'drawn');
  return state.event.status === 'drawn' || state.event.status === 'closed';
}

/**
 * Nhịp hỏi SAU KHI XONG. KHÔNG được dừng hẳn (RT-CLIENT-2): quản trị bấm "Huỷ
 * kết quả và mở lại" (resetDraw đưa event về 'open', mọi lượt về 'pending') —
 * luồng "quay thử → huỷ → quay thật" được thiết kế sẵn ở trang quản trị. Trang
 * thôi hỏi thì không bao giờ thấy lệnh đặt lại: màn chiếu diễn lại người trúng
 * CŨ, trang người xem kẹt kết quả cũ tới F5 (refetchOnWindowFocus tắt toàn cục,
 * trang công khai không có realtime).
 */
export const NHIP_SAU_XONG_MAN_CHIEU_MS = 30_000;
export const NHIP_SAU_XONG_NGUOI_XEM_MS = 60_000;

/**
 * Sự kiện ĐÓNG liên tục quá ngưỡng này (đo bằng giờ server giữa lần đầu trang
 * thấy 'closed' và lượt hỏi mới nhất) thì thôi hỏi hẳn. Server không trả mốc
 * đóng (closedAt), nên mốc là lần đầu CHÍNH TRANG NÀY thấy 'closed' — chắc chắn
 * không sớm hơn lúc đóng thật, nên không bao giờ dừng sớm hơn ngưỡng. 6 giờ: dài
 * hơn một buổi sự kiện (quản trị đóng nhầm rồi mở lại trong buổi vẫn được thấy),
 * mà tab màn chiếu bỏ quên chỉ tốn tối đa ~720 lượt rồi dừng.
 */
export const DUNG_HAN_KHI_DONG_QUA_MS = 6 * 60 * 60 * 1000;

/** Bộ nhớ nhỏ theo trang: giờ server (ms) lần đầu thấy sự kiện 'closed' liên tục. */
export interface TheoDoiDong {
  since: number | null;
}

export function taoTheoDoiDong(): TheoDoiDong {
  return { since: null };
}

/**
 * Chế độ hỏi THƯA: đã quay xong HOẶC sự kiện đã đóng (đóng thì không lượt nào
 * quay được nữa — server từ chối 'closed').
 */
export function dangHoiThua(state: LuckyPublicState | undefined): boolean {
  if (!state?.ok || !state.event) return false;
  return state.event.status === 'closed' || daQuayXong(state);
}

/**
 * Nhịp hỏi ở chế độ hỏi thưa. Trả `null` khi chưa tới chế độ này: trang dùng
 * nhịp thường của mình. Trả `false` (dừng hẳn) chỉ khi đã 'closed' liên tục quá
 * DUNG_HAN_KHI_DONG_QUA_MS. Sự kiện mở lại thì xoá mốc đóng.
 */
export function nhipHoiSauKhiXong(
  state: LuckyPublicState | undefined,
  nhipMs: number,
  theoDoi: TheoDoiDong,
): number | false | null {
  if (!state?.ok || !state.event) return null;
  if (state.event.status !== 'closed') {
    theoDoi.since = null;
    return dangHoiThua(state) ? nhipMs : null;
  }
  const serverNow = Date.parse(state.event.serverNow);
  const now = Number.isFinite(serverNow) ? serverNow : Date.now();
  if (theoDoi.since === null || now < theoDoi.since) theoDoi.since = now;
  return now - theoDoi.since >= DUNG_HAN_KHI_DONG_QUA_MS ? false : nhipMs;
}

/** refetchInterval của MÀN CHIẾU (/quayso/<slug>/quay). */
export function nhipHoiManChieu(state: LuckyPublicState | undefined, theoDoi: TheoDoiDong): number | false {
  if (!state?.ok) return 5000;
  const sauKhiXong = nhipHoiSauKhiXong(state, NHIP_SAU_XONG_MAN_CHIEU_MS, theoDoi);
  if (sauKhiXong !== null) return sauKhiXong;
  // Còn lượt chưa quay ⇒ hỏi dồn 1,5 giây một lần: chủ giải bấm "Mở lượt" ở
  // trang quản trị thì màn chiếu phải bắt được gần như tức thì, chứ để 5 giây
  // thì khán phòng nhìn thấy một khoảng chết ngay sau tiếng bấm.
  const conLuot = (state.rounds ?? []).some((round) => round.status !== 'drawn');
  return conLuot ? 1500 : 5000;
}
