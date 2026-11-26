import {financialReadNumber} from '@/lib/financialReadValidation';
import {jsonProp} from '@/lib/jsonValue';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpcNullable } from "@/lib/rpcNullable";

import { supabase } from '@/integrations/supabase/client';

/**
 * Ngưỡng tự duyệt phiếu chi: phiếu từ mức này trở lên sinh ở trạng thái CHỜ
 * DUYỆT thay vì tự duyệt. `null` = bỏ ngưỡng, mọi phiếu chi thường tự duyệt.
 *
 * Đọc và ghi để cạnh nhau vì chúng dùng CHUNG một query key: tách ra hai nơi thì
 * người sửa đường ghi rất dễ quên vô hiệu hoá cache của đường đọc, và giao diện
 * sẽ hiện ngưỡng cũ sau khi lưu — kiểu sai im lặng, không có thông báo lỗi nào.
 */
export const KHOA_NGUONG_TU_DUYET = ['ie-auto-approve-threshold'] as const;

export function useIeAutoApproveThreshold() {
  return useQuery({
    queryKey: [...KHOA_NGUONG_TU_DUYET],
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await supabase.rpc('get_ie_auto_approve_threshold_v1');
      if (error) throw error;
      return data === null ? null : financialReadNumber(data);
    },
  });
}

/**
 * Đợt 8 (luật 5): set_ie_auto_approve_threshold_v1 (production 26/11/2026) upsert ĐÚNG một dòng cấu hình theo công ty với
 * giá trị tuyệt đối (không cộng dồn, không so phiên bản), nên lưu lại cho cùng kết quả: không giữ dấu «chờ đối chiếu» nào.
 * Chưa rõ kết quả (mất mạng, biên nhận lệch ngưỡng / thiếu công ty) ⇒ lỗi lặp lại được, nút không khoá, bấm lại gửi đúng
 * ngưỡng đó. Dấu bản trước (phạm vi người dùng, khoá `settings`) gỡ sau khi lưu xong.
 */
export function useSetIeAutoApproveThreshold() {
  const qc = useQueryClient();
  return async (nguong: number | null): Promise<void> => {
    // Nạp động: tệp này chưa từng nạp tĩnh module đó (cửa bundle-inventory).
    const { repeatableWrite } = await import('@/lib/recordWriteOutcome');
    await repeatableWrite("lưu ngưỡng tự duyệt phiếu chi", async () => {
      const { data, error } = await supabase.rpc('set_ie_auto_approve_threshold_v1', {
        p_threshold: rpcNullable(nguong),
      });
      if (error) throw error;
      const orgId=jsonProp(data,"organization_id");
      const returned=jsonProp(data,"threshold");
      if(typeof orgId!=="string"||!orgId||returned===undefined||(nguong===null?returned!==null:financialReadNumber(returned)!==nguong))throw new TypeError("Chưa xác nhận được ngưỡng tự duyệt đã lưu.");
    });
    try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'auto-approve-threshold', businessKey: 'settings' }, { organizationId: 'actor-scope' }); }
    catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần lưu sau gỡ lại. */ }
    await qc.invalidateQueries({ queryKey: [...KHOA_NGUONG_TU_DUYET] });
  };
}
