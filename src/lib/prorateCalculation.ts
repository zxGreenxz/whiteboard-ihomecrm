/**
 * Tính số ngày thực tế trong khoảng [start, end] (bao gồm cả 2 đầu).
 * Trả về 0 nếu thiếu một trong hai, không parse được, hoặc end < start.
 */
export function calcProratedDays(
  startDate?: string | null,
  endDate?: string | null,
): number {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end < start) return 0;
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.floor((end.getTime() - start.getTime()) / oneDay) + 1;
}

/**
 * Chia tỉ lệ amount theo công thức `amount / monthDays * days`.
 * Quy ước: monthDays mặc định = 30 ngày (theo quy ước cho thuê phòng).
 * Nếu days <= 0 → trả về amount nguyên gốc (coi như không prorate).
 */
export function prorateAmount(
  amount: number,
  days: number,
  monthDays = 30,
): number {
  if (!days || days <= 0) return amount;
  if (!monthDays || monthDays <= 0) return amount;
  return Math.round((amount / monthDays) * days);
}
