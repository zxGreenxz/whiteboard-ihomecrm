/**
 * Đọc số tiền người dùng gõ vào ô nhập.
 *
 * Người Việt gõ dấu chấm làm phân cách hàng nghìn: "2.655.000". Nếu giữ dấu
 * chấm rồi ném vào Number() thì:
 *   "2.655.000"  -> NaN        (nhiều dấu chấm, không phải số hợp lệ)
 *   "-680.000"   -> -680       (SAI 1000 lần — dấu chấm bị hiểu là thập phân)
 * Cả hai đều là lỗi TIỀN: cái đầu làm nút xác nhận không bao giờ bật, cái sau
 * âm thầm ghi sai số vào biên bản chốt sổ.
 *
 * Hệ thống không dùng số lẻ ở ô đếm tiền mặt (đồng là đơn vị nhỏ nhất), nên
 * quy ước: BỎ HẲN mọi ký tự không phải chữ số, giữ đúng một dấu trừ ở đầu.
 * Đây cũng là cách BanGiaoReport đã làm từ trước.
 */
export function parseMoneyInput(raw: string | null | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const negative = text.startsWith("-");
  const digits = text.replace(/\D/g, "");
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Hiển thị lại số tiền theo kiểu Việt Nam. */
export function formatMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("vi-VN").format(num) + "đ";
}

/**
 * So hai số tiền do người dùng gõ / server trả. Server trả numeric qua jsonb
 * nên có thể là number hoặc string tuỳ đường; ép về number trước khi so, và so
 * theo đồng (làm tròn) để không vấp số dấu phẩy động.
 */
export function sameMoney(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.round(x * 100) === Math.round(y * 100);
}
