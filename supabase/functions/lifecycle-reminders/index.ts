import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';
import { runLifecycleReminders } from './runner.ts';

// Deploy with verify_jwt=true. Also require the exact dedicated service credential;
// decoding a supplied JWT role is never sufficient authorization for this sweep.
// Mỗi lượt cron 15' chạy 3 pha (bảo trì → lifecycle → drain push chung, xem runner.ts):
// 200 khi cả ba pha ok, 503 khi có pha lỗi (JSON trả từng pha), 500 chỉ khi ngoại lệ ngoài dự kiến.
// Hàm import ../_shared/push-drain.ts ⇒ mọi đường deploy phải đưa file đó lên cùng: CLI
// `supabase functions deploy lifecycle-reminders` tự bundle; Management API multipart dùng quy ước tên file tính từ
// gốc repo (scripts/test-env/edge.mjs `dungGoiDeploy`, cũng là đường `npm run test-env:edge -- lifecycle-reminders`).
Deno.serve(async (request: Request) => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const internalKey = Deno.env.get('LIFECYCLE_REMINDERS_SERVICE_JWT');
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!internalKey || !token || token !== internalKey) return Response.json({ error: 'Service authorization required' }, { status: 401 });
  if (!url || !key) return Response.json({ error: 'Server configuration missing' }, { status: 500 });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  try {
    const result = await runLifecycleReminders((name, args) => admin.rpc(name, args), fetch, url, key);
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    console.error('[lifecycle-reminders]', String(error));
    return Response.json({ ok: false, error: 'Lifecycle sweep/delivery failed' }, { status: 500 });
  }
});
