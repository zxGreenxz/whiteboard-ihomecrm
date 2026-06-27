// =============================================================================
// ihome-storage Worker — cổng lưu trữ R2.
//   PUT /upload?key=<bucket>/<path>   (Authorization: Bearer <supabase jwt>)
//       → ghi object vào R2, trả { ok, url }. Egress đọc về sau = $0 (qua img.<domain>).
//   GET /sign?key=<bucket>/<path>&exp=<s>  → presigned GET cho file riêng tư (Phase 2).
//   GET /                              → health check.
// Đọc CÔNG KHAI KHÔNG qua Worker (đi thẳng custom domain img.<domain> của bucket).
// =============================================================================

export interface Env {
  FILES: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  R2_PUBLIC_BASE: string;
  ALLOWED_ORIGINS: string;
  SIGN_SECRET?: string;
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = origin && allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'PUT, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Cache-Control',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Xác thực: token Supabase hợp lệ (người dùng đã đăng nhập). apikey = anon (công khai).
async function verifyUser(env: Env, req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Chỉ cho phép key dạng <bucket>/<path> ký tự an toàn; chặn path traversal.
function safeKey(key: string | null): string | null {
  if (!key) return null;
  if (key.includes('..') || key.startsWith('/') || key.includes('//')) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(key)) return null;
  if (key.length > 1024) return null;
  return key;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin');
    const headers = corsHeaders(env, origin);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'ihome-storage' }, 200, headers);
    }

    try {
      if (url.pathname === '/upload' && req.method === 'PUT') {
        if (!(await verifyUser(env, req))) return json({ error: 'unauthorized' }, 401, headers);
        const key = safeKey(url.searchParams.get('key'));
        if (!key) return json({ error: 'invalid key' }, 400, headers);
        if (!req.body) return json({ error: 'empty body' }, 400, headers);

        const contentType = req.headers.get('Content-Type') || 'application/octet-stream';
        const cacheControl =
          req.headers.get('X-Cache-Control') || 'public, max-age=31536000, immutable';

        await env.FILES.put(key, req.body, {
          httpMetadata: { contentType, cacheControl },
        });
        return json({ ok: true, url: `${env.R2_PUBLIC_BASE}/${key}` }, 200, headers);
      }

      // Phục vụ ảnh CÔNG KHAI kèm CORS (cho fetch tải/chia sẻ của sale). Hiển thị
      // <img> vẫn dùng img.<domain> trực tiếp (cache edge, không tốn Worker); endpoint
      // này chỉ dùng khi cần fetch cross-origin (CORS). Chỉ cho bucket công khai.
      if (url.pathname === '/file' && req.method === 'GET') {
        const key = safeKey(url.searchParams.get('key'));
        if (!key) return json({ error: 'invalid key' }, 400, headers);
        if (!key.startsWith('room-sale-images/')) return json({ error: 'forbidden' }, 403, headers);
        const obj = await env.FILES.get(key);
        if (!obj) return json({ error: 'not found' }, 404, headers);
        return new Response(obj.body, {
          status: 200,
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      if (url.pathname === '/sign' && req.method === 'GET') {
        if (!(await verifyUser(env, req))) return json({ error: 'unauthorized' }, 401, headers);
        // Phase 2: cấp presigned GET (HMAC ký URL /file?key&exp&sig do Worker tự stream R2).
        return json({ error: 'sign not enabled yet (phase 2)' }, 501, headers);
      }

      return json({ error: 'not found' }, 404, headers);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500, headers);
    }
  },
};
