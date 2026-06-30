// Popup thưởng — port từ Claude Design "Bonus Popup.dc.html" (bản MỚI).
// Render qua Sonner `toast.custom` (top-center, unstyled) từ src/lib/salaryBonusNotify.ts.
//
//  • Single (xanh): 🎁 + "+30K" vàng TO bên TRÁI · nội dung việc (loại · ghi chú)
//    + 📍 mã phòng align-phải. Tia xoay, xu dải mờ góc dưới-trái, vệt sáng lướt.
//  • Combo (vàng-lục, ≥2 khoản): 🔥 "Thưởng kép!" + badge COMBO ×N + "+60K" + tag
//    ngày; xu góc trên-phải + bảng phân rã (mỗi khoản: icon tile · nội dung · +K).
// Micro-interactions: count-up (slot machine), confetti vàng (combo, lazy),
// haptic vibrate. CSS (.bp-*) ở cuối src/index.css.

import { useEffect, useRef, useState } from "react";

interface BonusItem {
  bonus_kind: "JOB" | "DAY_BONUS";
  amount: number;
  label: string; // loại việc / tên phụ cấp
  note?: string | null; // ghi chú công việc (jobs.title)
  place?: string;
  icon: string;
}

interface BonusToastProps {
  items: BonusItem[];
  total: number;
  isCombo: boolean;
}

/** 30000 -> "+30K". */
export function formatBonusK(amount: number): string {
  return `+${Math.round(amount / 1000)}K`;
}

/** Nội dung việc = LOẠI + GHI CHÚ, vd "Sửa chữa · vòi nước nhà tắm". */
function workOf(it: BonusItem): string {
  return it.note && it.note !== it.label ? `${it.label} · ${it.note}` : it.label;
}

/** Đếm tăng 0 → target (slot machine). Tôn trọng reduced-motion. */
function useCountUp(target: number, duration = 700): number {
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

const COINS_SINGLE = ["🪙", "💰", "🪙"];
const COINS_COMBO = ["🪙", "💰", "✨"];

function Coins({ chars }: { chars: string[] }) {
  return (
    <div className="bp-coins" aria-hidden>
      {chars.map((c, i) => (
        <span
          key={i}
          className="bp-coin"
          style={{ ["--i" as string]: String(i) } as React.CSSProperties}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

export default function BonusToast({ items, total, isCombo }: BonusToastProps) {
  const animated = useCountUp(total);

  // Haptic: Standard = nhẹ; Combo = mạnh + nhịp đôi.
  useEffect(() => {
    try {
      navigator.vibrate?.(isCombo ? [40, 60, 120] : [60]);
    } catch {
      /* không hỗ trợ */
    }
  }, [isCombo]);

  // Confetti vàng cho combo (lazy import — không vào main bundle).
  useEffect(() => {
    if (!isCombo) return;
    let cancelled = false;
    import("canvas-confetti")
      .then((m) => {
        if (cancelled) return;
        m.default({
          particleCount: 70,
          spread: 72,
          startVelocity: 34,
          gravity: 1,
          scalar: 0.9,
          ticks: 130,
          origin: { x: 0.5, y: 0.12 },
          colors: ["#FFD700", "#FF9100", "#FFFFFF", "#FFE082"],
          disableForReducedMotion: true,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isCombo]);

  if (isCombo) {
    const dayItem = items.find((i) => i.bonus_kind === "DAY_BONUS");
    const dayShort = dayItem
      ? dayItem.label.includes("Lễ")
        ? "Ngày Lễ"
        : "Chủ Nhật"
      : "Combo";
    return (
      <div className="bp-pop bp-pop--combo" role="status" aria-live="polite">
        <div className="bp-rays" aria-hidden />
        <Coins chars={COINS_COMBO} />
        <div className="bp-inner">
          <div className="bp-head">
            <span className="bp-gift bp-gift--fire" aria-hidden>🔥</span>
            <span className="bp-kicker">Thưởng kép!</span>
            <span className="bp-badge bp-badge--combo">COMBO ×{items.length}</span>
          </div>
          <div className="bp-amount-row">
            <span className="bp-amount">{formatBonusK(animated)}</span>
            <span className="bp-daytag">{dayShort} 🔥</span>
          </div>
          <div className="bp-panel">
            {items.map((it, i) => (
              <div
                className="bp-row"
                key={i}
                style={{ animationDelay: `${(0.12 + i * 0.14).toFixed(2)}s` }}
              >
                <span
                  className={`bp-row-ic${it.bonus_kind === "DAY_BONUS" ? " bp-row-ic--day" : ""}`}
                  aria-hidden
                >
                  {it.icon}
                </span>
                <div className="bp-row-main">
                  <div className="bp-row-name">
                    {it.bonus_kind === "JOB" ? workOf(it) : it.label}
                  </div>
                  <div className="bp-row-sub">
                    {it.bonus_kind === "JOB"
                      ? it.place || "Đã nghiệm thu ảnh"
                      : "Cộng 1 lần / ngày · đã ghi nhận"}
                  </div>
                </div>
                <span className="bp-row-amt">{formatBonusK(it.amount)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bp-shine" aria-hidden />
      </div>
    );
  }

  // Single
  const it = items[0];
  return (
    <div className="bp-pop" role="status" aria-live="polite">
      <div className="bp-rays" aria-hidden />
      <Coins chars={COINS_SINGLE} />
      <div className="bp-inner">
        <div className="bp-head">
          <span className="bp-gift" aria-hidden>🎁</span>
          <span className="bp-kicker">Phần thưởng</span>
          <span className="bp-badge">🎉 CHÚC MỪNG</span>
        </div>
        {/* Số tiền TO bên trái · nội dung việc + 📍 phòng bên phải */}
        <div className="bp-body">
          <div className="bp-amount">{formatBonusK(animated)}</div>
          <div className="bp-work-col">
            <div className="bp-work">{workOf(it)}</div>
            {it.place ? <div className="bp-place">📍 {it.place}</div> : null}
          </div>
        </div>
      </div>
      <div className="bp-shine" aria-hidden />
    </div>
  );
}
