// =============================================================================
// r2Config — định tuyến lưu trữ giữa Supabase Storage và Cloudflare R2.
//
// Nguyên tắc (KHÔNG chắp vá): chỉ một bảng cấu hình quyết định bucket nào nằm
// trên R2. Code call-site KHÔNG cần biết — uploadFile()/createSignedUrlFromStored()
// trong storage.ts tự đọc bảng này.
//
//  - R2_PUBLIC_BUCKETS : bucket công khai, đọc thẳng qua custom domain (img.<domain>),
//                        KHÔNG ký URL. Dùng cho trang Phòng trống công khai.
//  - R2_PRIVATE_BUCKETS: bucket riêng tư trên R2, đọc qua presigned GET của Worker
//                        (Phase 2). Egress vẫn $0.
//
// Bucket KHÔNG nằm trong 2 set trên ⇒ vẫn dùng Supabase Storage như cũ.
// =============================================================================

export const R2_PUBLIC_BASE = (import.meta.env.VITE_R2_PUBLIC_BASE || '').replace(/\/+$/, '');
export const STORAGE_GATEWAY = (import.meta.env.VITE_STORAGE_GATEWAY || '').replace(/\/+$/, '');

// Phase 1: để TRỐNG cho tới khi Worker + custom domain sẵn sàng, rồi mới thêm
// 'room-sale-images' (đây là bước "go-live" cuối của Phase 1).
export const R2_PUBLIC_BUCKETS = new Set<string>([
  'room-sale-images',
]);

// Phase 2: thêm dần các bucket riêng tư sau khi Phase 1 xanh.
export const R2_PRIVATE_BUCKETS = new Set<string>([
  // 'payment-receipts', 'customer-images', 'customer-id-cards',
  // 'income-expense-attachments', 'job-attachments', 'meter-images',
  // 'contract-files', 'document-templates', 'avatars', 'documents',
]);

/** Có cấu hình R2 hợp lệ chưa (tránh route sang R2 khi env chưa set). */
export function r2Configured(): boolean {
  return !!R2_PUBLIC_BASE && !!STORAGE_GATEWAY;
}

export function isR2Bucket(bucket: string): boolean {
  return r2Configured() && (R2_PUBLIC_BUCKETS.has(bucket) || R2_PRIVATE_BUCKETS.has(bucket));
}

export function isR2PublicBucket(bucket: string): boolean {
  return R2_PUBLIC_BUCKETS.has(bucket);
}

/** URL công khai của object R2: <base>/<bucket>/<path> (path đã encode từng segment). */
export function r2PublicUrl(bucket: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${R2_PUBLIC_BASE}/${bucket}/${encoded}`;
}

/**
 * Tách { bucket, path } từ một URL R2 đã lưu (khớp R2_PUBLIC_BASE). Trả null nếu
 * không phải URL R2. Dùng để nhận diện giá trị đã migrate sang R2.
 */
export function parseR2Ref(value: string): { bucket: string; path: string } | null {
  if (!value || !R2_PUBLIC_BASE) return null;
  if (!value.startsWith(R2_PUBLIC_BASE + '/')) return null;
  const rest = value.slice(R2_PUBLIC_BASE.length + 1).split('?')[0];
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const bucket = rest.slice(0, slash);
  const path = decodeURIComponent(rest.slice(slash + 1));
  if (!bucket || !path) return null;
  return { bucket, path };
}
