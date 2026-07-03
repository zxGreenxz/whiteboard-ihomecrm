// Edge function DEMO-RESET — vỏ gọi public.demo_reset() cho nút Reset trên trang docs.
// Auth: header x-demo-secret (shared secret — docs đã sau Basic-auth; blast radius nhỏ:
// endpoint làm đúng 1 việc không tham số, cooldown 10' enforce Ở DB, log demo_reset_log).
// CẤM thêm tham số/logic vào function này (biên bản hội đồng 2026-07-03).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://ptcrm-docs.vercel.app', 'http://localhost:5273']

function corsFor(req: Request) {
  const origin = req.headers.get('origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'content-type, x-demo-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

serve(async (req) => {
  const cors = corsFor(req)
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  const secret = Deno.env.get('DEMO_RESET_SECRET')
  if (!secret || req.headers.get('x-demo-secret') !== secret) {
    return json(401, { error: 'unauthorized' })
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const { data, error } = await db.rpc('demo_reset')
  if (error) {
    const m = error.message ?? ''
    if (m.includes('COOLDOWN')) {
      return json(429, { error: 'cooldown', retryAfterSec: Number(m.match(/COOLDOWN:(\d+)/)?.[1] ?? 600) })
    }
    if (m.includes('RESET_IN_PROGRESS')) return json(409, { error: 'busy' })
    if (m.includes('TRIPWIRE')) return json(500, { error: 'tripwire', detail: m })
    return json(500, { error: m })
  }
  return json(200, data)
})
