import { EyeOff, Lock, Timer, WifiOff } from "lucide-react";

import type { DialTone, DialView, HoldBlock } from "@/lib/door-access/holdToOpen";
import type { DialHandlers } from "./useDoorDial";

/**
 * Vòng vân tay "giữ để mở" (artboard Main + Trạng thái của Bản A). Chỉ vẽ: trạng thái, chữ và việc gửi
 * lệnh do `useHoldToOpen` + `dialView` quyết.
 */

// Chín đường vân (bán kính, góc đầu, góc cuối) — vẽ một lần.
const RIDGES: ReadonlyArray<readonly [number, number, number]> = [
  [8, -140, 140],
  [18, -155, 150],
  [28, -125, 165],
  [38, -160, 118],
  [38, 140, 172],
  [48, -135, 155],
  [58, -150, 112],
  [68, -112, 150],
  [78, -70, 70],
];

function arc(r: number, a: number, b: number): string {
  const rx = r * 0.82;
  const ry = r;
  const c = 112;
  const pt = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return `${(c + rx * Math.sin(t)).toFixed(2)} ${(c - ry * Math.cos(t)).toFixed(2)}`;
  };
  return `M${pt(a)} A${rx.toFixed(2)} ${ry.toFixed(2)} 0 ${b - a > 180 ? 1 : 0} 1 ${pt(b)} `;
}

const RIDGE_PATHS = RIDGES.map(([r, a, b]) => arc(r, a, b));
const RING_LENGTH = 666.5;

const LOOK: Record<DialTone, { disc: string; line: string; lit: string; dim: string; ring: string; title: string; dashed?: boolean }> = {
  ready: { disc: "#ffffff", line: "#e7e3da", lit: "#1f7a52", dim: "#c9c2b4", ring: "#1f7a52", title: "#1b1813" },
  holding: { disc: "#ffffff", line: "#d2e8da", lit: "#1f7a52", dim: "#c9c2b4", ring: "#1f7a52", title: "#145237" },
  sending: { disc: "#e8f3ec", line: "#d2e8da", lit: "#1f7a52", dim: "#1f7a52", ring: "#1f7a52", title: "#145237" },
  opened: { disc: "#1f7a52", line: "#1a6645", lit: "#ffffff", dim: "#ffffff", ring: "#1f7a52", title: "#145237" },
  failed: { disc: "#fcebe9", line: "#f2c8c4", lit: "#b3362f", dim: "#b3362f", ring: "#b3362f", title: "#8f2a24" },
  unknown: { disc: "#fbf1da", line: "#f0dca8", lit: "#8a5a00", dim: "#8a5a00", ring: "#d98a14", title: "#6b4600" },
  off: { disc: "#f5f3ee", line: "#e7e3da", lit: "#d9d3c7", dim: "#d9d3c7", ring: "#e7e3da", title: "#514c42", dashed: true },
};

const BADGE: Record<HoldBlock | "rate_limited", typeof Lock> = {
  no_permission: Lock,
  read_only: EyeOff,
  offline: WifiOff,
  rate_limited: Timer,
};

export function HoldDial({
  view,
  badge,
  label,
  handlers,
}: {
  view: DialView;
  /** Biểu tượng giữa đĩa khi nút khoá. */
  badge: HoldBlock | "rate_limited" | null;
  /** "Giữ để mở Cổng chính, toà A". */
  label: string;
  handlers: DialHandlers;
}) {
  const look = LOOK[view.tone];
  const Badge = view.tone === "off" && badge ? BADGE[badge] : null;
  const lit = RIDGE_PATHS.slice(0, view.litRidges).join("") || "M-10 -10";
  const dim = RIDGE_PATHS.slice(view.litRidges).join("") || "M-10 -10";
  return (
    <section className="dial-wrap" aria-label="Mở cửa từ xa">
      <button
        type="button"
        className="dial"
        aria-label={label}
        aria-describedby="door-dial-sub"
        aria-disabled={view.interactive ? undefined : "true"}
        data-tone={view.tone}
        {...handlers}
      >
        <svg viewBox="0 0 224 224" aria-hidden="true">
          <circle className="ring-track" cx="112" cy="112" r="106" style={look.dashed ? { strokeDasharray: "6 10" } : undefined} />
          <circle
            className="ring-fill"
            cx="112"
            cy="112"
            r="106"
            transform="rotate(-90 112 112)"
            style={{ stroke: look.ring, strokeDashoffset: (RING_LENGTH * (1 - view.ring)).toFixed(1) }}
          />
          <circle className="spin-arc" cx="112" cy="112" r="106" style={{ stroke: "#1f7a52", opacity: view.tone === "sending" ? 1 : 0 }} />
          <circle cx="112" cy="112" r="94" style={{ fill: look.disc, stroke: look.line, strokeWidth: 1.5 }} />
          <path className="ridge" d={dim} style={{ stroke: look.dim }} />
          <path className="ridge" d={lit} style={{ stroke: look.lit }} />
        </svg>
        {Badge && (
          <span className="dial-badge">
            <Badge aria-hidden="true" />
          </span>
        )}
      </button>
      <div aria-live="polite" style={{ minHeight: 70 }}>
        <p className="dial-title" style={{ color: look.title }}>
          {view.title}
        </p>
        <p className="dial-sub" id="door-dial-sub">
          {view.sub}
        </p>
      </div>
    </section>
  );
}
