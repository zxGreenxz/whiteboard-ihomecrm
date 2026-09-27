// Tab "Thu nhập & thanh toán" — gộp Thu nhập theo người + Thanh toán (bản Claude
// Design 26/09/2026). Trái: người nhận · Giữa: khoản theo 3 nhóm nguồn · Phải: khung
// thanh toán. Ghi tiền đi qua onPayout (salary_payout_v1, phiếu chờ duyệt) — không
// có đường ghi mới.
import { useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { todayISO } from "@/lib/collect";
import { fundLinesOf, isSupplementaryLabel } from "@/lib/salaryFundReport";
import type { SalAdjustment, SalManager } from "@/lib/managerSalary";
import type { PendingPayout } from "@/hooks/useSalaryFund";
import type { SalaryAccount } from "./SalaryMonthly";
import { salFmt } from "./salaryFormat";
import { MONO, MUTED, StChip, type ChipTone } from "./salaryFundUi";

type GroupKey = "vh" | "sale" | "dh";
const GROUP: Record<GroupKey | "ded", { title: string; src: string; color: string }> = {
  vh: { title: "Lương vận hành", src: "Quỹ lương vận hành của công ty", color: "#188552" },
  sale: { title: "Hoa hồng & thưởng Sale", src: "Chi phí của tòa phát sinh giao dịch", color: "#6334b7" },
  dh: { title: "Thu nhập đồng hành", src: "Phần lợi nhuận được phân bổ theo tòa", color: "#0e7490" },
  ded: { title: "Ứng & cấn trừ", src: "Không phải thu nhập — giảm tiền thực chuyển", color: "#c32222" },
};

interface Item {
  id: string;
  g: GroupKey;
  label: string;
  why: string;
  amount: number | null;
  chip: { t: string; tone: ChipTone };
  payable: boolean;
  strike?: boolean;
  trace: [string, string][];
  adj?: SalAdjustment;
}

function itemsOf(m: SalManager): Item[] {
  const locked = m.status === "LOCKED";
  const out: Item[] = [];
  for (const l of fundLinesOf(m)) {
    // Khoản nhập tay đi riêng bên dưới để giữ id (sửa/xoá được); ở đây chỉ còn
    // dòng lệch theo số đã chốt của nhóm này.
    if (l.group === "extra" && l.key !== "extra-locked") continue;
    const isAdj = l.group === "extra";
    out.push({
      id: "vh:" + l.key, g: "vh", label: l.label, why: l.note || "", amount: l.amount, payable: true,
      chip: locked ? { t: "Đã chốt", tone: "success" } : isAdj ? { t: "Nhập tay", tone: "neutral" } : { t: "Tạm tính", tone: "warning" },
      trace: [
        ["Căn cứ", l.note || l.label],
        [l.group === "base" ? "Bằng chứng" : isAdj ? "Cách phát sinh" : "Bằng chứng",
          l.group === "base" ? `${m.workdays} ngày công · bảng kê công việc` : isAdj ? "Thưởng/Trừ nhập tay trong bảng lương" : `${m.stats.jobs} việc trong bảng kê · ${m.stats.repairs} việc sửa chữa`],
        ["Trạng thái kỳ", locked ? "Đã chốt — dùng số đóng băng" : "Chưa chốt — số có thể đổi đến khi chốt"],
        ["Nguồn chịu tiền", GROUP.vh.src],
      ],
    });
  }
  m.adjustments.forEach((a, i) => out.push({
    id: "adj:" + (a.id || i), g: "vh", label: a.label, amount: a.amount, payable: true, adj: a,
    why: (a.amount < 0 ? "Trừ nhập tay" : "Thưởng nhập tay") + (a.note ? " · " + a.note : ""),
    chip: locked ? { t: "Đã chốt", tone: "success" } : { t: "Nhập tay", tone: "neutral" },
    trace: [
      ["Cách phát sinh", (a.amount < 0 ? "Trừ" : "Thưởng") + " nhập tay trong bảng lương"],
      ["Ghi chú", a.note || "—"],
      ["Phân loại báo cáo", a.amount < 0 ? "Khoản trừ" : isSupplementaryLabel(a.label) ? "Lương QL bổ sung (nhận theo nhãn)" : "Phụ cấp"],
      ["Nguồn chịu tiền", isSupplementaryLabel(a.label) && a.amount > 0 ? "Chủ cấp bổ sung" : GROUP.vh.src],
    ],
  }));
  m.commissionItems.forEach((c, i) => out.push({
    id: "sale:" + (c.voucherId || i), g: "sale", label: c.label, amount: c.amount, payable: true,
    why: locked ? "Đã chốt cùng bảng lương" : "Phiếu Sale nguồn chưa duyệt — tự duyệt khi chốt lương",
    chip: { t: "Đã xác nhận", tone: "success" },
    trace: [["Phiếu Sale nguồn", c.label], ["Chi phí tòa", "Ghi một lần tại phiếu Sale nguồn — trả qua lương không ghi thêm"], ["Nguồn chịu tiền", GROUP.sale.src]],
  }));
  m.commissionFlagged.forEach((c, i) => out.push({
    id: "sale-paid:" + (c.voucherId || i), g: "sale", label: c.label, amount: c.amount, payable: false, strike: true,
    why: "Phiếu đã duyệt/chi ở nơi khác — đối chiếu, không chuyển lại",
    chip: { t: "Đã trả riêng", tone: "neutral" },
    trace: [["Phiếu Sale nguồn", c.label], ["Kết quả đối chiếu", "Đã duyệt trong tháng — không cộng vào tiền còn phải chuyển"], ["Cần làm", "Kiểm tra phiếu có đúng là đã trả cho người này"]],
  }));
  if (!m.investmentLocked) {
    out.push({
      id: "dh:pending", g: "dh", label: "Lợi nhuận kỳ chưa chốt", amount: null, payable: false,
      why: "Chưa đủ cơ sở xác nhận — không phải bằng 0", chip: { t: "Lợi nhuận chưa chốt", tone: "warning" },
      trace: [["Trạng thái", "Lợi nhuận tòa chưa chốt"], ["Nguồn chịu tiền", GROUP.dh.src]],
    });
  } else {
    m.investmentBy.forEach((a, i) => out.push({
      id: "dh:" + a.b + i, g: "dh", label: `${a.b} · lợi nhuận kỳ`, amount: a.amount, payable: a.amount > 0,
      why: a.amount > 0 ? "Đã chốt · phân bổ theo thỏa thuận hiện hành" : "Đã chốt · phần phân bổ bằng 0",
      chip: a.amount > 0 ? { t: "Đã xác nhận", tone: "success" } : { t: "Đã chốt · bằng 0", tone: "neutral" },
      trace: [["Tòa", a.b], ["Lợi nhuận tòa", "Đã chốt"], ["Thỏa thuận", "Tỷ lệ đọc từ thỏa thuận tòa (không nhập tay ở đây)"], ["Nguồn chịu tiền", GROUP.dh.src]],
    }));
  }
  return out;
}

interface Props {
  managers: SalManager[];
  period: { label: string; year: number };
  selectedId: string | null;
  onSelect: (id: string) => void;
  pending: PendingPayout[];
  accounts: SalaryAccount[];
  canPay: boolean;
  onPayout: (staffId: string, staffName: string, amount: number, accountId: string, voucherDate: string, note: string) => void;
  onOpenLedger: (f: { who: string }) => void;
  onAdjust: (m: SalManager, edit?: SalAdjustment | null) => void;
  onRemoveAdjustment: (adjId: string) => void;
}

const card: CSSProperties = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, boxShadow: "var(--shadow-sm)" };

