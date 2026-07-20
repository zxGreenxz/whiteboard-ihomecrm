// Tab 2 — Bảng kê công việc (minh bạch từng dòng). Port từ kit SalaryLedger.jsx.
import React, { useState } from "react";
import { SAL_ICONS } from "./salaryIcons";
import { tint } from "./salaryCommon";
import { salFmt, salShort } from "./salaryFormat";
import { zeroBonusReason, type SalLedgerRow, type SalManager } from "@/lib/managerSalary";

interface LedgerManager { id: string; short: string; alias: string; tone: "primary" | "info"; }

const TYPE: Record<string, { label: string; icon: string; tone: string; key: string }> = {
  JOB: { label: "Việc", icon: "Wrench", tone: "success", key: "job" },
  DAY_BONUS: { label: "Ngày CN/Lễ", icon: "CalendarCheck", tone: "warning", key: "day" },
  CONTRACT: { label: "HĐ", icon: "FileClock", tone: "info", key: "contract" },
  CASH: { label: "Thu tiền", icon: "Banknote", tone: "neutral", key: "cash" },
};

function dm(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export default function SalaryLedger({
  ledger, managers, buildings, period, requirePhoto, initialFilter, onlyWho, compact,
  onToggleExclude, busyJobId,
}: {
  ledger: SalLedgerRow[];
  managers: SalManager[] | LedgerManager[];
  buildings: string[];
  period: { label: string; year: number };
  requirePhoto?: boolean;
  initialFilter?: { who?: string } | null;
  onlyWho?: string;
  compact?: boolean;
  // Chỉ admin truyền vào → hiện nút bật/tắt "không tính thưởng" cho từng việc.
  onToggleExclude?: (jobId: string, next: boolean) => void;
  busyJobId?: string | null;
}) {
  const I = SAL_ICONS;
  const mgr = managers as LedgerManager[];
  const nameOf = (id: string) => mgr.find((x) => x.id === id)?.short || id;
  const toneOf = (id: string) => mgr.find((x) => x.id === id)?.tone || "info";

  const [fWho, setFWho] = useState(onlyWho || initialFilter?.who || "all");
  const [fBld, setFBld] = useState("all");
  const [fType, setFType] = useState("all");
  const [fBonus, setFBonus] = useState<"all" | "yes" | "no">("all");

  const rowBonus = (r: SalLedgerRow): { val: number | null; note?: string | null } => {
    if (r.item_type === "CASH") return { val: null };
    if (r.item_type === "JOB" && requirePhoto && r.has_photo === false)
      return { val: 0, note: zeroBonusReason({ ...r, bonus_amount: 0 }, requirePhoto) };
    return { val: r.bonus_amount, note: zeroBonusReason(r, requirePhoto) };
  };
  const bonusOf = (r: SalLedgerRow) => rowBonus(r).val || 0;

  let rows = ledger.filter((r) =>
    (fWho === "all" || r.staff_id === fWho) &&
    (fBld === "all" || (r.place || "").indexOf(fBld) === 0) &&
    (fType === "all" || TYPE[r.item_type]?.key === fType) &&
    (fBonus === "all" || (fBonus === "yes" ? bonusOf(r) > 0 : bonusOf(r) <= 0))
  );
  if (onlyWho) rows = rows.filter((r) => r.staff_id === onlyWho);
  const total = rows.reduce((s, r) => { const b = rowBonus(r); return s + (b.val || 0); }, 0);

  const Reason = ({ r }: { r: SalLedgerRow }) => {
    if (r.item_type === "JOB") return <span className="sal-reason"><I.Wrench size={11} />Cơ bản {salShort(r.base_amount)}</span>;
    if (r.item_type === "DAY_BONUS") return <span className="sal-reason" style={{ color: "hsl(var(--status-warning-fg))" }}><I.CalendarCheck size={11} />CN/Lễ +{salShort(r.weekend_amount)}</span>;
    if (r.item_type === "CONTRACT") return <span className="sal-reason" style={{ color: "hsl(var(--status-info-fg))" }}><I.Clock size={11} />Ngoài giờ +{salShort(r.after_amount)}</span>;
    return <span className="sal-pill-muted">Không tính thưởng</span>;
  };

  return (
    <div className="sal-card">
      {!compact && (
        <div className="sal-filters">
          <span className="lbl"><I.Filter size={14} />Lọc</span>
          <select className="sal-select" value={fWho} onChange={(e) => setFWho(e.target.value)}>
            <option value="all">Tất cả quản lý</option>
            {mgr.map((m) => <option key={m.id} value={m.id}>{m.short}{m.alias ? " · " + m.alias : ""}</option>)}
          </select>
          <select className="sal-select" value={fBld} onChange={(e) => setFBld(e.target.value)}>
            <option value="all">Tất cả toà nhà</option>
            {buildings.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select className="sal-select" value={fType} onChange={(e) => setFType(e.target.value)}>
            <option value="all">Tất cả loại dòng</option>
            <option value="job">Việc (sửa chữa)</option>
            <option value="contract">Hợp đồng</option>
            <option value="cash">Thu tiền</option>
            <option value="day">Ngày CN/Lễ</option>
          </select>
          <select className="sal-select" value={fBonus} onChange={(e) => setFBonus(e.target.value as "all" | "yes" | "no")}>
            <option value="all">Có &amp; không thưởng</option>
            <option value="yes">Chỉ việc có thưởng</option>
            <option value="no">Chỉ việc không thưởng</option>
          </select>
          <select className="sal-select" value="cur" onChange={() => {}}><option value="cur">{period.label}/{period.year}</option></select>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "hsl(var(--muted-foreground))" }}>{rows.length} dòng · minh bạch từng đồng</span>
        </div>
      )}
      <div className="sal-tablewrap">
        <table className="sal-ledger">
          <thead>
            <tr>
              <th>Ngày</th>
              {!onlyWho && <th>Quản lý</th>}
              <th>Loại</th>
              <th>Nội dung</th>
              <th>Toà / Phòng</th>
              <th>Lý do</th>
              <th className="r">Cơ bản</th>
              <th className="r">+CN/Lễ</th>
              <th className="r">+Ngoài giờ</th>
              <th className="c">Ảnh</th>
              <th className="r">Thưởng</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const t = TYPE[r.item_type];
              const b = rowBonus(r);
              return (
                <tr key={i}>
                  <td><span className="sal-date">{dm(r.occurred_date)}{r.day_label ? <span className={"sal-daybadge sal-daybadge--" + (r.day_label === "Lễ" ? "le" : "cn")}>{r.day_label}</span> : null}</span></td>
                  {!onlyWho && <td><span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                    <span className="sal-ava" style={{ width: 22, height: 22, fontSize: 10, background: `hsl(var(--${toneOf(r.staff_id) === "primary" ? "primary" : "status-info"}))` }}>{nameOf(r.staff_id)[0]}</span>{nameOf(r.staff_id)}</span></td>}
                  <td><span className="sal-type"><span className="sal-typeic" style={tint(t.tone)}>{React.createElement(I[t.icon], { size: 14 })}</span>{t.label}</span></td>
                  <td style={{ fontWeight: 500 }}>{r.content}{r.cash_amount ? <span style={{ color: "hsl(var(--muted-foreground))", fontWeight: 400 }}> · {salFmt(r.cash_amount)}</span> : null}</td>
                  <td><span className="sal-num" style={{ fontSize: 12 }}>{r.place || "—"}</span></td>
                  <td><Reason r={r} /></td>
                  <td className="r"><span className="sal-num">{r.base_amount ? salShort(r.base_amount) : ""}</span></td>
                  <td className="r"><span className="sal-num" style={{ color: r.weekend_amount ? "hsl(var(--status-warning-fg))" : "" }}>{r.weekend_amount ? "+" + salShort(r.weekend_amount) : ""}</span></td>
                  <td className="r"><span className="sal-num" style={{ color: r.after_amount ? "hsl(var(--status-info-fg))" : "" }}>{r.after_amount ? "+" + salShort(r.after_amount) : ""}</span></td>
                  <td className="c">{r.item_type === "JOB"
                    ? (r.has_photo ? <I.CheckCircle size={16} className="sal-photo-ok" /> : <I.AlertTriangle size={16} className="sal-photo-warn" />)
                    : <span style={{ color: "hsl(var(--muted-foreground) / .5)" }}>—</span>}</td>
                  <td className="r">
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      {b.val === null
                        ? <span style={{ color: "hsl(var(--muted-foreground) / .6)" }}>—</span>
                        : b.note
                          ? <><span className="sal-num" style={{ fontWeight: 700 }}>0₫</span><span className="sal-warn">{b.note}</span></>
                          : <span className="sal-num" style={{ fontWeight: 700, color: "hsl(var(--status-success-fg))" }}>{salFmt(b.val)}</span>}
                      {onToggleExclude && r.item_type === "JOB" && r.source_id && (
                        <button
                          type="button"
                          className={"sal-exbtn" + (r.excluded ? " on" : "")}
                          disabled={busyJobId === r.source_id}
                          onClick={() => onToggleExclude(r.source_id as string, !r.excluded)}
                          title={r.excluded ? "Tính thưởng lại cho việc này" : "Bỏ việc này khỏi thưởng"}
                        >
                          {r.excluded ? "Tính lại" : "Không tính"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={onlyWho ? 10 : 11} style={{ textAlign: "center", padding: 32, color: "hsl(var(--muted-foreground))" }}>Không có dòng nào phù hợp bộ lọc.</td></tr>}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={onlyWho ? 9 : 10} style={{ textAlign: "right", textTransform: "uppercase", fontSize: 12, letterSpacing: ".05em", color: "hsl(var(--muted-foreground))" }}>Tổng bảng kê (đang lọc)</td>
              <td className="r"><span className="sal-num" style={{ fontWeight: 800, fontSize: 14, color: "hsl(var(--primary))" }}>{salFmt(total)}</span></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
