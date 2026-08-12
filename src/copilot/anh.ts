// Chuẩn bị ảnh người dùng gửi vào chat.
//
// Ảnh KHÔNG được lưu ở đâu cả: nó sống trong đúng một request rồi biến mất, và
// `ai_chat_messages` chỉ ghi placeholder `[ảnh]`. Đó là lựa chọn thiết kế chứ
// không phải thiếu sót — lưu ảnh kéo theo một bucket mới, một chính sách
// retention, và bài toán PII cho thứ người dùng chụp bừa (CCCD, biên lai có số
// tài khoản). Ca dùng đầu tiên là ĐỌC HỘ rồi chỉ chỗ nhập, không phải lưu trữ.
//
// Phần toán tách khỏi phần canvas: `tinhKichThuoc` và `uocByteTuDataUrl` là hàm
// thuần, test được bằng Vitest; canvas chỉ có trong trình duyệt.

/** Cạnh dài tối đa sau khi nén. Đủ để đọc chỉ số công tơ và số trên biên lai. */
export const CANH_TOI_DA = 1024;

/**
 * Trần kích thước ảnh SAU nén.
 *
 * Edge Function có giới hạn body, và một ảnh base64 phình ~33% so với nhị phân.
 * Chặn ở client để người dùng nhận lời từ chối tức thì kèm lý do, thay vì chờ
 * một vòng mạng rồi ăn lỗi 413 không ai đọc hiểu.
 */
export const TRAN_BYTE = 1_500_000;

export const LOAI_ANH_NHAN = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Kích thước sau khi thu nhỏ, giữ nguyên tỉ lệ.
 *
 * KHÔNG phóng to ảnh nhỏ: một ảnh 300px phóng lên 1024 không thêm thông tin nào
 * mà làm nặng request lên hơn mười lần.
 */
export function tinhKichThuoc(
  rong: number,
  cao: number,
  canhToiDa = CANH_TOI_DA,
): { rong: number; cao: number } {
  if (rong <= 0 || cao <= 0) return { rong: 0, cao: 0 };
  const lonNhat = Math.max(rong, cao);
  if (lonNhat <= canhToiDa) return { rong, cao };
  const tiLe = canhToiDa / lonNhat;
  return { rong: Math.round(rong * tiLe), cao: Math.round(cao * tiLe) };
}

/** Số byte thật mà một data URL base64 mang theo. */
export function uocByteTuDataUrl(dataUrl: string): number {
  const i = dataUrl.indexOf(',');
  if (i < 0) return 0;
  const b64 = dataUrl.slice(i + 1);
  const dem = (b64.match(/=+$/)?.[0].length ?? 0);
  return Math.max(0, Math.floor((b64.length * 3) / 4) - dem);
}

export interface AnhDaNen {
  dataUrl: string;
  byte: number;
  rong: number;
  cao: number;
}

/**
 * Đọc file ảnh, thu nhỏ và nén sang JPEG.
 *
 * Luôn ra JPEG kể cả khi đầu vào là PNG: ảnh chụp màn hình/chụp máy dạng PNG
 * thường nặng gấp nhiều lần JPEG cùng chất lượng nhìn, và ở đây mục tiêu là mô
 * hình ĐỌC được chữ trong ảnh chứ không phải giữ nguyên pixel.
 *
 * Ném lỗi tiếng Việt khi vượt trần hoặc sai định dạng — chuỗi này hiển thị
 * thẳng cho người dùng.
 */
export async function nenAnh(file: File, canhToiDa = CANH_TOI_DA): Promise<AnhDaNen> {
  if (!LOAI_ANH_NHAN.includes(file.type)) {
    throw new Error(`Chỉ nhận ảnh JPG, PNG, WEBP hoặc GIF (bạn gửi "${file.type || 'không rõ'}").`);
  }
  const bitmap = await createImageBitmap(file);
  try {
    const { rong, cao } = tinhKichThuoc(bitmap.width, bitmap.height, canhToiDa);
    const canvas = document.createElement('canvas');
    canvas.width = rong;
    canvas.height = cao;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Trình duyệt không dựng được canvas để nén ảnh.');
    ctx.drawImage(bitmap, 0, 0, rong, cao);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const byte = uocByteTuDataUrl(dataUrl);
    if (byte > TRAN_BYTE) {
      throw new Error(
        `Ảnh sau khi nén vẫn còn ${Math.round(byte / 1024)} KB, vượt mức cho phép ${Math.round(TRAN_BYTE / 1024)} KB. Hãy cắt bớt hoặc chụp lại gần hơn.`,
      );
    }
    return { dataUrl, byte, rong, cao };
  } finally {
    bitmap.close();
  }
}

/** Lấy các file ảnh từ một sự kiện dán/kéo-thả. */
export function anhTuDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter((f) => LOAI_ANH_NHAN.includes(f.type));
}
