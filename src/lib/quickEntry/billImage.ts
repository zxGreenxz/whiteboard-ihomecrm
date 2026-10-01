// Cỡ ảnh bill gửi AI: đủ nét để đọc chữ nhỏ trên hoá đơn, nhưng cả gói JSON (ảnh base64 + prompt)
// phải nằm dưới trần body của hàm máy chủ `quick-entry` (768 KiB; ngân sách ảnh vẫn giữ theo mốc 512
// KiB cũ — cỡ này đã đọc đúng bill khi đo 01/10). Thử lần lượt các nấc (cạnh dài, chất lượng JPEG)
// tới khi vừa ngân sách. Phần vẽ canvas chạy trên trình duyệt và được truyền vào dưới dạng
// `encode` — nhờ vậy thứ tự thử và ngân sách test được không cần canvas.
//
// Ảnh LƯU làm chứng từ đi đường khác (`uploadFileDetailed` → compressImage), không qua đây.

export interface LadderStep {
  maxEdge: number;
  quality: number;
}

export const BILL_IMAGE_LADDER: readonly LadderStep[] = [
  { maxEdge: 1600, quality: 0.75 },
  { maxEdge: 1400, quality: 0.68 },
  { maxEdge: 1280, quality: 0.6 },
];

/** Byte ảnh thô tối đa: base64 ~480 KB + prompt dưới 512 KiB, dư xa trần 768 KiB của máy chủ. */
export const MAX_BILL_IMAGE_BYTES = 360_000;

/** Độ dài base64 (không xuống dòng) của `bytes` byte. */
export const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/** Thu nhỏ giữ tỉ lệ để cạnh dài ≤ maxEdge; không phóng to. */
export function scaledSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Nấc đầu tiên cho ảnh vừa ngân sách; null nếu không nấc nào vừa. Nấc lỗi thì thử nấc kế. */
export async function encodeWithinBudget(
  encode: (step: LadderStep) => Promise<Blob>,
  budget: number = MAX_BILL_IMAGE_BYTES,
): Promise<{ blob: Blob; step: LadderStep } | null> {
  for (const step of BILL_IMAGE_LADDER) {
    try {
      const blob = await encode(step);
      if (blob.size <= budget) return { blob, step };
    } catch {
      // canvas hết bộ nhớ / giải mã lỗi ở cỡ này ⇒ thử cỡ nhỏ hơn
    }
  }
  return null;
}
