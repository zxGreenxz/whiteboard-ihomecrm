// =============================================================================
// r2Client — client gọi Cloudflare Worker (cổng lưu trữ "storage.<domain>") để:
//   • upload file lên R2 (PUT /upload)            — kèm access token Supabase
//   • ký presigned GET cho file riêng tư (GET /sign) — Phase 2
//
// Bảo mật: KHÔNG có secret R2 ở client. Worker kiểm token Supabase rồi mới ghi/ký.
// =============================================================================

import { supabase } from '@/integrations/supabase/client';
import { STORAGE_GATEWAY, r2PublicUrl } from './r2Config';

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Upload file lên R2 qua Worker. Trả về URL công khai (<base>/<bucket>/<path>).
 * Ném lỗi nếu Worker từ chối — caller (uploadFile) sẽ xử lý/đẩy toast.
 */
export async function uploadToR2(bucket: string, path: string, file: File): Promise<string> {
  if (!STORAGE_GATEWAY) throw new Error('VITE_STORAGE_GATEWAY chưa cấu hình');
  const key = `${bucket}/${path}`;
  const res = await fetch(`${STORAGE_GATEWAY}/upload?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      ...(await authHeader()),
      'Content-Type': file.type || 'application/octet-stream',
      'X-Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: file,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`R2 upload failed (${res.status}): ${detail}`);
  }
  return r2PublicUrl(bucket, path);
}

/**
 * Ký presigned GET URL cho file R2 riêng tư qua Worker (Phase 2).
 * Trả null khi lỗi → caller fallback giá trị gốc.
 */
export async function signR2(bucket: string, path: string, expiresIn: number): Promise<string | null> {
  if (!STORAGE_GATEWAY) return null;
  const key = `${bucket}/${path}`;
  try {
    const res = await fetch(
      `${STORAGE_GATEWAY}/sign?key=${encodeURIComponent(key)}&exp=${expiresIn}`,
      { headers: await authHeader() },
    );
    if (!res.ok) return null;
    const j = (await res.json().catch((): null => null)) as { url?: string } | null;
    return j?.url || null;
  } catch {
    return null;
  }
}
