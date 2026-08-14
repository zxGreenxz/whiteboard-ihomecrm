// Kỳ thời gian TƯƠNG ĐỐI ("tháng này", "tháng trước") — chuẩn hoá TRƯỚC khi
// gọi tool, không giao cho mô hình tự tính.
//
// VÌ SAO KHÔNG ĐỂ MÔ HÌNH TỰ TÍNH
//   System prompt đã mang ngày hôm nay dưới dạng câu chữ (`dongHomNay`). Vậy mà
//   đánh giá live 13/08/2026 ca C28 ("doanh thu tháng trước") ghi nhận mô hình
//   NÓI KHÔNG BIẾT NGÀY và hỏi lại người dùng là kỳ nào. Một câu văn trong prompt
//   là gợi ý, không phải hợp đồng: mô hình có thể bỏ qua, đọc sai, hoặc trừ nhầm
//   tháng ở ranh giới năm — và cả ba kiểu hỏng đều trả về một con số trông hợp lý.
//
//   Ở đây kỳ được tính bằng mã, rồi ÉP vào tham số tool. Mô hình vẫn chọn tool và
//   diễn giải kết quả; nó chỉ không còn là nơi làm phép trừ ngày tháng.
//
// GIỜ VIỆT NAM, KHÔNG PHẢI GIỜ MÁY
//   Dùng `vnYmOf` (Intl + Asia/Ho_Chi_Minh) thay `new Date().getMonth()`. CI chạy
//   UTC còn dữ liệu ở UTC+7, nên trong khoảng 00:00–07:00 giờ VN ngày mùng 1,
//   giờ máy vẫn đang ở tháng trước — đúng loại lỗi đã làm màn lương mặc định sai
//   kỳ (audit 2026-07-20).
import { shiftYm } from '@/lib/managerSalary';
import { vnYmOf } from '@/lib/salaryPeriod';

export interface CopilotRequestContext {
  /** "YYYY-MM" hiện tại theo giờ Việt Nam. */
  kyHienTai: string;
  timeZone: string;
  locale: string;
}

export type CopilotResolvedPeriod = {
  kind: 'month';
  /** "YYYY-MM" */
  month: string;
  /** "YYYY-MM-DD" ngày đầu tháng. */
  startDate: string;
  /** "YYYY-MM-DD" ngày cuối tháng. */
  endDate: string;
} | null;

export function taoRequestContext(now: Date = new Date()): CopilotRequestContext {
  return {
    kyHienTai: vnYmOf(now),
    timeZone: 'Asia/Ho_Chi_Minh',
    locale: 'vi-VN',
  };
}

/** Ngày cuối tháng của "YYYY-MM" — dùng UTC để không lệch theo giờ máy. */
export function ngayCuoiThang(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function kyTu(month: string): CopilotResolvedPeriod {
  return { kind: 'month', month, startDate: `${month}-01`, endDate: ngayCuoiThang(month) };
}

/**
 * Cụm tiếng Việt KHÔNG MƠ HỒ chỉ kỳ tháng. Cố ý hẹp.
 *
 * "quý này", "năm ngoái", "tuần trước" KHÔNG nằm ở đây: chúng không quy về một
 * tháng, và đoán bừa một tháng cho chúng còn tệ hơn để mô hình hỏi lại. "tháng
 * 3" cũng không: thiếu năm thì đó là chỗ cần hỏi, không phải chỗ để suy.
 *
 * Khớp cả bản có dấu lẫn không dấu — người dùng gõ nhanh thường bỏ dấu.
 */
const CUM_KY: { re: RegExp; delta: number }[] = [
  { re: /th[áa]ng\s+n[àa]y|th[áa]ng\s+hi[ệe]n\s+t[ạa]i/i, delta: 0 },
  // `[ơớo]` phải có cả 'o' trần: người gõ không dấu viết "thang truoc".
  { re: /th[áa]ng\s+tr[ưu][ơớo]c|th[áa]ng\s+r[ồo]i|th[áa]ng\s+v[ừu]a\s+r[ồo]i/i, delta: -1 },
];

/**
 * Kỳ tháng suy ra từ câu người dùng, hoặc `null` khi câu không nêu kỳ tương đối.
 *
 * `null` nghĩa là "không có gì để ép", KHÔNG phải "dùng tháng này". Mặc định
 * ngầm về tháng hiện tại sẽ biến một câu hỏi mơ hồ thành một con số tự tin.
 */
export function resolveRelativePeriod(
  text: string,
  ctx: CopilotRequestContext,
): CopilotResolvedPeriod {
  for (const { re, delta } of CUM_KY) {
    if (re.test(text)) return kyTu(delta === 0 ? ctx.kyHienTai : shiftYm(ctx.kyHienTai, delta));
  }
  return null;
}

/** Tool nào nhận tham số kỳ, và tên tham số đó là gì. */
const THAM_SO_KY: Record<string, 'thang'> = {
  doanh_thu_thang: 'thang',
  tim_hoa_don: 'thang',
};

export interface KetQuaApKy {
  args: Record<string, unknown>;
  /** Kỳ mô hình tự điền, khi nó khác kỳ chuẩn hoá. */
  kyBiThayThe: string | null;
}

/**
 * Ép kỳ đã chuẩn hoá vào tham số tool.
 *
 * Mô hình điền kỳ KHÁC ⇒ ghi đè và trả `kyBiThayThe` để người gọi nói rõ trong
 * kết quả tool. Im lặng sửa số của mô hình rồi trả lời như không có gì xảy ra
 * là cách nhanh nhất để không ai phát hiện bộ chuẩn hoá này hỏng.
 */
export function apDungKyTuongDoi(
  tenTool: string,
  args: Record<string, unknown>,
  ky: CopilotResolvedPeriod,
): KetQuaApKy {
  const khoa = THAM_SO_KY[tenTool];
  if (!khoa || !ky) return { args, kyBiThayThe: null };
  const cu = args[khoa];
  if (cu === ky.month) return { args, kyBiThayThe: null };
  return {
    args: { ...args, [khoa]: ky.month },
    kyBiThayThe: typeof cu === 'string' && cu ? cu : null,
  };
}
