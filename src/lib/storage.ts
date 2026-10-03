import { FinancialWorkflowError } from './financialWorkflowError';
import { supabase } from "@/integrations/supabase/client";
import { createSignedUrlBatched } from "./signedUrlBatcher";
import { compressImage } from "./imageCompress";
import { isR2Bucket, isR2PublicBucket, parseR2Ref } from "./storage/r2Config";
import { uploadToR2, signR2 } from "./storage/r2Client";
import { uploadResilient, type ResilientUploadOptions } from "./storage/resilientUpload";
import { isAbortError, uploadDeadlineMs, UploadTimeoutError, UploadTooLargeError } from "./uploadDeadline";

export { sanitizeStorageFileName } from "./storageKey";

/**
 * - `identity-original`: ảnh giấy tờ tuỳ thân, giữ nguyên bytes (QR).
 * - `evidence`: ảnh chứng từ tiền — ảnh chụp màn hình điện thoại (bill chuyển
 *   khoản) nén mạnh hơn, ảnh camera giữ mức thường (xem imageCompress).
 */
export type UploadImagePolicy = 'default' | 'identity-original' | 'evidence';

export interface UploadFileOptions {
  imagePolicy?: UploadImagePolicy;
  /**
   * Có truyền = tải bằng đường chịu mạng chập chờn (báo %, tự tải lại khi mạng
   * đứng, huỷ thật được) — chỉ áp cho bucket Supabase, bucket R2 đi như cũ.
   */
  resilient?: ResilientUploadOptions;
  /** Cỡ tối đa SAU khi nén; vượt thì ném UploadTooLargeError trước khi gửi. */
  maxBytes?: number;
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
  const ms = uploadDeadlineMs(body.size);
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
      resolve({ data: null, error: new UploadTimeoutError(ms) });
    }, ms);
  });
  return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
}

/** File đã nằm trong kho: nén có thể đổi cả đường dẫn, định dạng lẫn cỡ so với file đã chọn. */
export interface StoredUpload {
  url: string;
  path: string;
  type: string;
  size: number;
  /** Số đo lần tải — chỉ có ở đường chịu mạng chập chờn (`resilient`). */
  stats?: UploadStats;
}

export interface UploadStats {
  originalBytes: number;
  compressMs: number;
  uploadMs: number;
  attempts: number;
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
  const compressStarted = Date.now();
  const toUpload = options.imagePolicy === 'identity-original'
    ? identityOriginal(file)
    : await compressImage(file, options.imagePolicy === 'evidence' ? { profile: 'evidence' } : {});
  const compressMs = Date.now() - compressStarted;
  if (options.maxBytes !== undefined && toUpload.size > options.maxBytes) {
    throw new UploadTooLargeError(toUpload.size, options.maxBytes);
  }
  let key = path;
  const ext = toUpload !== file ? COMPRESSED_EXT[toUpload.type] : undefined;
  if (ext) {
    key = path.replace(/\.[^./]+$/, "") + ext;
  }
  const stored = { type: toUpload.type, size: toUpload.size };

  // Bucket đã chuyển sang R2 → upload qua Worker (egress $0). Còn lại: Supabase.
  try {
    if (isR2Bucket(bucket)) {
      const url = await uploadToR2(bucket, key, toUpload);
      if (typeof url !== 'string' || !url.trim()) throw new Error('Missing upload receipt');
      return { ...stored, url, path: key };
    }

    if (options.resilient) {
      const done = await uploadResilient(bucket, key, toUpload, options.resilient);
      return {
        ...stored,
        url: getPublicUrl(bucket, done.path),
        path: done.path,
        stats: { originalBytes: file.size, compressMs, uploadMs: done.elapsedMs, attempts: done.attempts },
      };
    }

    const { data, error } = await uploadToStorageWithDeadline(bucket, key, toUpload, {
      cacheControl: "31536000", // 1 năm — file đặt tên theo timestamp, không đổi
      upsert: false,
    });
    if (error) throw error;
    if (!data || data.path !== key) throw new Error('Missing matching upload receipt');
    return { ...stored, url: getPublicUrl(bucket, data.path), path: data.path };
  } catch (error) {
    // Người dùng tự huỷ (gỡ ảnh, đóng hộp): không phải lỗi giao dịch để báo.
    if (isAbortError(error)) throw error;
    // Đường chịu mạng chập chờn đã tự tải lại và dọn lần gửi dở: tệp chưa được ghi
    // nhận, chọn tải lại (tên mới) là an toàn — không phải ca "kết quả chưa rõ".
    if (options.resilient && error instanceof UploadTimeoutError) {
      throw new FinancialWorkflowError(
        `Mạng chậm — quá ${Math.round((error.ms ?? 0) / 1000)} giây chưa tải xong tệp. Tệp chưa được lưu; bấm Thử lại khi mạng ổn hơn.`,
        'failure', [], error);
    }
    const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : null;
    const rejected = status !== null && [400,401,403,404,405,409,413,415,422,429].includes(status);
    const message = rejected
      ? 'Máy chủ đã từ chối tải tệp. Giữ tệp và kiểm tra quyền hoặc điều kiện tải tệp trước khi thử lại.'
      : (error instanceof UploadTimeoutError ? 'Tải file quá lâu. ' : '') + 'Chưa xác nhận được tệp đã tải. Giữ tệp và đường dẫn để đối chiếu; không tải lại tệp này khi kết quả còn chưa rõ.';
    throw new FinancialWorkflowError(message, rejected ? 'failure' : 'unknown',
      rejected ? [] : [{ id: `${bucket}/${key}`, label: 'Đường dẫn tệp cần đối chiếu' }], error);
  }
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
