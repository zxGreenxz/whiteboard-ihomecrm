// Edge function: send-push
// Gửi Web Push (PWA notification) tới mọi thiết bị đã "Bật thông báo" của 1 user.
//
// Hai chế độ gọi:
//   1) Service role (worker zca-js, trigger nội bộ): Authorization = service_role key
//      → tin tưởng body.userId (gửi cho user bất kỳ).
//   2) User JWT (nút "Gửi thông báo thử" trên web): xác thực token → CHỈ gửi cho
//      chính người gọi (bỏ qua body.userId để tránh spam người khác).
//
// Secrets cần đặt (Supabase ▸ Edge Functions ▸ Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:... hoặc https URL)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface SendPushBody {
  userId?: string;
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// Đọc claim `role` từ JWT (chữ ký đã được platform verify_jwt kiểm trước khi vào
// đây) → 'service_role' = gọi nội bộ tin cậy; 'authenticated' = user thường.
function jwtRole(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(b64 + pad))?.role ?? null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@ptcrm.vercel.app';

    if (!vapidPublic || !vapidPrivate) {
      return json(500, { error: 'Thiếu VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY trong secrets' });
    }
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json(401, { error: 'Missing authorization' });

    const body = (await req.json().catch(() => ({}))) as SendPushBody;

    // Xác định user mục tiêu theo chế độ gọi
    let targetUserId: string | null = null;
    const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const isService = token === serviceKey || jwtRole(token) === 'service_role';
    if (isService) {
      targetUserId = body.userId ?? null;
      if (!targetUserId) return json(400, { error: 'service role: body.userId bắt buộc' });
    } else {
      const callerClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: { user }, error } = await callerClient.auth.getUser();
      if (error || !user) return json(401, { error: 'Invalid session' });
      targetUserId = user.id; // chỉ gửi cho chính mình
    }

    const { data: subs, error: subErr } = await adminClient
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', targetUserId)
      .eq('is_active', true);

    if (subErr) return json(500, { error: subErr.message });
    if (!subs || subs.length === 0) {
      return json(200, { ok: true, sent: 0, failed: 0, total: 0, note: 'Chưa có thiết bị nào bật thông báo' });
    }

    const payload = JSON.stringify({
      title: body.title || 'CRM',
      body: body.body || '',
      url: body.url || '/',
      tag: body.tag,
      icon: body.icon || '/pwa-192.png',
      badge: body.badge || '/pwa-192.png',
      data: body.data || {},
    });

    let sent = 0;
    let failed = 0;
    const deadIds: string[] = [];

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          sent++;
        } catch (e) {
          failed++;
          const status = (e as { statusCode?: number })?.statusCode;
          // 404/410 = subscription hết hạn/đã huỷ → dọn
          if (status === 404 || status === 410) deadIds.push(s.id);
        }
      }),
    );

    if (deadIds.length) {
      await adminClient.from('push_subscriptions').update({ is_active: false }).in('id', deadIds);
    }

    return json(200, { ok: true, sent, failed, total: subs.length, pruned: deadIds.length });
  } catch (e) {
    return json(500, { error: String((e as Error)?.message ?? e) });
  }
});