export default function SalaryIncomePay(props: Props) {
  const { managers, period, pending, onSelect } = props;
  const m = managers.find((x) => x.id === props.selectedId) || managers[0];
  const [trace, setTrace] = useState<Item | null>(null);
  if (!m) return null;
  const pendingOf = (id: string) => pending.filter((p) => p.staffId === id);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
      <div style={{ ...card, flex: "1 1 250px", maxWidth: 320, minWidth: 240 }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid hsl(var(--border))", fontSize: 14, fontWeight: 700 }}>Người nhận · {period.label}/{period.year}</div>
        {managers.map((x) => {
          const a = x.id === m.id;
          const inReq = pendingOf(x.id).reduce((s, q) => s + q.amount, 0);
          const left = Math.max(0, (x.calc?.takehome ?? 0) - x.paid - inReq);
          return (
            <button key={x.id} onClick={() => onSelect(x.id)}
              style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid hsl(var(--border) / .6)", background: a ? "hsl(var(--primary) / .08)" : "hsl(var(--card))", padding: "12px 16px", boxShadow: a ? "inset 3px 0 0 hsl(var(--primary))" : "none", cursor: "pointer" }}>
              <span className="sal-ava" style={{ width: 38, height: 38, fontSize: 14, background: x.tone === "primary" ? "hsl(var(--primary))" : "hsl(var(--status-info))" }}>{x.initials}</span>
              <span style={{ flex: 1, minWidth: 0 }}><b style={{ display: "block", fontSize: 13.5 }}>{x.name}</b><span style={{ fontSize: 11.5, color: MUTED }}>{x.role}</span></span>
              <span style={{ textAlign: "right" }}>
                <span style={{ ...MONO, display: "block", fontWeight: 700, color: "hsl(var(--primary))" }}>{salFmt(left)}</span>
                <span style={{ fontSize: 10.5, color: MUTED }}>{inReq ? `còn phải trả · ${salFmt(inReq)} chờ duyệt` : "còn phải trả"}</span>
              </span>
            </button>
          );
        })}
      </div>

      <PersonDetail key={m.id} m={m} {...props} pendingList={pendingOf(m.id)} onTrace={setTrace} />

      {trace && <TraceDrawer item={trace} who={m.name} period={`${period.label}/${period.year}`} onClose={() => setTrace(null)}
        onOpenLedger={trace.g === "vh" && !trace.adj ? () => { setTrace(null); props.onOpenLedger({ who: m.id }); } : undefined}
        onEdit={trace.adj && m.status !== "LOCKED" ? () => { const a = trace.adj; setTrace(null); props.onAdjust(m, a); } : undefined}
        onRemove={trace.adj?.id && m.status !== "LOCKED" ? () => { const id = trace.adj!.id!; setTrace(null); props.onRemoveAdjustment(id); } : undefined} />}
    </div>
  );
}

