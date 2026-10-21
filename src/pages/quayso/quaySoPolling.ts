import type { LuckyPublicState } from '@/lib/luckyDrawApi';

/**
 * Sự kiện quay số đã quay XONG HẾT chưa — lúc đó trang công khai thôi hỏi server.
 * (21/10/2026, plan realtime + thông báo, A9 — RT-OTHER-6.)
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
