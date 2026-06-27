import { supabase } from "@/integrations/supabase/client";
import { createSignedUrlBatched } from "./signedUrlBatcher";
import { compressImage } from "./imageCompress";
import { isR2Bucket, isR2PublicBucket, parseR2Ref } from "./storage/r2Config";
import { uploadToR2, signR2 } from "./storage/r2Client";

export { sanitizeStorageFileName } from "./storageKey";

/**
 * Upload a file to Supabase Storage
 * @param bucket - The storage bucket name
 * @param path - The file path in the bucket
 * @param file - The file to upload
 * @returns The public URL of the uploaded file
 */
export async function uploadFile(
  bucket: string,
  path: string,
  file: File
): Promise<string> {
  // Nén ảnh trước khi upload (giảm kho + băng thông egress). Nếu nén ra WebP thì
  // đổi đuôi key cho khớp content-type; non-image giữ nguyên file & key.
  const toUpload = await compressImage(file);
  let key = path;
  if (toUpload !== file && toUpload.type === "image/webp") {
    key = path.replace(/\.[^./]+$/, "") + ".webp";
  }

  // Bucket đã chuyển sang R2 → upload qua Worker (egress $0). Còn lại: Supabase.
  if (isR2Bucket(bucket)) {
    return uploadToR2(bucket, key, toUpload);
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(key, toUpload, {
      cacheControl: "31536000", // 1 năm — file đặt tên theo timestamp, không đổi
      upsert: false,
    });

  if (error) {
    throw error;
  }

  return getPublicUrl(bucket, data.path);
}

/**
 * Get the public URL for a file in storage
 * @param bucket - The storage bucket name
 * @param path - The file path in the bucket
 * @returns The public URL
 */
export function getPublicUrl(bucket: string, path: string): string {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

// =============================================================================
// Signed URLs cho bucket private.
// Lý do: các bucket ảnh đã chuyển từ public → private để không lộ ra Internet.
// Dữ liệu đang lưu trong DB là URL public dạng .../object/public/<bucket>/<path>.
// Các helper dưới đây tách lại <bucket>/<path> từ URL đã lưu và tạo signed URL
// (có hạn) để hiển thị. KHÔNG đổi cách upload/lưu → không cần migrate dữ liệu cũ.
// =============================================================================

export const SIGNED_URL_TTL = 3600; // 1 giờ

/**
 * Tách { bucket, path } từ một giá trị đã lưu.
 * Nhận diện URL Supabase Storage dạng /object/public|sign|authenticated/<bucket>/<path>.
 * Trả về null cho blob:/data:/URL ngoài → caller dùng nguyên giá trị.
 */
function parseSupabaseRef(value: string): { bucket: string; path: string } | null {
  const m = value.match(/\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!m) return null;
  return { bucket: m[1], path: decodeURIComponent(m[2]) };
}

/**
 * Tách { bucket, path } để quyết định "có phải file Storage cần ký không".
 * Trả null cho blob:/data:/URL ngoài VÀ URL R2 CÔNG KHAI (đọc thẳng, không ký).
 * Trả { bucket, path } cho URL Supabase, hoặc URL R2 RIÊNG TƯ (ký qua Worker).
 */
export function parseStorageRef(value: string): { bucket: string; path: string } | null {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith('blob:') || value.startsWith('data:')) return null;
  const r2 = parseR2Ref(value);
  if (r2) return isR2PublicBucket(r2.bucket) ? null : r2; // public R2 → dùng nguyên giá trị
  return parseSupabaseRef(value);
}

/**
 * Tạo signed URL từ giá trị đã lưu (URL public cũ hoặc path). Nếu không phải file
 * trong Storage (blob/data/URL ngoài) hoặc lỗi → trả lại nguyên giá trị (graceful).
 */
export async function createSignedUrlFromStored(
  value: string,
  expiresIn: number = SIGNED_URL_TTL
): Promise<string> {
  // R2: công khai → dùng thẳng (custom domain có cache); riêng tư → presigned GET
  // qua Worker (Phase 2). Egress $0 ở cả hai.
  const r2 = parseR2Ref(value);
  if (r2) {
    if (isR2PublicBucket(r2.bucket)) return value;
    const signed = await signR2(r2.bucket, r2.path, expiresIn);
    return signed ?? value;
  }
  const ref = parseSupabaseRef(value);
  if (!ref) return value;
  // Ký theo BATCH: các yêu cầu trong cùng tick gom thành 1 request / bucket
  // (trang nhiều ảnh từng bắn 20-50 POST /object/sign riêng lẻ).
  const signed = await createSignedUrlBatched(ref.bucket, ref.path, expiresIn);
  return signed ?? value;
}

/**
 * Mở file Storage trong tab mới qua signed URL. Mở window trước (đồng bộ) để
 * tránh popup blocker, rồi gán URL sau khi ký xong.
 */
export async function openStoredFile(value: string): Promise<void> {
  if (!value) return;
  const w = window.open('', '_blank', 'noopener,noreferrer');
  const url = await createSignedUrlFromStored(value);
  if (w) w.location.href = url;
  else window.location.href = url;
}

/**
 * List all files in a bucket
 * @param bucket - The storage bucket name
 * @param folder - Optional folder path
 * @returns Array of files
 */
export async function listFiles(bucket: string, folder?: string) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .list(folder, {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Delete a file from storage
 * @param bucket - The storage bucket name
 * @param path - The file path to delete
 */
export async function deleteFile(bucket: string, path: string) {
  const { error } = await supabase.storage.from(bucket).remove([path]);

  if (error) {
    throw error;
  }
}

/**
 * Download a file from storage
 * @param bucket - The storage bucket name
 * @param path - The file path to download
 * @returns The file blob
 */
export async function downloadFile(bucket: string, path: string) {
  const { data, error } = await supabase.storage.from(bucket).download(path);

  if (error) {
    throw error;
  }

  return data;
}
