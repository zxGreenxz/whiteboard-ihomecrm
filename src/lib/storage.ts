import { supabase } from "@/integrations/supabase/client";
import { createSignedUrlBatched } from "./signedUrlBatcher";
import { compressImage } from "./imageCompress";
import { isR2Bucket, isR2PublicBucket, parseR2Ref } from "./storage/r2Config";
import { uploadToR2, signR2 } from "./storage/r2Client";
import { uploadDeadlineMs, UploadTimeoutError } from "./uploadDeadline";

export { sanitizeStorageFileName } from "./storageKey";

export type UploadImagePolicy = 'default' | 'identity-original';

export interface UploadFileOptions {
  imagePolicy?: UploadImagePolicy;
}

const IDENTITY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IDENTITY_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

function identityOriginal(file: File): File {
  if (!IDENTITY_IMAGE_MIME_TYPES.has(file.type)) {
    throw new Error('Identity images must be PNG or JPEG files');
  }
  if (file.size > IDENTITY_IMAGE_MAX_BYTES) {
    throw new Error('Identity images must not exceed 10MB');
  }
  return file;
}

/** Đuôi file theo định dạng ảnh nén ra (compressImage chỉ xuất hai loại này). */
const COMPRESSED_EXT: Record<string, string> = {
  "image/webp": ".webp",
  "image/jpeg": ".jpg",
};

export { uploadDeadlineMs, UploadTimeoutError } from "./uploadDeadline";

/**
 * Tải lên Supabase Storage có hạn chờ `uploadDeadlineMs`. Cùng khuôn kết quả với
 * storage-js — `{ data, error }`: quá hạn KHÔNG ném mà trả `error` là
 * UploadTimeoutError, thay vì treo "Đang tải..." mãi. (storage-js tự ném — hiếm,
 * nó đã gói lỗi mạng thành StorageUnknownError — thì lỗi đó vẫn lan ra như cũ.)
 *
 * storage-js không nhận AbortSignal cho upload, nên hạn chờ chỉ dừng việc CHỜ;
 * request kẹt vẫn chạy ngầm. Nếu nó xong sau hạn thì xoá file đó — người dùng đã
 * được báo lỗi và sẽ tải lại, file này không ai dùng nữa.
 */
export async function uploadToStorageWithDeadline(
  bucket: string,
  key: string,
  body: File,
  fileOptions: { cacheControl?: string; contentType?: string; upsert?: boolean },
) {
  const request = supabase.storage.from(bucket).upload(key, body, fileOptions);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ data: null; error: UploadTimeoutError }>((resolve) => {
    timer = setTimeout(() => {
      void request
        .then(async ({ data }) => {
          if (!data?.path) return;
          // remove() báo lỗi qua `error`, không ném — phải đọc mới biết xoá hỏng.
          const { error } = await supabase.storage.from(bucket).remove([data.path]);
          if (error) console.warn("[storage] không xoá được file tải xong sau hạn:", error.message);
        })
        .catch((cleanupError: unknown) => {
          console.warn("[storage] không xoá được file tải xong sau hạn:", cleanupError);
        });
      resolve({ data: null, error: new UploadTimeoutError() });
    }, uploadDeadlineMs(body.size));
  });
  return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
}

/** File đã nằm trong kho: nén có thể đổi cả đường dẫn, định dạng lẫn cỡ so với file đã chọn. */
export interface StoredUpload {
  url: string;
  path: string;
  type: string;
  size: number;
}

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
  file: File,
  options: UploadFileOptions = {},
): Promise<string> {
  return (await uploadFileDetailed(bucket, path, file, options)).url;
}

/**
 * Như uploadFile nhưng trả cả đường dẫn/định dạng/cỡ THẬT. Nơi nào ghi lại
 * ĐƯỜNG DẪN (không chỉ URL) để máy khác tải về — vd job gửi media Zalo — phải
 * dùng hàm này: nén đổi đuôi key, đường dẫn tự tính từ tên file gốc sẽ trỏ vào
 * một file không tồn tại.
 */
export async function uploadFileDetailed(
  bucket: string,
  path: string,
  file: File,
  options: UploadFileOptions = {},
): Promise<StoredUpload> {
  // Nén ảnh trước khi upload (giảm kho + băng thông egress). Nén ra WebP/JPEG thì
  // đổi đuôi key cho khớp content-type; non-image giữ nguyên file & key. Ảnh
  // giấy tờ được kiểm tra rồi lưu đúng bytes gốc để không làm mất chi tiết QR.
  const toUpload = options.imagePolicy === 'identity-original'
    ? identityOriginal(file)
    : await compressImage(file);
  let key = path;
  const ext = toUpload !== file ? COMPRESSED_EXT[toUpload.type] : undefined;
  if (ext) {
    key = path.replace(/\.[^./]+$/, "") + ext;
  }
  const stored = { type: toUpload.type, size: toUpload.size };

  // Bucket đã chuyển sang R2 → upload qua Worker (egress $0). Còn lại: Supabase.
  if (isR2Bucket(bucket)) {
    return { ...stored, url: await uploadToR2(bucket, key, toUpload), path: key };
  }

  const { data, error } = await uploadToStorageWithDeadline(bucket, key, toUpload, {
    cacheControl: "31536000", // 1 năm — file đặt tên theo timestamp, không đổi
    upsert: false,
  });

  if (error) {
    throw error;
  }

  return { ...stored, url: getPublicUrl(bucket, data.path), path: data.path };
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
  const bucket = m?.[1];
  const path = m?.[2];
  if (!bucket || !path) return null;
  return { bucket, path: decodeURIComponent(path) };
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
