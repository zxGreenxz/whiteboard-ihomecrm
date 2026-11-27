import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const provider = z.enum(['nous', '9router']);
const app = z.enum(['quick_read', 'wallet_read', 'quick_stt', 'meter_vision']);
const route = z.object({ provider, model: z.string() });
const settings = z.object({
  apps: z.array(z.object({ app, revision: z.number().int(), routes: z.array(route) })),
  catalogs: z.array(z.object({ provider, synced_at: z.string(), models: z.array(z.object({ id: z.string(), vision: z.boolean(), text: z.boolean(), verified: z.boolean().optional(), tested: z.boolean().optional() })) })),
  enabled: z.boolean(), ready: z.object({ nous: z.boolean(), '9router': z.boolean() }), syncErrors: z.array(provider),
});
export type AiSettings = z.infer<typeof settings>;
export type AiProvider = z.infer<typeof provider>;
export type AiApp = z.infer<typeof app>;
export type AiRoute = z.infer<typeof route>;
type Change = { action: 'sync' } | { action: 'save'; app: AiApp; revision: number; routes: AiRoute[] };

async function invoke(body: Change | { action: 'read' } | { action: 'verify'; provider: AiProvider; model: string; snapshot: string }) {
  const { data, error } = await supabase.functions.invoke('ai-routing', { body });
  if (error) {
    const response = error.context;
    const status = response instanceof Response ? response.status : 0;
    if (status === 409) throw Error('Cấu hình vừa được người khác thay đổi. Tải lại trước khi lưu.');
    if (status === 403 || status === 401) throw Error('Cần đăng nhập bằng tài khoản quản trị hệ thống.');
    if (status === 422) throw Error('Model hoặc nguồn chưa sẵn sàng. Kiểm tra kết nối và đồng bộ lại danh mục.');
    throw Error('Chưa kết nối được dịch vụ cấu hình AI.');
  }
  return data as unknown;
}

export async function verifyModel(provider: AiProvider, model: string, snapshot: string) {
  return z.object({ passed: z.boolean(), stop: z.boolean() }).parse(await invoke({ action: 'verify', provider, model, snapshot }));
}

async function request(body: Change | { action: 'read' }) {
  const result = settings.safeParse(await invoke(body));
  if (!result.success) throw Error('Dữ liệu cấu hình AI trả về chưa hợp lệ.');
  return result.data;
}

export function useAiRouting() {
  const auth = useAuth();
  const user = auth.data?.id;
  const cache = useQueryClient();
  const key = ['ai-routing', user] as const;
  const query = useQuery({ queryKey: key, queryFn: () => request({ action: 'read' }), enabled: !!user, retry: false });
  const change = useMutation({ mutationFn: request, onSuccess: value => cache.setQueryData(key, value) });
  return { query, change };
}
