// =============================================================================
// signedUrlBatcher — gom các yêu cầu ký signed URL trong cửa sổ ngắn rồi gọi
// createSignedUrls (batch) 1 lần / bucket thay vì N request createSignedUrl
// riêng lẻ. Trang 20-50 ảnh trước đây bắn 20-50 POST /object/sign → còn 1-2.
// KHÔNG bao giờ reject: lỗi → resolve null để caller fallback giá trị gốc.
// =============================================================================

import { supabase } from '@/integrations/supabase/client';

type Batch = {
  paths: string[];
  resolvers: ((url: string | null) => void)[];
};

const batches = new Map<string, Batch>(); // key: `${bucket}\0${expiresIn}`
const BATCH_WINDOW_MS = 10;
const MAX_BATCH = 100;

export function createSignedUrlBatched(
  bucket: string,
  path: string,
  expiresIn: number
): Promise<string | null> {
  const key = `${bucket}\u0000${expiresIn}`;
  let batch = batches.get(key);
  if (!batch) {
    const created: Batch = { paths: [], resolvers: [] };
    batches.set(key, created);
    setTimeout(() => {
      batches.delete(key);
      void flush(bucket, expiresIn, created);
    }, BATCH_WINDOW_MS);
    batch = created;
  }
  return new Promise((resolve) => {
    batch!.paths.push(path);
    batch!.resolvers.push(resolve);
  });
}

async function flush(bucket: string, expiresIn: number, batch: Batch) {
  for (let i = 0; i < batch.paths.length; i += MAX_BATCH) {
    const paths = batch.paths.slice(i, i + MAX_BATCH);
    const resolvers = batch.resolvers.slice(i, i + MAX_BATCH);
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrls(paths, expiresIn);
      if (error || !data) {
        resolvers.forEach((resolve) => resolve(null));
        continue;
      }
      // data[] giữ đúng thứ tự input (kể cả path trùng); item lỗi → signedUrl rỗng
      resolvers.forEach((resolve, j) => resolve(data[j]?.signedUrl || null));
    } catch {
      resolvers.forEach((resolve) => resolve(null));
    }
  }
}
