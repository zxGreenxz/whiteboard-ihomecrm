import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// UI + định dạng dùng chung cho 2 tab MOBILE của trang Báo cáo Lợi Nhuận
// (ProfitOverviewMobile + ShareholderSelfMobile) — import từ thiết kế
// claude.ai/design "ProfitMobileC" (mobile-app-finance-interface-design).

// Tiền rút gọn kiểu thiết kế: 1,25 tỷ · 12,5tr · 500k · 0đ.
export const fmtShort = (n: number): string => {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return sign + (a / 1e9).toLocaleString("vi-VN", { maximumFractionDigits: 2 }) + " tỷ";
  if (a >= 1e6) return sign + (a / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 }) + "tr";
  if (a >= 1e3) return sign + Math.round(a / 1e3).toLocaleString("vi-VN") + "k";
  return sign + a.toLocaleString("vi-VN") + "đ";
};

// Số "triệu" 1 chữ số lẻ — cho ma trận Nhà × Tháng (đơn vị ghi ở chip "triệu ₫").
export const fmtM = (n: number) =>
  (n / 1e6).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const CARD = "rounded-[13px] border border-[#e7e3da] bg-white shadow-[0_1px_2px_rgba(27,24,19,.05)]";

// Header trang mobile (thiết kế ProfitMobileC): nút back + tiêu đề 2 dòng + slot
// bên phải (pill năm / cụm nút tháng-toà-lọc của tab BC Thu Chi).
export function MobileHeader({
  title = "Báo cáo Lợi Nhuận",
  sub,
  right,
  onBack,
}: {
  title?: string;
  sub: string;
  right?: ReactNode;
  onBack: () => void;
}) {
  // Gọn theo chuẩn app mobile: cao ~44px nội dung (chưa kể safe-area), không thừa đệm.
  return (
    <div
      className="shrink-0 bg-white border-b border-[#e7e3da] px-3 pb-1.5 flex items-center gap-2"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 6px)" }}
    >
      <button
        onClick={onBack}
        aria-label="Quay lại"
        className="h-7 w-7 shrink-0 grid place-items-center rounded-lg border border-[#e7e3da] bg-[#faf8f4] text-[#514c42] active:scale-95"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex flex-col leading-[1.2]">
        <span className="text-[14px] font-extrabold tracking-[-0.2px] text-[#1b1813] whitespace-nowrap">{title}</span>
        <span className="text-[10px] font-semibold text-[#8d8678] truncate">{sub}</span>
      </div>
      {right && <div className="ml-auto shrink-0 flex items-center gap-1">{right}</div>}
    </div>
  );
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 text-[11.5px] font-bold px-3 py-1.5 rounded-full border whitespace-nowrap ${
        on ? "border-[#1f7a52] bg-[#e8f3ec] text-[#1a6645]" : "border-[#e7e3da] bg-white text-[#514c42]"
      }`}
    >
      {children}
    </button>
  );
}

const NAV_BTN =
  "h-8 w-8 shrink-0 grid place-items-center rounded-[9px] border border-[#e7e3da] bg-white text-[#514c42] active:scale-95";

// Hàng "‹ Năm 2026 ›" + dải chip tháng (Cả năm, T1..T12) cuộn ngang.
export function YearMonthRow({
  year,
  month,
  onYearShift,
  onMonthChange,
}: {
  year: number;
  month: string; // "all" | "1".."12"
  onYearShift: (delta: number) => void;
  onMonthChange: (m: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => onYearShift(-1)} aria-label="Năm trước" className={NAV_BTN}>
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="font-mono font-bold text-[13px] text-[#1b1813] whitespace-nowrap">Năm {year}</span>
      <button onClick={() => onYearShift(1)} aria-label="Năm sau" className={NAV_BTN}>
        <ChevronRight className="h-4 w-4" />
      </button>
      <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
        <Chip on={month === "all"} onClick={() => onMonthChange("all")}>Cả năm</Chip>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <Chip key={m} on={month === String(m)} onClick={() => onMonthChange(String(m))}>
            T{m}
          </Chip>
        ))}
      </div>
    </div>
  );
}

// Biểu đồ cột 12 tháng bằng div thuần (khớp thiết kế — không recharts trên mobile).
// Tap cột để chọn/bỏ chọn tháng (đồng bộ với chip tháng).
export function MonthBars({
  values,
  month,
  onMonthChange,
  areaHeight = 104,
  barMax = 64,
}: {
  values: number[]; // 12 phần tử, VND
  month: string; // "all" | "1".."12"
  onMonthChange: (m: string) => void;
  areaHeight?: number;
  barMax?: number;
}) {
  const maxV = Math.max(...values, 1);
  const selected = month === "all" ? 0 : Number(month);
  return (
    <div className="flex items-end gap-1" style={{ height: areaHeight }}>
      {values.map((v, i) => {
        const active = selected === i + 1;
        const h = Math.max(v > 0 ? 7 : 2, Math.round((v / maxV) * barMax));
        return (
          <button
            key={i}
            onClick={() => onMonthChange(active ? "all" : String(i + 1))}
            className="flex-1 min-w-0 h-full flex flex-col items-center justify-end gap-1 p-0 border-0 bg-transparent"
          >
            {active && v > 0 && (
              <span className="font-mono text-[9px] font-bold text-white bg-[#1a6645] rounded-[5px] px-1 whitespace-nowrap">
                {fmtM(v)}
              </span>
            )}
            <div
              className="w-full max-w-[20px] rounded-t-[5px] rounded-b-[2px]"
              style={{
                height: h,
                background: active ? "#1a6645" : v > 0 ? "#1f9d57" : "#e7e3da",
                opacity: active || selected === 0 ? 1 : 0.4,
              }}
            />
            <span className={`font-mono text-[8.5px] font-bold ${active ? "text-[#1a6645]" : "text-[#b6b0a3]"}`}>
              T{i + 1}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Bảng "được chia Nhà × Tháng", đơn vị triệu ₫.
export function BuildingMatrix({
  heads,
  rows,
}: {
  heads: string[];
  rows: { m: string; cells: (number | null)[]; total: number }[];
}) {
  const th =
    "py-[7px] px-2 text-[9.5px] font-bold text-[#8d8678] bg-[#faf8f4] border-y border-[#efece4] whitespace-nowrap";
  const td = "py-[7px] px-2 font-mono text-[11px] border-b border-[#f4f1ea] whitespace-nowrap";
  return (
    <div className="overflow-x-auto [&::-webkit-scrollbar]:hidden">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={`${th} text-left pl-3.5 uppercase tracking-wide`}>Tháng</th>
            {heads.map((h, i) => (
              <th key={i} className={`${th} text-right`}>{h}</th>
            ))}
            <th className={`${th} text-right pr-3.5 uppercase tracking-wide text-[#514c42]`}>Tổng</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.m}>
              <td className={`${td} pl-3.5 font-bold text-[#514c42]`}>{r.m}</td>
              {r.cells.map((c, i) => (
                <td key={i} className={`${td} text-right text-[#514c42]`}>
                  {c == null ? <span className="text-[#b6b0a3]">—</span> : fmtM(c)}
                </td>
              ))}
              <td className={`${td} text-right pr-3.5 font-bold text-[#1b1813]`}>{fmtM(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Tỷ lệ % duy nhất của 1 cổ đông/quản lý trong danh sách phân bổ — nếu mỗi toà một
// tỷ lệ khác nhau thì trả null (không hiện chip % để khỏi gây hiểu nhầm).
export function uniformPercent(allocs: Array<{ percent?: number }>): string | null {
  const ps = new Set(
    allocs.map((a) => Math.round((Number(a.percent) || 0) * 10) / 10).filter((p) => p > 0)
  );
  if (ps.size !== 1) return null;
  const v = [...ps][0];
  return `${v % 1 === 0 ? v : v.toFixed(1)}%`;
}
