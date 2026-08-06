// Khoá giữ-phòng 24h (room_reservation_holds) — writer canonical
// create_reservation_deposit_v1 (t5_20, flag deposit.hold.v1). Đặt hold TRƯỚC
// khi ghi phiếu cọc giữ chỗ để 2 nhân viên không thu cọc đè cùng một phòng
// (exclusion constraint phía DB). Phiếu thu cọc vẫn là nguồn sự thật về tiền;
// hold chỉ là khoá độc quyền, hết hạn sau 24h hoặc được HĐ tiêu thụ
// (create_contract_v1 chuyển hold → APPROVED khi ký).
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { todayISO } from '@/lib/collect';

/**
 * Đặt hold cho phòng trước khi tạo phiếu cọc.
 * - Đặt được (hoặc chính mình đang giữ) → resolve bình thường.
 * - Phòng đang bị NGƯỜI KHÁC giữ → throw lỗi nghiệp vụ rõ ràng (chặn cọc đè).
 * - Writer chưa bật / không có quyền / lỗi hạ tầng → KHÔNG chặn (legacy: cho qua).
 *
 * Idempotency key theo (phòng, ngày): retry cùng ngày cùng số tiền → replay
 * nguyên response; đổi số tiền cùng ngày → 23505 (chính mình đã giữ) → cho qua.
 */
export async function tryPlaceRoomHold(roomId: string, amount: number): Promise<void> {
  let blockedMessage: string | null = null;
  try {
    const day = todayISO().replace(/-/g, "");
    const { error } = await supabase.rpc("create_reservation_deposit_v1", {
      p_room_id: roomId,
      p_amount: Math.max(Math.round(amount), 1),
      p_idempotency_key: `dephold-${roomId}-${day}`,
    });
    if (!error) return;

    const code = String((error as any)?.code ?? "");
    const msg = String((error as any)?.message ?? "");

    // 23505: cùng key khác payload → chính mình đã giữ phòng hôm nay (khác tiền).
    if (code === "23505") return;

    if (code === "55000" && msg.includes("cọc giữ chỗ còn hiệu lực")) {
      // Có hold sống — của mình (hold hôm qua chưa hết 24h) hay của người khác?
      const me = await getSessionUser();
      const { data: holds } = await supabase
        .from("room_reservation_holds")
        .select("held_by")
        .eq("room_id", roomId)
        .eq("status", "PENDING_APPROVAL")
        .gt("expires_at", new Date().toISOString())
        .limit(1);
      const heldBy = (holds?.[0] as { held_by?: string } | undefined)?.held_by;
      if (heldBy && me?.id && heldBy === me.id) return; // mình đang giữ — tiếp tục
      blockedMessage =
        "Phòng này đang được giữ chỗ (khoá 24h) bởi nhân viên khác. " +
        "Kiểm tra lại trước khi thu cọc đè; khoá tự hết hạn sau 24h kể từ lúc giữ.";
    }
    // Mọi tín hiệu khác (PGRST202 chưa deploy, 42501 không quyền, 55000 "chưa
    // bật"…) → hành xử như trước khi có hold: không chặn tạo phiếu.
  } catch {
    // Lỗi mạng/đọc RLS khi xác minh chủ hold → không chặn (ưu tiên không gãy việc).
    if (!blockedMessage) return;
  }
  if (blockedMessage) throw new Error(blockedMessage);
}