function PersonDetail({ m, period, accounts, canPay, onPayout, onAdjust, pendingList, onTrace }: Props & { m: SalManager; pendingList: PendingPayout[]; onTrace: (i: Item) => void }) {
  const items = useMemo(() => itemsOf(m), [m]);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [acc, setAcc] = useState(accounts[0]?.id || "");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState(`Lương ${period.label}/${period.year}`);
  const hasPending = pendingList.length > 0;
  const blocked = hasPending || !canPay;
  const chosen = items.filter((i) => i.payable && !off[i.id]);
  const bySrc = (g: GroupKey) => chosen.filter((i) => i.g === g).reduce((s, i) => s + (i.amount ?? 0), 0);
  const vS = bySrc("vh"), sS = bySrc("sale"), dS = bySrc("dh");
  const totalOb = vS + sS + dS;
  // Chọn đủ mọi khoản ⇒ tiền chuyển = thực nhận − đã trả, đúng số của bảng lương cũ.
  const cash = Math.max(0, totalOb - m.advance - m.roomRent - m.paid);

  const Row = ({ k, v, dot, strong, fg }: { k: string; v: string; dot?: string; strong?: boolean; fg?: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, color: fg ?? (strong ? "hsl(var(--foreground))" : "hsl(var(--status-neutral-fg))"), fontWeight: strong ? 700 : 500, borderTop: strong ? "1px solid hsl(var(--border))" : "none", paddingTop: strong ? 7 : 0 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: dot ?? "transparent" }} />{k}</span>
      <span style={{ ...MONO, whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );

  const ded = [
    ...m.advanceItems.map((a) => ({ label: a.label, sub: `Ứng ngày ${a.date} · đã chi, trừ vào lương kỳ`, chip: "Đã ứng", tone: "neutral" as ChipTone, amount: a.amount })),
    ...m.roomRentItems.map((r) => ({ label: "Tiền phòng", sub: r.label + " · cấn trừ khi thanh toán", chip: "Cấn trừ", tone: "danger" as ChipTone, amount: r.amount })),
  ];

  return <>
    <div style={{ flex: "10 1 460px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="sal-ava" style={{ width: 46, height: 46, borderRadius: 13, fontSize: 16, background: m.tone === "primary" ? "hsl(var(--primary))" : "hsl(var(--status-info))" }}>{m.initials}</span>
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-.02em" }}>{m.name}</div><div style={{ fontSize: 12.5, color: MUTED }}>{m.role}</div></div>
        {m.status !== "LOCKED" && <button className="sal-btn sal-btn--outline sal-btn--sm" onClick={() => onAdjust(m)}>+ Thưởng / trừ</button>}
      </div>
      {pendingList.map((q) => (
        <div key={q.voucherId} style={{ ...card, boxShadow: "none", borderColor: "hsl(var(--status-info) / .45)", padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <StChip tone="info">Đang chờ chi</StChip>
          <span style={{ flex: 1, minWidth: 200 }}><b style={{ fontSize: 13 }}>Phiếu chi lương · {salFmt(q.amount)}</b><br />
            <span style={{ fontSize: 11.5, color: MUTED }}>Lập {q.voucherDate ? q.voucherDate.split("-").reverse().join("/") : "—"} · chờ người duyệt ký. Không lập phiếu mới cho người này tới khi duyệt hoặc huỷ.</span></span>
          <Link to="/approvals" className="sal-btn sal-btn--outline sal-btn--sm" style={{ textDecoration: "none" }}>Mở duyệt chi</Link>
        </div>
      ))}
      {(["vh", "sale", "dh"] as GroupKey[]).map((g) => {
        const list = items.filter((i) => i.g === g);
        if (!list.length) return null;
        return (
          <div key={g} style={{ ...card, boxShadow: "none", borderLeft: `4px solid ${GROUP[g].color}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid hsl(var(--border) / .6)", flexWrap: "wrap" }}>
              <b style={{ flex: 1, fontSize: 13.5, color: GROUP[g].color }}>{GROUP[g].title}</b><span style={{ fontSize: 11.5, color: MUTED }}>{GROUP[g].src}</span>
            </div>
            {list.map((i) => {
              const ok = i.payable && !blocked && (i.amount ?? 0) >= 0; // khoản trừ luôn đi kèm, không bỏ chọn được
              return (
                <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid hsl(var(--border) / .45)", opacity: i.payable ? 1 : .7, flexWrap: "wrap" }}>
                  <input type="checkbox" aria-label={"Đưa vào thanh toán: " + i.label} checked={i.payable && !off[i.id]} disabled={!ok}
                    onChange={() => setOff((s) => ({ ...s, [i.id]: !s[i.id] }))} style={{ accentColor: "hsl(var(--primary))", width: 16, height: 16, margin: 0 }} />
                  <button onClick={() => onTrace(i)} style={{ flex: 1, minWidth: 180, border: 0, background: "transparent", padding: 0, textAlign: "left", cursor: "pointer" }}>
                    <b style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>{i.label}</b><span style={{ fontSize: 11, color: MUTED }}>{i.why}</span>
                  </button>
                  <StChip tone={i.chip.tone}>{i.chip.t}</StChip>
                  <span style={{ ...MONO, minWidth: 100, textAlign: "right", fontWeight: 600, textDecoration: i.strike ? "line-through" : "none", color: i.amount == null ? "hsl(var(--status-warning-fg))" : (i.amount < 0 ? "hsl(var(--status-danger-fg))" : undefined) }}>{i.amount == null ? "Chưa đủ cơ sở" : salFmt(i.amount)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {ded.map((d, k) => (
        <div key={k} style={{ ...card, boxShadow: "none", borderLeft: `4px solid ${GROUP.ded.color}`, display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 180 }}><b style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>{d.label}</b><span style={{ fontSize: 11, color: MUTED }}>{d.sub}</span></span>
          <StChip tone={d.tone}>{d.chip}</StChip>
          <span style={{ ...MONO, minWidth: 100, textAlign: "right", fontWeight: 600, color: "hsl(var(--status-danger-fg))" }}>−{salFmt(d.amount)}</span>
        </div>
      ))}
    </div>

    <div style={{ ...card, boxShadow: "var(--shadow-md)", position: "sticky", top: 16, flex: "1 1 300px", maxWidth: 380, minWidth: 280 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid hsl(var(--border))" }}><b style={{ fontSize: 14 }}>Thanh toán cho {m.short}</b><div style={{ fontSize: 11.5, color: MUTED }}>Kỳ {period.label}/{period.year}</div></div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <Row k="Quỹ lương vận hành" v={salFmt(vS)} dot={GROUP.vh.color} />
          <Row k="Chi phí tòa · khoản Sale nguồn" v={salFmt(sS)} dot={GROUP.sale.color} />
          <Row k="Phân bổ lợi nhuận" v={salFmt(dS)} dot={GROUP.dh.color} />
          <Row k="Tổng thu nhập được chọn" v={salFmt(totalOb)} strong />
          {m.advance > 0 && <Row k="Đã ứng (trừ lúc ứng)" v={"−" + salFmt(m.advance)} fg="hsl(var(--status-danger-fg))" />}
          {m.paid > 0 && <Row k="Đã trả trước đó" v={"−" + salFmt(m.paid)} fg="hsl(var(--status-danger-fg))" />}
        </div>
        {m.roomRent > 0 && (
          <div style={{ fontSize: 12, background: "hsl(var(--muted) / .5)", border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "10px 12px" }}>
            <b>Trừ tiền phòng {salFmt(m.roomRent)}</b><br />
            <span style={{ color: MUTED }}>{m.roomRentInvoice ? "Trừ thẳng vào hóa đơn phòng, không chuyển khoản phần này." : "Chưa có hóa đơn phòng tháng kế — trừ theo mức cố định trong cấu hình."}</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: "2px solid hsl(var(--border))", paddingTop: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "hsl(var(--primary))" }}>Tiền thực chuyển</span>
          <span style={{ ...MONO, fontWeight: 800, fontSize: 18, color: "hsl(var(--primary))" }}>{salFmt(cash)}</span>
        </div>
        <div className="sal-field"><label>Chi từ sổ</label>
          <select className="sal-select" style={{ height: 40 }} value={acc} onChange={(e) => setAcc(e.target.value)} disabled={blocked}>
            {accounts.length === 0 ? <option value="">— Chưa có sổ quỹ —</option> : accounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>
        <div className="sal-field"><label>Ngày chi</label>
          <input type="date" className="sal-input mono" value={date} onChange={(e) => setDate(e.target.value)} disabled={blocked} /></div>
        <div className="sal-field"><label>Ghi chú</label>
          <input className="sal-input" value={note} onChange={(e) => setNote(e.target.value)} disabled={blocked} /></div>
        <button className="sal-btn sal-btn--primary" style={{ justifyContent: "center" }}
          disabled={blocked || cash <= 0 || !acc}
          onClick={() => onPayout(m.id, m.name, cash, acc, date, note)}>
          {!canPay ? "Không có quyền trả lương" : hasPending ? "Đang có phiếu chờ duyệt" : cash <= 0 ? "Không còn tiền phải chuyển" : "Lập yêu cầu thanh toán"}
        </button>
        <span style={{ fontSize: 11.5, color: MUTED }}>Tạo một phiếu chi lương chờ duyệt (không tính KQKD). Khi đã có phiếu chờ duyệt, người này bị khóa để không lập trùng. Bấm tên khoản để xem căn cứ.</span>
      </div>
    </div>
  </>;
}

function TraceDrawer({ item, who, period, onClose, onOpenLedger, onEdit, onRemove }: {
  item: Item; who: string; period: string; onClose: () => void; onOpenLedger?: () => void; onEdit?: () => void; onRemove?: () => void;
}) {
  const G = GROUP[item.g];
  return <>
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(14,20,30,.42)" }} />
    <div role="dialog" aria-label={item.label} style={{ position: "fixed", zIndex: 61, top: 0, right: 0, bottom: 0, width: "min(420px,100vw)", background: "hsl(var(--card))", boxShadow: "var(--shadow-xl)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "18px 20px 14px", borderBottom: "1px solid hsl(var(--border))" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: G.color, textTransform: "uppercase", letterSpacing: ".05em" }}>{G.title}</div>
          <h3 style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 700 }}>{item.label}</h3>
          <p style={{ margin: "2px 0 0", fontSize: 12.5, color: MUTED }}>{who} · {period}</p>
        </div>
        <button onClick={onClose} aria-label="Đóng" className="sal-btn sal-btn--ghost sal-btn--icon sal-btn--sm">✕</button>
      </div>
      <div style={{ padding: "16px 20px", overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <StChip tone={item.chip.tone}>{item.chip.t}</StChip>
          <span style={{ ...MONO, fontWeight: 800, fontSize: 20 }}>{item.amount == null ? "Chưa đủ cơ sở" : salFmt(item.amount)}</span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED }}>Truy ngược căn cứ</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {item.trace.map(([k, v], i) => (
            <div key={i} style={{ display: "flex", gap: 12 }}>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "center" }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: G.color, marginTop: 4 }} /><span style={{ flex: 1, width: 2, background: "hsl(var(--border))" }} /></span>
              <span style={{ paddingBottom: 14, minWidth: 0 }}><span style={{ display: "block", fontSize: 11.5, color: MUTED }}>{k}</span><b style={{ fontSize: 13, fontWeight: 600 }}>{v}</b></span>
            </div>
          ))}
        </div>
        {onOpenLedger && <button className="sal-btn sal-btn--outline" onClick={onOpenLedger}>Xem bảng kê công việc</button>}
        {(onEdit || onRemove) && (
          <div style={{ display: "flex", gap: 8 }}>
            {onEdit && <button className="sal-btn sal-btn--outline" onClick={onEdit}>Sửa khoản</button>}
            {onRemove && <button className="sal-btn sal-btn--ghost" style={{ color: "hsl(var(--status-danger-fg))" }} onClick={onRemove}>Xoá khoản</button>}
          </div>
        )}
      </div>
    </div>
  </>;
}
