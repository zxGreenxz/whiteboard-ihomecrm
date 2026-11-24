import { useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

/**
 * Nhật ký tự gỡ khoá «chờ đối chiếu» của MỘT công ty (đợt 1b, `pending_valve_release_log_list_v1`, migration
 * 20261124131052). Máy chủ chỉ trả dòng cho superadmin và chủ công ty theo nghĩa chặt; người khác nhận
 * `allowed: false` để giao diện ẩn mục. Mới nhất trước, mỗi trang `PENDING_VALVE_RELEASE_LOG_PAGE` dòng.
 */
export const PENDING_VALVE_RELEASE_LOG_PAGE = 20;

const rowSchema = z.object({
  id: z.string().min(1),
  entryId: z.string().min(1),
  actorUserId: z.string().min(1),
  actorName: z.string().nullable(),
  organizationSource: z.enum(['pending', 'context', 'sole_membership']),
  namespace: z.string().min(1),
  businessKey: z.string(),
  operation: z.string().nullable(),
  attemptId: z.string(),
  recordIds: z.array(z.string()),
  recordCount: z.number().int().nonnegative(),
  stuckAt: z.string().min(1),
  releasedAt: z.string().min(1),
  receivedAt: z.string().min(1),
  device: z.string().nullable(),
});
const pageSchema = z.object({
  organizationId: z.string().min(1),
  allowed: z.boolean(),
  rows: z.array(rowSchema),
  hasMore: z.boolean(),
});
export type PendingValveReleaseLogRow = z.infer<typeof rowSchema>;
export type PendingValveReleaseLogPage = z.infer<typeof pageSchema>;
type Cursor = { releasedAt: string; id: string };

type ListArgs = {
  p_organization_id: string;
  p_limit: number;
  p_before_released_at: string | null;
  p_before_id: string | null;
};
// Hàm mới chưa có trong kiểu sinh từ production cho tới khi migration 20261124131052 được áp; chữ ký khai tay, phản
// hồi luôn kiểm bằng zod.
type ListRpc = (name: 'pending_valve_release_log_list_v1', args: ListArgs) => PromiseLike<{ data: unknown; error: unknown }>;

export async function readPendingValveReleaseLogPage(organizationId: string, cursor: Cursor | null): Promise<PendingValveReleaseLogPage> {
  const { data, error } = await (supabase.rpc as unknown as ListRpc)('pending_valve_release_log_list_v1', {
    p_organization_id: organizationId,
    p_limit: PENDING_VALVE_RELEASE_LOG_PAGE,
    p_before_released_at: cursor?.releasedAt ?? null,
    p_before_id: cursor?.id ?? null,
  });
  if (error) throw error;
  const page = pageSchema.parse(data);
  if (page.organizationId !== organizationId) throw new Error('Nhật ký trả về thuộc công ty khác.');
  return page;
}

export function usePendingValveReleaseLog(organizationId: string | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['pending-valve-release-log', organizationId],
    enabled: enabled && !!organizationId,
    staleTime: 30_000,
    meta: { label: 'nhật ký tự gỡ khoá', errorDisplay: 'inline' },
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam }) => readPendingValveReleaseLogPage(organizationId!, pageParam),
    getNextPageParam: (last): Cursor | undefined => {
      const tail = last.rows.at(-1);
      return last.hasMore && tail ? { releasedAt: tail.releasedAt, id: tail.id } : undefined;
    },
  });
}
