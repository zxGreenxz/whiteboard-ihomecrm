// Bảng lương — biểu đồ lương các tháng. Dùng chung Tab 1 + self-view.
import React, { useEffect, useState } from "react";
import { SAL_ICONS } from "./salaryIcons";
import { salFmt, salShort } from "./salaryFormat";
import { Modal, prefersReduced } from "./salaryCommon";
import type { SalManager } from "@/lib/managerSalary";

const I = SAL_ICONS;

export function MonthlyChart({ m }: { m: SalManager }) {
  const data = m.trend || [];
  const [grown, setGrown] = useState(!!prefersReduced);
  useEffect(() => {
    if (prefersReduced) return;
    setGrown(false);
    const t = setTimeout(() => setGrown(true), 90);
    return () => clearTimeout(t);
  }, [m.id]);
  if (!data.length) {
    return (
      <div className="sal-card"><div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Chưa có dữ liệu lương các tháng trước (chốt tháng để tích luỹ lịch sử).</div></div>
    );
  }
  const max = Math.max.apply(null, data.map((d) => d.gross)) * 1.16 || 1;
  const avg = Math.round(data.reduce((s, d) => s + d.gross, 0) / data.length);
  const best = data.reduce((a, b) => (b.gross > a.gross ? b : a), data[0]);
  const first = data[0].gross, last = data[data.length - 1].gross;
  const growth = first ? Math.round(((last - first) / first) * 100) : 0;
  const lab = (l: string) => "T" + l.replace(/^0/, "");
  return (
    <div className="sal-card">
      <div className="sal-sec-head">
        <span className="sal-ava" style={{ width: 32, height: 32, fontSize: 13, flexShrink: 0, background: m.tone === "primary" ? "hsl(var(--primary))" : "hsl(var(--status-info))" }}>{m.initials}</span>
        <h3 style={{ display: "flex", alignItems: "center", gap: 7 }}>{m.short}{m.alias ? <span className="sal-alias">{m.alias}</span> : null}</h3>
        <div className="sal-chart-legend">
          <span><i className="sw full" />Tổng lương</span>
          <span><i className="sw take" />Thực nhận</span>
        </div>
      </div>
      <div className="sal-chart">
        <div className="sal-chart-plot">
          <div className="sal-chart-avg" style={{ bottom: (avg / max * 100) + "%" }}><span>TB {salShort(avg)}</span></div>
          <div className="sal-chart-cols">
            {data.map((d, i) => {
              const gH = (d.gross / max) * 100;
              const tShare = d.gross ? (d.takehome / d.gross) * 100 : 0;
              return (
                <div className={"sal-chart-col" + (d.current ? " current" : "")} key={i}>
                  <span className="sal-chart-val" style={{ bottom: `calc(${gH}% + 6px)` }}>{salShort(d.gross)}</span>
                  <div className="sal-chart-bar" style={{ height: gH + "%", transform: grown ? "scaleY(1)" : "scaleY(0)", transitionDelay: (i * 70) + "ms" }}>
                    <div className="sal-chart-take" style={{ height: tShare + "%" }} />
                  </div>
                  <div className="sal-chart-tip" style={{ bottom: `calc(${gH}% + 8px)` }}>
                    <b>Tháng {d.label}/{(new Date().getFullYear())}{d.current ? " · đang diễn ra" : ""}</b>
                    <span>Tổng lương <b className="sal-num">{salFmt(d.gross)}</b></span>
                    <span>Thực nhận <b className="sal-num">{salFmt(d.takehome)}</b></span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="sal-chart-xrow">
          {data.map((d, i) => <span className={"sal-chart-x" + (d.current ? " current" : "")} key={i}>{lab(d.label)}{d.current ? <em>•</em> : null}</span>)}
        </div>
      </div>
      <div className="sal-chart-foot">
        <span><I.TrendingUp size={14} style={{ color: growth >= 0 ? "hsl(var(--status-success-strong))" : "hsl(var(--status-danger-fg))" }} />Xu hướng <b style={{ color: growth >= 0 ? "hsl(var(--status-success-fg))" : "hsl(var(--status-danger-fg))" }}>{growth >= 0 ? "+" : ""}{growth}%</b></span>
        <span><I.Trophy size={14} style={{ color: "hsl(var(--status-warning-strong))" }} />Cao nhất <b>{salFmt(best.gross)}</b> · {lab(best.label)}</span>
      </div>
    </div>
  );
}

export function SalChartModal({ managers, onClose }: { managers: SalManager[]; onClose: () => void }) {
  return (
    <Modal onClose={onClose} wide>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--primary) / .12)", color: "hsl(var(--primary))" }}><I.BarChart size={19} /></span>
        <div><h3>Biểu đồ lương các tháng</h3><p>So sánh tổng lương &amp; thực nhận · 6 tháng gần nhất</p></div>
        <button className="x" onClick={onClose}><I.X size={18} /></button>
      </div>
      <div className="sal-modal-body" style={{ gap: 16, paddingTop: 8, paddingBottom: 8 }}>
        {managers.map((m) => <MonthlyChart key={m.id} m={m} />)}
      </div>
      <div className="sal-modal-foot">
        <button className="sal-btn sal-btn--primary" onClick={onClose}>Đóng</button>
      </div>
    </Modal>
  );
}
