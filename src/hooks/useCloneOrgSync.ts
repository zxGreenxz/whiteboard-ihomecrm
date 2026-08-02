// Đồng bộ dữ liệu từ công ty THẬT sang công ty TEST (org sandbox).
//
// Nút bấm KHÔNG chạy bộ chép trực tiếp: bộ chép cần
// session_replication_role='replica' (tắt 407 trigger + kiểm tra FK), mà Supabase
// chỉ cho role `postgres` đặt tham số đó — authenticated và service_role đều nhận
// 42501, SECURITY DEFINER không cứu được. Nên nút chỉ ĐẶT HÀNG
// (clone_org_request_sync_v1), còn job pg_cron 15 giây/lần nhặt đơn và chạy.
// Xem supabase/migrations/20260801070000_clone_org_sync_queue.sql.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export type CloneOrgSyncStatus = {
  org_id: string;
  org_name: string | null;
  last_sync_at: string | null;
  rows_copied: number | null;
  pending: {
    id: number;
    state: 'PENDING' | 'RUNNING' | 'DONE' | 'ERROR';
    requested_at: string;
    error: string | null;
  } | null;
} | null;

/** null = không phải super admin (hoặc chưa có org sandbox). */
export function useCloneOrgSyncStatus() {
  return useQuery({
    queryKey: ['clone-org-sync-status'],
    queryFn: async (): Promise<CloneOrgSyncStatus> => {
      // RPC mới chưa có trong types.ts sinh tự động — types đang có drift sẵn
      // (~92 quan hệ network_*) nên không regen kèm thay đổi này, xem CLAUDE.md.
      const { data, error } = await (supabase.rpc as any)('clone_org_sync_status_v1');
      if (error) throw error;
      return (data ?? null) as CloneOrgSyncStatus;
    },
    // Đang chạy thì hỏi lại mỗi 3 giây để nút tự cập nhật.
    refetchInterval: (q) => {
      const s = q.state.data as CloneOrgSyncStatus;
      return s?.pending && (s.pending.state === 'PENDING' || s.pending.state === 'RUNNING') ? 3000 : false;
    },
    staleTime: 10_000,
    retry: false,
  });
}

export function useCloneOrgSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase.rpc as any)('clone_org_request_sync_v1');
      if (error) throw error;
      return data as { ok: boolean; request_id: number };
    },
    onSuccess: () => {
      toast.success('Đã xếp hàng — bắt đầu chạy trong ~15 giây, xong sau khoảng 10 giây nữa.');
      qc.invalidateQueries({ queryKey: ['clone-org-sync-status'] });
    },
    onError: (e: { message?: string }) => {
      const msg = e?.message ?? '';
      if (msg.includes('SYNC_IN_PROGRESS')) toast.error('Đang có một lượt đồng bộ chạy dở.');
      else if (msg.includes('COOLDOWN')) toast.error('Vừa đồng bộ xong — chờ 2 phút rồi bấm lại.');
      else toast.error(`Không đặt được lệnh đồng bộ: ${msg.slice(0, 200)}`);
    },
  });
}
