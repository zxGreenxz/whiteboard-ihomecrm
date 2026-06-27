// Bảng lương — UI primitives (port từ Claude Design kit common.jsx).
import React, { useState, useEffect, useRef } from "react";
import { SAL_ICONS } from "./salaryIcons";
import { salFmt } from "./salaryFormat";

const prefersReduced =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

export { prefersReduced };

// count-up tới target
export function useCountUp(target: number, deps?: any[]): number {
  const [val, setVal] = useState(prefersReduced ? target : 0);
  const ref = useRef(prefersReduced ? target : 0);
  const set = (v: number) => { ref.current = v; setVal(v); };
  useEffect(() => {
    if (prefersReduced) { set(target); return; }
    let raf = 0;
    let start: number | undefined;
    let done = false;
    const from = ref.current;
    const dur = 900;
    const step = (t: number) => {
      if (done) return;
      if (!start) start = t;
      const p = Math.min((t - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      set(from + (target - from) * e);
      if (p < 1) raf = requestAnimationFrame(step);
      else { done = true; set(target); }
    };
    raf = requestAnimationFrame(step);
    const fb = setTimeout(() => { if (!done) { done = true; set(target); } }, dur + 160);
    return () => { cancelAnimationFrame(raf); clearTimeout(fb); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps || [target]);
  return val;
}

export function Money({ value, animate, className }: { value: number; animate?: boolean; className?: string }) {
  const v = useCountUp(value, [value, animate]);
  const shown = animate ? Math.round(v) : value;
  return <span className={"sal-num " + (className || "")}>{salFmt(shown)}</span>;
}

export function ClickNum({ value, onClick, pending, zero, neg, prefix }: {
  value: number; onClick: (e: React.MouseEvent) => void; pending?: boolean; zero?: boolean; neg?: boolean; prefix?: string;
}) {
  const Info = SAL_ICONS.Info;
  const cls = ["sal-link", pending ? "is-pending" : "", neg ? "sal-neg" : "", zero ? "sal-zero" : ""].filter(Boolean).join(" ");
  return (
    <button className={cls} onClick={onClick}>
      {prefix}{salFmt(value)}
      <Info className="i" size={13} />
    </button>
  );
}

function anchorStyle(rect: DOMRect, w: number, opts: { align?: "right" | "left" } = {}) {
  const pad = 8;
  let left = opts.align === "right" ? rect.right - w : rect.left;
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
  const top = rect.bottom + 6;
  return { left: Math.round(left), top: Math.round(top), width: w };
}

export function Popover({ rect, width, onClose, children }: { rect: DOMRect; width?: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => anchorStyle(rect, width || 340, { align: "right" }));
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const h = el.offsetHeight;
      let top = rect.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
      setPos((p) => ({ ...p, top: Math.round(top) }));
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="sal-popback" onClick={onClose} />
      <div className="sal-pop" ref={ref} style={pos}>{children}</div>
    </>
  );
}

export interface MenuItem { sep?: boolean; danger?: boolean; disabled?: boolean; icon?: string; label?: string; onClick?: () => void; }

export function Menu({ rect, onClose, items }: { rect: DOMRect; onClose: () => void; items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => anchorStyle(rect, 210, { align: "right" }));
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const h = el.offsetHeight;
      let top = rect.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
      setPos((p) => ({ ...p, top: Math.round(top) }));
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="sal-popback" onClick={onClose} />
      <div className="sal-menu" ref={ref} style={pos}>
        {items.map((it, i) =>
          it.sep ? <div key={i} className="sep" /> : (
            <button key={i} className={it.danger ? "danger" : ""} disabled={it.disabled}
              onClick={() => { onClose(); it.onClick && it.onClick(); }}
              style={it.disabled ? { opacity: .4, cursor: "not-allowed" } : undefined}>
              {it.icon ? React.createElement(SAL_ICONS[it.icon], { size: 16 }) : null}
              <span>{it.label}</span>
            </button>
          )
        )}
      </div>
    </>
  );
}

export function Modal({ onClose, children, wide }: { onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="sal-modalback" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"sal-modal" + (wide ? " sal-modal--wide" : "")}>{children}</div>
    </div>
  );
}

export function Ring({ pct, size = 56, stroke = 6, color, track, children }: {
  pct: number; size?: number; stroke?: number; color?: string; track?: string; children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(pct, 100));
  const off = c * (1 - clamped / 100);
  const animOff = useCountUp(off, [off]);
  return (
    <div className="sal-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track || "hsl(var(--muted))"} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color || "hsl(var(--primary))"} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={prefersReduced ? off : animOff} />
      </svg>
      <div className="rc">{children}</div>
    </div>
  );
}

export function tint(tone: string): React.CSSProperties {
  return { background: `hsl(var(--status-${tone}-bg))`, color: `hsl(var(--status-${tone}-fg))` };
}
export function tintSolid(tone: string): React.CSSProperties {
  return { background: `hsl(var(--status-${tone}) / .12)`, color: `hsl(var(--status-${tone}-strong, var(--status-${tone})))` };
}
