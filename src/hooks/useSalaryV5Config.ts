import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/integrations/supabase/client';

/**
 * Cấu hình chế độ lương v5 — công tắc ở `/reports/coverage` tab "Cài đặt v5".
 *
 * Trước 11/08/2026 hai trang lương (`ManagerSalaryPage`, `MySalaryPage`) mỗi
 * trang tự viết lại đúng `useQuery` này, cùng query key, cùng `staleTime`, cùng
 * hai lần `as any`. Hai bản chép của một hợp đồng thì sớm muộn cũng lệch — và
 * chúng cùng đọc một cấu hình quyết định TIỀN LƯƠNG, nên lệch ở đây không phải
 * chuyện hiển thị.
 *
 * Gộp về một nơi cũng gỡ được hai `as any`: chỗ ép kiểu duy nhất còn lại là
 * kiểu trả về của RPC, và nó nằm ở đây chứ không rải trong trang.
 */
export const KHOA_V5_CONFIG = ['v5-config-salary-engine'] as const;

export function useSalaryV5Config() {
  return useQuery({
    queryKey: [...KHOA_V5_CONFIG],
    queryFn: async () => {
      const { data } = await supabase.rpc('get_salary_v5_config');
      return data;
    },
    staleTime: 60_000,
  });
}
