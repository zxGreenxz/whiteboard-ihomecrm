// Popup "phần thưởng" khi hoàn thành công việc — gộp Combo.
// Render qua Sonner `toast.custom` (top-center, unstyled) từ
// src/lib/salaryBonusNotify.ts. Tinh thần game-farm "kiếm tiền" của Bảng lương.
//
//  • Combo (≥2 khoản): thẻ VÀNG/lửa + nhãn X2, TỔNG to đếm tăng, kèm bảng phân rã
//    (🔧 Sửa vòi nước +30K / 🔥 Phụ cấp Chủ Nhật +30K).
//  • Đơn (1 khoản): thẻ XANH lá bình thường — số tiền + tên việc + 📍 mã tòa·phòng.
//
// CSS (.bonus-pop*) ở cuối index.css.

import { useEffect, useRef, useState } from "react";

interface BonusItem {
  bonus_kind: "JOB" | "DAY_BONUS";
  amount: number;
  label: string;
  place?: string;
  icon: string;
}

interface BonusToastProps {
  items: BonusItem[];
  total: number;
  isCombo: boolean;
}

/** 30000 -> "+30K" (khớp helper SQL public.fmt_bonus_k). */
export function formatBonusK(amount: number): string {
  return `+${Math.round(amount / 1000)}K`;
}

/** Đếm tăng từ 0 → target trong `duration` ms (easeOutCubic). Tôn trọng reduced-motion. */
function useCountUp(target: number, duration = 900): number {
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

export default function BonusToast({ items, total, isCombo }: BonusToastProps) {
  const animated = useCountUp(total);
  const single = items[0];

  return (
    <div className={`bonus-pop${isCombo ? " bonus-pop--combo" : ""}`} role="status" aria-live="polite">
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
          <span className="bonus-pop__gift" aria-hidden>{isCombo ? "🔥" : "🎁"}</span>
          <span className="bonus-pop__title">{isCombo ? "Thưởng kép!" : "Phần thưởng"}</span>
          <span className="bonus-pop__new">{isCombo ? "X2" : "NHẬN NGAY"}</span>
        </div>

        <div className="bonus-pop__total">{formatBonusK(animated)}</div>

        {isCombo ? (
          <div className="bonus-pop__list">
            {items.map((it, i) => (
              <div className="bonus-pop__item" key={i}>
                <span className="bonus-pop__item-ic" aria-hidden>{it.icon}</span>
                <span className="bonus-pop__item-label">
                  {it.label}
                  {it.place ? <span className="bonus-pop__item-place"> · {it.place}</span> : null}
                </span>
                <span className="bonus-pop__item-amt">{formatBonusK(it.amount)}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="bonus-pop__label">{single?.label}</div>
            {single?.place ? <div className="bonus-pop__place">📍 {single.place}</div> : null}
          </>
        )}
      </div>

      <div className="bonus-pop__shine" aria-hidden />
    </div>
  );
}
