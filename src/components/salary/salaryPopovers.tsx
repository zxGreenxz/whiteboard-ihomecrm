// Bảng lương — popover chi tiết (Thưởng / Đầu tư / HH Sale / Ứng). Dùng chung
// cho Tab 1 (bảng lương) và self-view. Port từ kit SalaryMonthly.jsx.
import React from "react";
import { SAL_ICONS } from "./salaryIcons";
import { salFmt } from "./salaryFormat";
import { commissionFlaggedNote, commissionItemNote, type SalManager, type SalAdjustment } from "@/lib/managerSalary";
import { investmentPayState } from "@/lib/salaryProfit";

const I = SAL_ICONS;

export function PopRow({ icon, label, note, amount, muted, acts }: {
  icon: string; label: string; note?: string | null; amount: number; muted?: boolean; acts?: React.ReactNode;
}) {
  const neg = amount < 0;
  return (
    <div className={"sal-pop-row" + (muted ? " is-muted" : "")}>
      <span className="ric" style={neg ? { background: "hsl(var(--status-danger-bg))", color: "hsl(var(--status-danger-fg))" } : undefined}>
        {React.createElement(I[icon] || I.Circle, { size: 15 })}
      </span>
      <span className="rl"><b>{label}</b>{note ? <small>{note}</small> : null}</span>
      <span className="ra" style={neg ? { color: "hsl(var(--status-danger-fg))" } : undefined}>{salFmt(amount)}</span>
      {acts ? <span className="acts">{acts}</span> : null}
    </div>
  );
}

