// Mảnh UI dùng chung cho màn Lương & thu nhập (Tổng quan kỳ, Thu nhập & thanh toán,
// modal Nguồn lương). Theo bản Claude Design "Quản trị lương và thu nhập" 26/09/2026.
import type React from "react";

export const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };
export const MUTED = "hsl(var(--muted-foreground))";

export type ChipTone = "warning" | "success" | "danger" | "info" | "neutral" | "tasks" | "dashed";

export function StChip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
  const st: React.CSSProperties =
    tone === "dashed"
      ? { background: "hsl(var(--card))", color: MUTED, border: "1px dashed hsl(var(--border))" }
      : { background: `hsl(var(--status-${tone}-bg))`, color: `hsl(var(--status-${tone}-fg))`, border: "1px solid transparent" };
  return (
    <span style={{ ...st, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>{children}</span>
  );
}

export function Seg<K extends string>({ options, value, onChange, small }: {
  options: { key: K; label: React.ReactNode }[];
  value: K;
  onChange: (k: K) => void;
  small?: boolean;
}) {
  return (
    <div style={{ display: "inline-flex", padding: 4, gap: 3, background: "hsl(var(--muted))", borderRadius: 8, border: "1px solid hsl(var(--border))", flexWrap: "wrap" }}>
      {options.map((o) => {
        const a = o.key === value;
        return (
          <button key={o.key} onClick={() => onChange(o.key)}
            style={{
              border: 0, cursor: "pointer", whiteSpace: "nowrap", borderRadius: 6, fontWeight: 600,
              fontSize: small ? 12.5 : 13, padding: small ? "7px 12px" : "7px 14px",
              background: a ? "hsl(var(--card))" : "transparent",
              color: a ? "hsl(var(--primary))" : MUTED,
              boxShadow: a ? "var(--shadow-xs)" : "none",
            }}>{o.label}</button>
        );
      })}
    </div>
  );
}

export function PanelHead({ title, sub, right }: { title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid hsl(var(--border))", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h3>
        {sub && <p style={{ margin: 0, fontSize: 11.5, color: MUTED }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={onToggle}
      style={{ display: "inline-flex", alignItems: "center", gap: 9, border: "1px solid hsl(var(--border))", background: "hsl(var(--card))", borderRadius: 999, padding: "5px 12px 5px 6px", fontSize: 12.5, fontWeight: 600, color: "hsl(var(--foreground))", cursor: "pointer" }}>
      <span style={{ position: "relative", width: 36, height: 20, borderRadius: 999, background: on ? "hsl(var(--primary))" : "hsl(var(--border))", transition: "background .15s" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.2)", transition: "left .15s" }} />
      </span>
      {label}
    </button>
  );
}

/** Nhãn tháng ngắn cho báo cáo: '2026-09-01' → 'Th9'. */
export function monthShort(periodMonth: string): string {
  return "Th" + parseInt(periodMonth.slice(5, 7), 10);
}
