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

// Xác thực: trả về user id nếu token Supabase hợp lệ (đã đăng nhập), ngược lại null.
// (Trước đây chỉ trả boolean → không biết ai upload nên không chặn được cross-user.)
async function verifyUserId(env: Env, req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    const user = (await res.json().catch(() => null)) as { id?: string } | null;
    return user && typeof user.id === 'string' && user.id ? user.id : null;
  } catch {
    return null;
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

// Sprint 0 containment (AUTHORIZATION-PLAN.md §14.4): upload CHỈ được ghi vào
// bucket public thực sự (room-sale-images) và CHỈ dưới thư mục của chính caller
// (<uid>/...). Chặn ghi đè bucket riêng tư, cross-user overwrite và tuỳ ý chọn key.
const R2_UPLOAD_ALLOWED_BUCKET = 'room-sale-images';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB (client giới hạn 5MB, chừa biên)
const ALLOWED_UPLOAD_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
]);

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
        const userId = await verifyUserId(env, req);
        if (!userId) return json({ error: 'unauthorized' }, 401, headers);
        const key = safeKey(url.searchParams.get('key'));
        if (!key) return json({ error: 'invalid key' }, 400, headers);
        if (!req.body) return json({ error: 'empty body' }, 400, headers);

        // Containment: chỉ bucket public + thư mục của chính caller.
        const requiredPrefix = `${R2_UPLOAD_ALLOWED_BUCKET}/${userId}/`;
        if (!key.startsWith(requiredPrefix)) {
          return json(
            { error: 'forbidden: upload chỉ được ghi vào room-sale-images/<your-uid>/' },
            403,
            headers,
          );
        }

        // Giới hạn kích thước (chặn Content-Length gian lận + đọc thân quá lớn).
        const declaredLen = Number(req.headers.get('Content-Length') || '0');
        if (declaredLen > MAX_UPLOAD_BYTES) {
          return json({ error: 'file too large' }, 413, headers);
        }

        // MIME allowlist (ảnh sale). Không phục vụ như trusted nhưng chặn upload lạ.
        const contentType = (req.headers.get('Content-Type') || 'application/octet-stream')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (!ALLOWED_UPLOAD_MIME.has(contentType)) {
          return json({ error: 'unsupported media type' }, 415, headers);
        }

        // Không cho ghi đè object đã tồn tại (chống cố tình overwrite key người khác/của mình).
        const existing = await env.FILES.head(key);
        if (existing) return json({ error: 'object already exists' }, 409, headers);

        const cacheControl =
          req.headers.get('X-Cache-Control') || 'public, max-age=31536000, immutable';

        // Đọc thân có chốt kích thước cứng (phòng khi Content-Length nói dối).
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_UPLOAD_BYTES) {
          return json({ error: 'file too large' }, 413, headers);
        }

        await env.FILES.put(key, buf, {
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
        if (!(await verifyUserId(env, req))) return json({ error: 'unauthorized' }, 401, headers);
        // Phase 2: cấp presigned GET (HMAC ký URL /file?key&exp&sig do Worker tự stream R2).
        return json({ error: 'sign not enabled yet (phase 2)' }, 501, headers);
      }

      return json({ error: 'not found' }, 404, headers);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500, headers);
    }
  },
};
