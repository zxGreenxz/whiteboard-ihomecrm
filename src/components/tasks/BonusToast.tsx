// Popup "phần thưởng" hiển thị khi hoàn thành công việc có thưởng.
// Render qua Sonner `toast.custom` (top-center, unstyled) từ
// src/lib/salaryBonusNotify.ts. Tinh thần game-farm "kiếm tiền" của Bảng lương:
// thẻ kho báu xanh lá, số tiền vàng đếm tăng (count-up), tia sáng jackpot xoay,
// xu bay lên + vệt sáng lướt + rơi nảy bất ngờ. CSS (.bonus-pop*) ở cuối index.css.

import { useEffect, useRef, useState } from "react";

interface BonusToastProps {
  /** Số tiền thưởng (đồng), vd 30000 */
  amount: number;
  /** Tên việc / nhãn thưởng, vd "Sửa vòi nước" */
  label: string;
  /** Mã tòa/phòng, vd "301 · 1392" (rỗng với DAY_BONUS) */
  place?: string;
  /** Loại thưởng — đổi tiêu đề/icon */
  kind?: "JOB" | "DAY_BONUS";
}

/** 30000 -> "+30K" (khớp helper SQL public.fmt_bonus_k). */
export function formatBonusK(amount: number): string {
  return `+${Math.round(amount / 1000)}K`;
}

/** Đếm tăng từ 0 → target trong `duration` ms (easeOutCubic). Tôn trọng reduced-motion. */
function useCountUp(target: number, duration = 850): number {
  const [val, setVal] = useState(0);
  const rafRef = useRef(0);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setVal(target);
      return;
    }
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(target * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else setVal(target);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return val;
}

const COINS = ["🪙", "💰", "🪙", "✨", "🪙"];

export default function BonusToast({ amount, label, place, kind = "JOB" }: BonusToastProps) {
  const animated = useCountUp(amount);
  const title = kind === "DAY_BONUS" ? "Thưởng ngày vàng" : "Phần thưởng";

  return (
    <div className="bonus-pop" role="status" aria-live="polite">
      <div className="bonus-pop__rays" aria-hidden />
      <div className="bonus-pop__coins" aria-hidden>
        {COINS.map((c, i) => (
          <span
            key={i}
            className="bonus-pop__coin"
            style={{ ["--i" as string]: String(i) } as React.CSSProperties}
          >
            {c}
          </span>
        ))}
      </div>
      <div className="bonus-pop__inner">
        <div className="bonus-pop__head">
          <span className="bonus-pop__gift" aria-hidden>🎁</span>
          <span className="bonus-pop__title">{title}</span>
          <span className="bonus-pop__new">NHẬN NGAY</span>
        </div>
        <div className="bonus-pop__amount">{formatBonusK(animated)}</div>
        <div className="bonus-pop__label">{label}</div>
        {place ? <div className="bonus-pop__place">📍 {place}</div> : null}
      </div>
      <div className="bonus-pop__shine" aria-hidden />
    </div>
  );
}
