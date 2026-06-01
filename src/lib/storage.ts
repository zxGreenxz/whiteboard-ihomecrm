import { supabase } from "@/integrations/supabase/client";

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
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(path, file, {
      cacheControl: "3600",
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
export function parseStorageRef(value: string): { bucket: string; path: string } | null {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith('blob:') || value.startsWith('data:')) return null;
  const m = value.match(/\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!m) return null;
  return { bucket: m[1], path: decodeURIComponent(m[2]) };
}

/**
 * Tạo signed URL từ giá trị đã lưu (URL public cũ hoặc path). Nếu không phải file
 * trong Storage (blob/data/URL ngoài) hoặc lỗi → trả lại nguyên giá trị (graceful).
 */
export async function createSignedUrlFromStored(
  value: string,
  expiresIn: number = SIGNED_URL_TTL
): Promise<string> {
  const ref = parseStorageRef(value);
  if (!ref) return value;
  const { data, error } = await supabase.storage
    .from(ref.bucket)
    .createSignedUrl(ref.path, expiresIn);
  if (error || !data?.signedUrl) return value;
  return data.signedUrl;
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
