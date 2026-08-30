// =============================================================================
// nhanCheDo.ts — bảng nhãn + tông màu cho `mode` của một lượt tự động hoá.
//
// Vì sao là file riêng chứ không nằm trong RunLog.tsx: hai chỗ cần nó —
// `RunLog` (bảng nhật ký đầy đủ) và `AutomationPanel` (dòng "lần chạy cuối").
// Bản đầu tiên có hai bản chép của đúng bảng này; worker thêm một `mode` mới thì
// phải sửa hai nơi, và quên một nơi thì badge hiện nhãn thô viết hoa mà không
// gate nào đỏ. Tách ra `.ts` thuần (không component) để import từ đâu cũng được
// mà không vướng quy tắc react-refresh của ESLint.
//
// Tập giá trị phải khớp CHECK constraint `zalo_automation_runs.mode` trong
// migration 20260830163815.
// =============================================================================
import type { TagKey } from '@/components/chat-zalo/types';

export interface NhanCheDo {
  ten: string;
  tone: TagKey;
  /** Làm mờ badge: lượt "đang tắt" không phải sự kiện đáng chú ý. */
  mo?: boolean;
}

export const NHAN_CHE_DO_LUOT: Record<string, NhanCheDo> = {
  full: { ten: 'ĐẦY ĐỦ', tone: 'info' },
  compact: { ten: 'GỌN', tone: 'neutral' },
  event: { ten: 'BỔ SUNG', tone: 'purple' },
  reply: { ten: 'TRẢ LỜI', tone: 'success' },
  skipped: { ten: 'BỎ LƯỢT', tone: 'warning' },
  off: { ten: 'ĐANG TẮT', tone: 'neutral', mo: true },
  failed: { ten: 'LỖI', tone: 'danger' },
};

/** Nhãn an toàn cho `mode` lạ — worker bản mới hơn web thì vẫn đọc được. */
export function nhanCuaLuot(mode: string | null | undefined): NhanCheDo {
  return NHAN_CHE_DO_LUOT[String(mode ?? '')] ?? {
    ten: String(mode || '—').toUpperCase(),
    tone: 'neutral',
  };
}

/** Nhãn chế độ CÀI cho một ngày trong tuần — tập hẹp hơn (không có lượt chạy). */
export const NHAN_CHE_DO_NGAY: Record<string, NhanCheDo> = {
  full: { ten: 'ĐẦY ĐỦ', tone: 'info' },
  compact: { ten: 'GỌN', tone: 'neutral' },
  off: { ten: 'KHÔNG GỬI', tone: 'warning' },
};
