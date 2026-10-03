// Luật chung khi tải ảnh/tệp CHỨNG TỪ thu chi (03/10/2026) — dùng cho cả form tạo
// phiếu (`AttachmentUpload`) lẫn hộp Chi / Duyệt và Chi. Tách khỏi file component để
// không vướng luật fast-refresh và để test thuần.

/** Cỡ tối đa của tệp NẰM TRONG KHO: PDF nguyên bản, ảnh thì tính SAU khi nén. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Ảnh gốc trước khi nén. Trước 03/10/2026 giới hạn 5 MB áp lên ảnh GỐC nên ảnh
 * chụp camera đời mới (5–8 MB) bị từ chối oan, dù nén xong chỉ còn vài trăm KB.
 */
export const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024;

/** Chọn nhiều ảnh thì tải cùng lúc tối đa chừng này tấm. */
export const PARALLEL_UPLOADS = 3;

/**
 * Chạy `worker` cho từng phần tử, tối đa `limit` việc cùng lúc; kết quả giữ đúng
 * thứ tự đầu vào.
 */
export async function runLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Đuôi ngẫu nhiên cho tên tệp: tải song song cùng mili-giây không trùng khoá. */
export function uploadToken(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}
