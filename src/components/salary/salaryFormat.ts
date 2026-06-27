// Định dạng tiền cho module Bảng lương (port từ Claude Design kit).
// salFmt: "8.000.000₫" (dùng dấu trừ − U+2212 cho số âm).
export function salFmt(n: number | null | undefined): string {
  if (n == null || isNaN(n as number)) return "—";
  const neg = (n as number) < 0;
  const s = Math.round(Math.abs(n as number)).toLocaleString("vi-VN");
  return (neg ? "−" : "") + s + "₫";
}

// salShort: 5.254.000 → "5,3tr"; 20000 → "20k".
export function salShort(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1).replace(".", ",") + "tr";
  if (a >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}