export function BonusPop({ m, periodText, locked, onClose, onAdjust, onRemove, onOpenLedger }: {
  m: SalManager; periodText: string; locked?: boolean; onClose: () => void;
  onAdjust: (a: SalAdjustment) => void; onRemove: (id: string) => void; onOpenLedger: (f: { who: string }) => void;
}) {
  const bonus = m.calc?.bonus ?? 0;
  return (
    <>
      <div className="sal-pop-head">
        <span className="ic" style={{ background: "hsl(var(--status-warning-bg))", color: "hsl(var(--status-warning-fg))" }}><I.Gift size={17} /></span>
        <div><div className="tt">Chi tiết thưởng</div><div className="st">{m.short} · {periodText}</div></div>
      </div>
      <div className="sal-pop-body">
        {m.bonusAuto.map((r, i) => <PopRow key={"a" + i} icon={r.icon} label={r.label} note={r.note} amount={r.amount} />)}
        {m.adjustments.map((r, i) => (
          <PopRow key={"m" + i} icon={r.icon} label={r.label} note={r.note} amount={r.amount}
            acts={!locked && !r.recurring ? <>
              <button title="Sửa" onClick={() => onAdjust(r)}><I.Pencil size={13} /></button>
              <button title="Xoá" onClick={() => r.id && onRemove(r.id)}><I.Trash size={13} /></button>
            </> : null} />
        ))}
        {m.bonusAuto.length === 0 && m.adjustments.length === 0 && (
          <div style={{ padding: "18px 16px", textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Chưa có khoản thưởng nào.</div>
        )}
      </div>
      <div className="sal-pop-foot"><span className="tl">Tổng thưởng</span><span className="tv">{salFmt(bonus)}</span></div>
      <button className="sal-pop-link" onClick={() => { onClose(); onOpenLedger({ who: m.id }); }}>
        Xem bảng kê đầy đủ <I.ArrowRight size={14} />
      </button>
    </>
  );
}

export function InvestmentPop({ m, periodText }: { m: SalManager; periodText: string }) {
  const payNote = investmentPayNote(m);
  if (!m.investmentLocked) {
    return (
      <>
        <div className="sal-pop-head">
          <span className="ic" style={{ background: "hsl(var(--status-warning-bg))", color: "hsl(var(--status-warning-fg))" }}><I.Hourglass size={16} /></span>
          <div><div className="tt">Lợi nhuận đầu tư</div><div className="st">{m.short} · {periodText}</div></div>
        </div>
        <div className="sal-pop-body"><div style={{ padding: "20px 16px", textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>
          <I.Hourglass size={26} style={{ color: "hsl(var(--status-warning-strong))", marginBottom: 8 }} /><br />Chờ chốt Lợi nhuận cổ đông tháng này.
        </div></div>
      </>
    );
  }
  return (
    <>
      <div className="sal-pop-head">
        <span className="ic" style={{ background: "hsl(var(--status-info-bg))", color: "hsl(var(--status-info-fg))" }}><I.TrendingUp size={17} /></span>
        <div><div className="tt">Lợi nhuận đầu tư theo nhà</div><div className="st">Lấy từ Chia lợi nhuận cổ đông · đã chốt</div></div>
      </div>
      <div className="sal-pop-body">
        {m.investmentBy.length === 0
          ? <div style={{ padding: "18px 16px", textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Chưa có phần đầu tư tháng này.</div>
          : m.investmentBy.map((r, i) => <PopRow key={i} icon="Building" label={r.b} amount={r.amount} />)}
        {payNote && <div style={{ padding: "8px 16px", fontSize: 12, color: "hsl(var(--muted-foreground))" }}>{payNote}</div>}
      </div>
      <div className="sal-pop-foot"><span className="tl">Tổng</span><span className="tv">{salFmt(m.investment)}</span></div>
    </>
  );
}

/** Trạng thái trả phần đầu tư của cổ đông (sổ tổng) — null với nhân viên thường. */
function investmentPayNote(m: SalManager): string | null {
  const st = investmentPayState(m);
  if (!st) return null;
  if (st.kind === "MARKER") return `Đã trả theo mốc "đã trả đủ${st.through ? ` đến hết ${st.through.slice(5, 7)}/${st.through.slice(0, 4)}` : ""}" — không trả lại qua lương.`;
  if (st.kind === "REVIEW") return `Cần chủ xem lại phần lợi nhuận ở phiếu ${st.codes.join(", ")}.`;
  if (st.kind === "PAID" || st.kind === "PARTIAL") return `Đã trả ${salFmt(st.paid)} qua phiếu ${st.codes.join(", ")}.`;
  return "Chưa trả qua phiếu lương nào.";
}

export function CommissionPop({ m }: { m: SalManager }) {
  const total = m.commissionItems.reduce((s, x) => s + x.amount, 0);
  const flagged = m.commissionFlagged || [];
  return (
    <>
      <div className="sal-pop-head">
        <span className="ic" style={{ background: "hsl(var(--status-success-bg))", color: "hsl(var(--status-success-fg))" }}><I.HandCoins size={17} /></span>
        <div><div className="tt">HH Sale (hoa hồng)</div><div className="st">Người nhận = quản lý (ô QL hoặc tên) · sổ ảo trả qua lương</div></div>
      </div>
      <div className="sal-pop-body">
        {m.commissionItems.length === 0 && flagged.length === 0 ? (
          <div style={{ padding: "18px 16px", textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Tháng này chưa có hoa hồng (người nhận là quản lý này).</div>
        ) : (
          <>
            {m.commissionItems.map((x, i) => (
              <div key={"c" + i} className="sal-pop-row">
                <span className="ric"><I.Clock size={15} /></span>
                <span className="rl"><b>{x.label}</b><small style={{ color: (x.paidElsewhere || 0) > 0 ? "hsl(var(--muted-foreground))" : "hsl(var(--status-warning-fg))" }}>{commissionItemNote(x, m.status === "LOCKED")}</small></span>
                <span className="ra">{salFmt(x.amount)}</span>
              </div>
            ))}
            {flagged.length > 0 && (
              <>
                <div style={{ padding: "8px 16px 4px", fontSize: 12, fontWeight: 700, color: "hsl(var(--status-danger-fg))", display: "flex", alignItems: "center", gap: 6 }}>
                  <I.AlertTriangle size={14} />Đã tính vào lương người khác (không cộng vào HH Sale)
                </div>
                {flagged.map((x, i) => (
                  <div key={"f" + i} className="sal-pop-row">
                    <span className="ric" style={{ background: "hsl(var(--status-danger-bg))", color: "hsl(var(--status-danger-fg))" }}><I.AlertTriangle size={15} /></span>
                    <span className="rl"><b>{x.label}</b><small style={{ color: "hsl(var(--status-danger-fg))" }}>{commissionFlaggedNote(x)}</small></span>
                    <span className="ra" style={{ color: "hsl(var(--status-danger-fg))" }}>{salFmt(x.amount)}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <div className="sal-pop-foot"><span className="tl">Tổng HH Sale</span><span className="tv">{salFmt(total)}</span></div>
    </>
  );
}

export function RoomRentPop({ m, periodText }: { m: SalManager; periodText: string }) {
  return (
    <>
      <div className="sal-pop-head">
        <span className="ic" style={{ background: "hsl(var(--status-danger-bg))", color: "hsl(var(--status-danger-fg))" }}><I.Home size={17} /></span>
        <div><div className="tt">Tiền phòng</div><div className="st">{m.short} · {periodText}</div></div>
      </div>
      <div className="sal-pop-body">
        {m.roomRentItems.length === 0 ? <div style={{ padding: "18px 16px", textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Không trừ tiền phòng.</div> :
          m.roomRentItems.map((x, i) => <PopRow key={i} icon="Home" label={x.label} amount={x.amount} />)}
      </div>
      <div className="sal-pop-foot"><span className="tl">Trừ tiền phòng</span><span className="tv" style={{ color: "hsl(var(--status-danger-fg))" }}>{salFmt(m.roomRent)}</span></div>
    </>
  );
}

export function AdvancePop({ m, periodText }: { m: SalManager; periodText: string }) {
  return (
    <>
      <div className="sal-pop-head">
        <span className="ic" style={{ background: "hsl(var(--status-danger-bg))", color: "hsl(var(--status-danger-fg))" }}><I.PiggyBank size={17} /></span>
        <div><div className="tt">Ứng lương</div><div className="st">{m.short} · {periodText}</div></div>
      </div>
      <div className="sal-pop-body">
        {m.advanceItems.length === 0 ? <div style={{ padding: "18px 16px", textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Chưa có khoản ứng nào.</div> :
          m.advanceItems.map((x, i) => <PopRow key={i} icon="Banknote" label={x.label}
            note={x.kind === "PROFIT_ADVANCE" ? "trừ trong phần lợi nhuận đầu tư" : x.kind === "PROFIT_MARKER" ? "đã trả theo mốc — không chuyển lại" : x.date} amount={x.amount} />)}
      </div>
      <div className="sal-pop-foot"><span className="tl">Tổng đã ứng</span><span className="tv" style={{ color: "hsl(var(--status-danger-fg))" }}>{salFmt(m.advance)}</span></div>
    </>
  );
}
