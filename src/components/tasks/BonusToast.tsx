// Popup thưởng — port từ Claude Design "Bonus Popup.dc.html" (bản MỚI).
// Render qua Sonner `toast.custom` (top-center, unstyled) từ src/lib/salaryBonusNotify.ts.
//
//  • Single (xanh): 🎁 + "+30K" vàng TO bên TRÁI · nội dung việc (loại · ghi chú)
//    + 📍 mã phòng align-phải. Tia xoay, xu dải mờ góc dưới-trái, vệt sáng lướt.
//  • Combo (vàng-lục, ≥2 khoản): 🔥 "Thưởng kép!" + badge COMBO ×N + "+60K" + tag
//    ngày; xu góc trên-phải + bảng phân rã (mỗi khoản: icon tile · nội dung · +K).
//  • Đơn "trân trọng" (việc ngoài giờ / CN / Lễ — chọn qua prop `variant`, KHÔNG
//    hiện phòng, thêm lời cảm ơn từ quản lý + linh vật góc phải):
//    night 🌙 (ngoài giờ, indigo) · medal 🏅 (CN, xanh) · fest 🏮 (Lễ Tết, đỏ).
//    Combo luôn giữ thẻ vàng, bỏ qua variant.
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

/** Skin popup đơn theo ngữ cảnh thời gian; combo bỏ qua. */
type BonusVariant = "normal" | "night" | "medal" | "fest";

interface BonusToastProps {
  items: BonusItem[];
  total: number;
  isCombo: boolean;
  variant?: BonusVariant;
}

/** Cấu hình 3 thẻ "trân trọng" (ngoài giờ / CN / Lễ): lời cảm ơn từ quản lý. */
const APPRECIATION: Record<
  "night" | "medal" | "fest",
  { cls: string; kicker: string; badge: string; mascot: string; thanks: string }
> = {
  night: {
    cls: "bp-pop--night",
    kicker: "🌙 Hỗ trợ ngoài giờ",
    badge: "❤️ TRÂN TRỌNG",
    mascot: "🌙",
    thanks: "Cảm ơn bạn đã có mặt vì khách hàng ngay cả khi đã hết giờ làm 🌙",
  },
  medal: {
    cls: "bp-pop--medal",
    kicker: "✦ Ghi nhận nỗ lực",
    badge: "⭐ TẬN TÂM",
    mascot: "🏅",
    thanks: "Sự tận tâm của bạn ngoài giờ làm luôn được công ty trân trọng 🤝",
  },
  fest: {
    cls: "bp-pop--fest",
    kicker: "🏮 Hỗ trợ ngày lễ",
    badge: "🙏 TRI ÂN",
    mascot: "🏮",
    thanks: "Cảm ơn bạn đã gác lại ngày nghỉ để đồng hành cùng khách hàng 🧧",
  },
};

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

/** Sao nhấp nháy nền cho thẻ "trân trọng" (đêm / lễ). */
function Stars() {
  const stars = [
    { top: "18px", right: "128px", fontSize: "9px", delay: "0s", c: "✨" },
    { top: "40px", right: "62px", fontSize: "7px", delay: ".6s", c: "✦" },
    { top: "64px", right: "150px", fontSize: "6px", delay: "1.1s", c: "✦" },
    { bottom: "20px", right: "40px", fontSize: "8px", delay: ".3s", c: "✨" },
  ];
  return (
    <div className="bp-stars" aria-hidden>
      {stars.map((s, i) => (
        <span
          key={i}
          className="bp-star"
          style={{
            top: s.top,
            bottom: s.bottom,
            right: s.right,
            fontSize: s.fontSize,
            animationDelay: s.delay,
          }}
        >
          {s.c}
        </span>
      ))}
    </div>
  );
}

export default function BonusToast({
  items,
  total,
  isCombo,
  variant = "normal",
}: BonusToastProps) {
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

  // Đơn "trân trọng" (ngoài giờ / CN / Lễ): KHÔNG hiện phòng, có lời cảm ơn.
  if (variant !== "normal") {
    const it = items[0];
    const cfg = APPRECIATION[variant];
    return (
      <div className={`bp-pop ${cfg.cls}`} role="status" aria-live="polite">
        <div className="bp-rays" aria-hidden />
        <Stars />
        <span className="bp-mascot" aria-hidden>
          {cfg.mascot}
        </span>
        <div className="bp-inner">
          <div className="bp-head">
            <span className="bp-kicker">{cfg.kicker}</span>
            <span className="bp-badge">{cfg.badge}</span>
          </div>
          <div className="bp-body">
            <div className="bp-amount">{formatBonusK(animated)}</div>
            <div className="bp-work bp-work--solo">{workOf(it)}</div>
          </div>
          <div className="bp-thanks">{cfg.thanks}</div>
        </div>
        <div className="bp-shine" aria-hidden />
      </div>
    );
  }

  // Single (thường — giờ hành chính ngày thường)
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
