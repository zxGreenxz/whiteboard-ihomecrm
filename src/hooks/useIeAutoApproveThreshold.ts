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
      if (error) throw new Error(error.message);
      return data === null || data === undefined ? null : Number(data);
    },
  });
}

export function useSetIeAutoApproveThreshold() {
  const qc = useQueryClient();
  return async (nguong: number | null): Promise<void> => {
    const { error } = await supabase.rpc('set_ie_auto_approve_threshold_v1', {
      p_threshold: rpcNullable(nguong),
    });
    if (error) throw new Error(error.message);
    await qc.invalidateQueries({ queryKey: [...KHOA_NGUONG_TU_DUYET] });
  };
}
