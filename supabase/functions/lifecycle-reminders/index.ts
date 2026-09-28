import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';
import { runLifecycleReminders } from './runner.ts';

// Deploy with verify_jwt=true. Also require the exact dedicated service credential;
// decoding a supplied JWT role is never sufficient authorization for this sweep.
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
