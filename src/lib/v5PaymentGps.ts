// v5PaymentGps — GPS NỀN IM LẶNG sau khi phiếu thu lưu xong (A1#3, US-2.5).
// KHÔNG BAO GIỜ chặn/hỏng luồng thu tiền: mọi lỗi nuốt êm phía FE
// (server đã log salary_award_errors ở record_payment_gps khi cần).
// Nếu toà chưa check hôm nay → server tạo thông báo TREO; FE chỉ toast nhắc nhẹ.
import { supabase } from "@/integrations/supabase/client";
import { rpcNullable } from "@/lib/rpcNullable";
import { toast } from "sonner";
import { v5Copy } from "@/lib/v5Copy";

function getPosition(timeoutMs = 8000): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** Fire-and-forget: gọi `void captureGpsAndRecord(ids)` sau khi phiếu lưu OK. */
export async function captureGpsAndRecord(voucherIds: string[]): Promise<void> {
  if (!voucherIds.length) return;
  try {
    const pos = await getPosition();
    const lat = pos?.coords.latitude ?? null;
    const lng = pos?.coords.longitude ?? null;
    let pendingNotified = false;
    for (const id of voucherIds) {
      try {
        const { data } = await supabase.rpc("record_payment_gps", {
          p_income_expense_id: id,
          p_lat: rpcNullable(lat),
          p_lng: rpcNullable(lng),
        });
        const action = (data as any)?.action as string | undefined;
        if (action === "pending_check" && !pendingNotified) {
          pendingNotified = true; // 1 toà = 1 nhắc (server đã dedup thông báo treo)
          toast.info(v5Copy.pendingCheckNotify(""), {
            description: "Thu xong các phòng thì mở Ngày hôm nay của tôi để check nhanh 3–5 phút.",
            duration: 6000,
          });
        } else if (action === "ticked") {
          const t = (data as any)?.tick;
          if (t?.day_rate) {
            toast.success(
              v5Copy.tickedToast(
                Number(t.day_rate),
                Number(t.streak?.current ?? 0),
                Number(t.streak?.next?.days_to_go ?? 0),
                Number(t.streak?.next?.delta ?? 0),
              ),
              { duration: 5000 },
            );
          }
        }
      } catch {
        /* im lặng — không được ảnh hưởng luồng thu */
      }
    }
  } catch {
    /* im lặng */
  }
}
