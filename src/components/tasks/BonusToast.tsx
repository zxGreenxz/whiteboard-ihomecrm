// Reward snackbar gamified (Dark Mode glassmorphism) khi hoàn thành việc có thưởng.
// Render qua Sonner `toast.custom` (top-center, unstyled) từ src/lib/salaryBonusNotify.ts.
//
// 3 cột: [icon glow] · [nội dung: LOẠI + GHI CHÚ việc] · [số tiền đếm tăng].
//  • Standard (1 khoản): viền/đồng hồ Neon Green (#00E676).
//  • Combo (≥2 khoản, có phụ cấp CN/Lễ): Vàng (#FFD700/#FF9100) + confetti + breakdown.
// Hiệu ứng: spring slide-down, count-up "slot machine", haptic (vibrate),
// confetti (canvas-confetti, lazy) cho combo. Auto-dismiss + vuốt = Sonner lo.
// CSS (.reward-toast*) ở cuối src/index.css.

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

/** 30000 -> "+30K" (cho Web Push). */
export function formatBonusK(amount: number): string {
  return `+${Math.round(amount / 1000)}K`;
}

/** 30000 -> "+30.000đ". */
function formatDong(n: number): string {
  return `+${Math.round(n).toLocaleString("vi-VN")}đ`;
}

/** Nhãn ngắn cho breakdown: "Sửa chữa" -> "Sửa"; phụ cấp -> "Phụ cấp". */
function shortLabel(it: BonusItem): string {
  if (it.bonus_kind === "DAY_BONUS") return "Phụ cấp";
  return (it.label || "Việc").split(/\s+/)[0];
}

/** Đếm tăng 0 → target (slot machine). Tôn trọng reduced-motion. */
function useCountUp(target: number, duration = 600): number {
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

export default function BonusToast({ items, total, isCombo }: BonusToastProps) {
  const animated = useCountUp(total);

  // Haptic: Standard = nhẹ; Combo = mạnh + nhịp đôi.
  useEffect(() => {
    try {
      navigator.vibrate?.(isCombo ? [40, 60, 120] : [60]);
    } catch {
      /* không hỗ trợ → bỏ qua */
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

  const primary = items[0];
  const jobItem = items.find((i) => i.bonus_kind === "JOB") || primary;
  const dayItem = items.find((i) => i.bonus_kind === "DAY_BONUS");

  // Nội dung công việc = LOẠI + GHI CHÚ, vd "Sửa chữa · vòi nước nhà tắm".
  const workOf = (it: BonusItem) =>
    it.note && it.note !== it.label ? `${it.label} · ${it.note}` : it.label;

  let iconEmoji: string;
  let title: string;
  let subtitle: string;
  if (isCombo) {
    iconEmoji = "🔥";
    title = "Combo ngày nghỉ! 🔥";
    const work = jobItem ? workOf(jobItem) : "";
    subtitle = [work, jobItem?.place].filter(Boolean).join(" • ");
  } else {
    iconEmoji = primary.icon || "✅";
    title = workOf(primary);
    subtitle =
      primary.bonus_kind === "JOB"
        ? [primary.place, "Đã nghiệm thu ảnh"].filter(Boolean).join(" • ")
        : "Thưởng làm việc ngày nghỉ";
  }

  const breakdown = isCombo
    ? `(${items.map((i) => `${shortLabel(i)} ${Math.round(i.amount / 1000)}k`).join(" + ")})`
    : "";
  const pill = dayItem ? (dayItem.label.includes("Lễ") ? "+Phụ cấp Lễ" : "+Phụ cấp CN") : "";

  return (
    <div
      className={`reward-toast${isCombo ? " reward-toast--combo" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="reward-toast__icon" aria-hidden>{iconEmoji}</div>
      <div className="reward-toast__mid">
        <div className="reward-toast__title">{title}</div>
        <div className="reward-toast__sub">{subtitle}</div>
      </div>
      <div className="reward-toast__right">
        <div className="reward-toast__amount">{formatDong(animated)}</div>
        {isCombo && (
          <>
            {pill ? <span className="reward-toast__pill">{pill}</span> : null}
            <div className="reward-toast__breakdown">{breakdown}</div>
          </>
        )}
      </div>
    </div>
  );
}
