// Tab 1 — Bảng lương tháng. Port từ kit SalaryMonthly.jsx, nối callback thật.
import React, { useState } from "react";
import { todayISO } from "@/lib/collect";
import { SAL_ICONS } from "./salaryIcons";
import { salFmt, salShort } from "./salaryFormat";
import { ClickNum, Popover, Menu, Modal, Ring, useCountUp } from "./salaryCommon";
import { BonusPop, InvestmentPop, CommissionPop, AdvancePop, RoomRentPop } from "./salaryPopovers";
import { SalChartModal } from "./salaryChart";
import type { SalManager, SalAdjustment } from "@/lib/managerSalary";

const I = SAL_ICONS;
// Ngày chi theo GIỜ LOCAL — toISOString() là UTC, chi lương lúc 00:00-07:00 VN
// sẽ rơi vào THÁNG TRƯỚC (audit 2026-07-20). Dùng helper canonical ở lib/collect.
const today = todayISO;
const parseNum = (s: string) => parseInt((s || "").replace(/\D/g, ""), 10) || 0;

export interface SalaryAccount { id: string; name: string; }

export interface SalAdjustPayload { id?: string; kind: "BONUS" | "DEDUCTION"; label: string; amount: number; note?: string | null; }

interface MonthlyProps {
  managers: SalManager[];
  period: { label: string; year: number };
  locked: boolean;
  accounts: SalaryAccount[];
  canLock: boolean;
  canPay: boolean;
  onSaveAdjustment: (staffId: string, payload: SalAdjustPayload) => void;
  onRemoveAdjustment: (adjId: string) => void;
  onPayout: (staffId: string, staffName: string, amount: number, accountId: string, voucherDate: string, note: string) => void;
  onBulkPayout: (rows: { staffId: string; staffName: string; amount: number }[], accountId: string) => void;
  onLock: () => void;
  onUnlock: () => void;
  onOpenLedger: (f: { who: string }) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onRecompute: () => void;
}

// ---- Dialogs ----
function AdjustDialog({ m, edit, onClose, onSave }: { m: SalManager; edit?: SalAdjustment | null; onClose: () => void; onSave: (p: SalAdjustPayload) => void }) {
  const [kind, setKind] = useState<"Thưởng" | "Trừ">(edit ? (edit.amount < 0 ? "Trừ" : "Thưởng") : "Thưởng");
  const [label, setLabel] = useState(edit ? edit.label : "");
  const [amount, setAmount] = useState(edit ? String(Math.abs(edit.amount)) : "");
  const [note, setNote] = useState(edit?.note || "");
  const numVal = parseNum(amount);
  const save = () => {
    if (!label.trim() || !numVal) return;
    onSave({ id: edit?.id, kind: kind === "Trừ" ? "DEDUCTION" : "BONUS", label: label.trim(), amount: numVal, note: note.trim() || null });
    onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--status-warning-bg))", color: "hsl(var(--status-warning-fg))" }}><I.Gift size={19} /></span>
        <div><h3>{edit ? "Sửa khoản thưởng / trừ" : "Thêm thưởng / trừ"}</h3><p>{m.name}</p></div>
        <button className="x" onClick={onClose}><I.X size={18} /></button>
      </div>
      <div className="sal-modal-body">
        <div className="sal-field"><label>Loại</label>
          <div className="sal-segment">
            <button className="pos" data-active={kind === "Thưởng"} onClick={() => setKind("Thưởng")}><I.Plus size={15} />Thưởng</button>
            <button className="neg" data-active={kind === "Trừ"} onClick={() => setKind("Trừ")}><I.Minus size={15} />Trừ</button>
          </div>
        </div>
        <div className="sal-field"><label>Nội dung</label>
          <input className="sal-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="VD: Bonus QL, fighting, hỗ trợ xăng…" autoFocus /></div>
        <div className="sal-field"><label>Số tiền</label>
          <input className="sal-input mono" value={numVal ? numVal.toLocaleString("vi-VN") : amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="numeric" /></div>
        <div className="sal-field"><label>Ghi chú</label>
          <textarea className="sal-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tuỳ chọn…" /></div>
      </div>
      <div className="sal-modal-foot">
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className="sal-btn sal-btn--primary" onClick={save} disabled={!label.trim() || !numVal}>Lưu</button>
      </div>
    </Modal>
  );
}

function PayoutDialog({ m, accounts, period, onClose, onSave }: {
  m: SalManager; accounts: SalaryAccount[]; period: { label: string; year: number };
  onClose: () => void; onSave: (amount: number, accountId: string, voucherDate: string, note: string) => void;
}) {
  const remain = (m.calc?.takehome ?? 0) - m.paid;
  const [amount, setAmount] = useState(String(Math.max(remain, 0)));
  const [acc, setAcc] = useState(accounts[0]?.id || "");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("Lương " + period.label + "/" + period.year);
  const numVal = parseNum(amount);
  return (
    <Modal onClose={onClose}>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--primary) / .12)", color: "hsl(var(--primary))" }}><I.Wallet size={19} /></span>
        <div><h3>Trả lương</h3><p>{m.name} · còn nhận {salFmt(remain)}</p></div>
        <button className="x" onClick={onClose}><I.X size={18} /></button>
      </div>
      <div className="sal-modal-body">
        <div className="sal-field"><label>Số tiền</label>
          <input className="sal-input mono" value={numVal ? numVal.toLocaleString("vi-VN") : amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" /></div>
        <div className="sal-field"><label>Chi từ sổ quỹ</label>
          <select className="sal-select" style={{ height: 40 }} value={acc} onChange={(e) => setAcc(e.target.value)}>
            {accounts.length === 0 ? <option value="">— Chưa có sổ quỹ —</option> : accounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>
        <div className="sal-field"><label>Ngày chi</label>
          <input type="date" className="sal-input mono" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="sal-field"><label>Ghi chú</label>
          <textarea className="sal-input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="sal-helprow"><I.Info size={15} />Tạo phiếu chi trong sổ thu chi — không tính KQKD.</div>
      </div>
      <div className="sal-modal-foot">
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className="sal-btn sal-btn--primary" onClick={() => { onSave(numVal, acc, date, note); onClose(); }} disabled={!numVal || !acc}><I.Check size={16} />Ghi phiếu chi</button>
      </div>
    </Modal>
  );
}

function BulkPayoutDialog({ managers, accounts, period, onClose, onSave }: {
  managers: SalManager[]; accounts: SalaryAccount[]; period: { label: string; year: number };
  onClose: () => void; onSave: (rows: { staffId: string; staffName: string; amount: number }[], accountId: string) => void;
}) {
  const rows = managers.map((m) => ({ m, remain: (m.calc?.takehome ?? 0) - m.paid })).filter((r) => r.remain > 0);
  const total = rows.reduce((s, r) => s + r.remain, 0);
  const [acc, setAcc] = useState(accounts[0]?.id || "");
  return (
    <Modal onClose={onClose} wide>
      <div className="sal-modal-head">
        <span className="mic" style={{ background: "hsl(var(--primary) / .12)", color: "hsl(var(--primary))" }}><I.Wallet size={19} /></span>
        <div><h3>Trả lương hàng loạt</h3><p>{rows.length} quản lý · {period.label}/{period.year}</p></div>
        <button className="x" onClick={onClose}><I.X size={18} /></button>
      </div>
      <div className="sal-modal-body">
        {rows.length === 0 ? <p style={{ color: "hsl(var(--muted-foreground))" }}>Tất cả đã được trả đủ.</p> : rows.map((r) => (
          <div key={r.m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid hsl(var(--border) / .6)" }}>
            <span className="sal-ava" style={{ width: 32, height: 32, fontSize: 13, background: `hsl(var(--${r.m.tone === "primary" ? "primary" : "status-info"}))` }}>{r.m.initials}</span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{r.m.name}</span>
            <span className="sal-num" style={{ fontWeight: 700 }}>{salFmt(r.remain)}</span>
          </div>
        ))}
        <div className="sal-field" style={{ marginTop: 6 }}><label>Chi từ sổ quỹ</label>
          <select className="sal-select" style={{ height: 40 }} value={acc} onChange={(e) => setAcc(e.target.value)}>
            {accounts.length === 0 ? <option value="">— Chưa có sổ quỹ —</option> : accounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      </div>
      <div className="sal-modal-foot" style={{ alignItems: "center" }}>
        <div style={{ marginRight: "auto", fontSize: 13 }}>Tổng chi <b className="sal-num" style={{ color: "hsl(var(--primary))", fontSize: 16 }}>{salFmt(total)}</b></div>
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className="sal-btn sal-btn--primary" onClick={() => { onSave(rows.map((r) => ({ staffId: r.m.id, staffName: r.m.name, amount: r.remain })), acc); onClose(); }} disabled={!rows.length || !acc}><I.Check size={16} />Ghi {rows.length} phiếu chi</button>
      </div>
    </Modal>
  );
}

function LockDialog({ locked, period, onClose, onConfirm }: { locked: boolean; period: { label: string; year: number }; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="sal-modal-head">
        <span className="mic" style={locked ? { background: "hsl(var(--status-warning-bg))", color: "hsl(var(--status-warning-fg))" } : { background: "hsl(var(--status-success-bg))", color: "hsl(var(--status-success-fg))" }}>
          {locked ? <I.Unlock size={19} /> : <I.Lock size={19} />}</span>
        <div><h3>{locked ? "Mở khoá tháng?" : "Chốt tháng?"}</h3><p>{period.label}/{period.year}</p></div>
        <button className="x" onClick={onClose}><I.X size={18} /></button>
      </div>
      <div className="sal-modal-body">
        <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "hsl(var(--muted-foreground))" }}>
          {locked
            ? "Mở khoá cho phép sửa lại số liệu. Mọi thay đổi việc/HĐ cũ sẽ lại ảnh hưởng tháng này. Nếu đã có phiếu trả lương, hãy kiểm tra lại."
            : "Hệ thống tính lần cuối và đóng băng toàn bộ bảng lương + bảng kê (snapshot). Sau khi chốt, sửa hay đóng việc cũ sẽ không còn ảnh hưởng tháng này."}
        </p>
      </div>
      <div className="sal-modal-foot">
        <button className="sal-btn sal-btn--ghost" onClick={onClose}>Huỷ</button>
        <button className={"sal-btn " + (locked ? "sal-btn--outline" : "sal-btn--primary")} onClick={() => { onConfirm(); onClose(); }}>
          {locked ? <><I.Unlock size={16} />Mở khoá</> : <><I.Lock size={16} />Chốt tháng</>}
        </button>
      </div>
    </Modal>
  );
}

export default function SalaryMonthly(props: MonthlyProps) {
  const { managers, period, locked, accounts, canLock, canPay,
    onSaveAdjustment, onRemoveAdjustment, onPayout, onBulkPayout, onLock, onUnlock, onOpenLedger,
    onPrevMonth, onNextMonth, onRecompute } = props;
  const periodText = `${period.label}/${period.year}`;
  const [pop, setPop] = useState<{ type: string; m: SalManager; rect: DOMRect } | null>(null);
  const [menu, setMenu] = useState<{ m: SalManager; rect: DOMRect } | null>(null);
  const [dialog, setDialog] = useState<{ type: string; m: SalManager; edit?: SalAdjustment | null } | null>(null);
  const [exporting, setExporting] = useState<{ rect: DOMRect } | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [showLock, setShowLock] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [chartModal, setChartModal] = useState(false);

  const openPop = (type: string, m: SalManager, e: React.MouseEvent) => setPop({ type, m, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
  const totals = managers.reduce((t, m) => {
    const c = m.calc!;
    t.base += m.base; t.bonus += c.bonus; t.inv += m.investment; t.com += m.commission;
    t.gross += c.gross; t.adv += m.advance; t.room += m.roomRent; t.take += c.takehome; return t;
  }, { base: 0, bonus: 0, inv: 0, com: 0, gross: 0, adv: 0, room: 0, take: 0 });

  // ---- Derived metrics cho command center / KPI / leaderboard ----
  const N = managers.length;
  const pctOf = (m: SalManager) => (m.incomeGoal > 0 ? Math.round(((m.calc?.gross ?? 0) / m.incomeGoal) * 100) : 0);
  // "Đã trả/settled" = không còn nợ — kể cả takehome ≤ 0 (ứng/tiền phòng nuốt hết
  // lương → không cần phiếu chi), kẻo tiến độ chốt kẹt mãi ở bước "Trả lương".
  const isPaid = (m: SalManager) => (m.calc?.takehome ?? 0) - m.paid <= 0;
  const paidCount = managers.filter(isPaid).length;
  const unpaidCount = N - paidCount;
  const withGoal = managers.filter((m) => m.incomeGoal > 0);
  const avgPct = withGoal.length
    ? Math.round(withGoal.reduce((s, m) => s + ((m.calc?.gross ?? 0) / m.incomeGoal) * 100, 0) / withGoal.length)
    : 0;
  const overCount = withGoal.filter((m) => pctOf(m) >= 100).length;
  const mgrCount = managers.filter((m) => /quản\s*lý/i.test(m.role)).length;
  const staffCount = N - mgrCount;
  const bonusPool = totals.bonus + totals.com;

  // Tiến độ chốt: tính lương (luôn xong) → trả lương → chốt & khoá
  const stepPaid = N > 0 && paidCount === N;
  const doneSteps = 1 + (stepPaid ? 1 : 0) + (locked ? 1 : 0);
  const readyPct = Math.round((doneSteps / 3) * 100);

  const treasury = useCountUp(totals.take, [totals.take]);

  const ranked = [...managers].sort((a, b) => pctOf(b) - pctOf(a));
  const medals = ["🥇", "🥈", "🥉"];

  const splitComps = [
    { label: "Lương cứng", val: totals.base, color: "hsl(var(--status-neutral-strong))" },
    { label: "Đầu tư", val: totals.inv, color: "hsl(var(--primary))" },
    { label: "HH Sale", val: totals.com, color: "hsl(var(--status-tasks))" },
    { label: "Thưởng việc", val: totals.bonus, color: "hsl(var(--status-warning-strong))" },
  ].filter((c) => c.val > 0);
  const splitMax = Math.max(...splitComps.map((c) => c.val), 1);

  const chips = [
    { label: "Lương cứng", amt: totals.base, neg: false, color: "hsl(var(--foreground))", background: "hsl(var(--muted) / .7)", border: "1px solid hsl(var(--border))", show: true },
    { label: "Thưởng", amt: totals.bonus, neg: false, color: "hsl(var(--status-warning-fg))", background: "hsl(var(--status-warning-bg))", show: totals.bonus > 0 },
    { label: "Đầu tư", amt: totals.inv, neg: false, color: "hsl(var(--primary))", background: "hsl(var(--primary) / .1)", show: totals.inv > 0 },
    { label: "HH Sale", amt: totals.com, neg: false, color: "hsl(var(--status-tasks-fg))", background: "hsl(var(--status-tasks-bg))", show: totals.com > 0 },
    { label: "Ứng", amt: totals.adv, neg: true, color: "hsl(var(--status-danger-fg))", background: "hsl(var(--status-danger-bg))", show: totals.adv > 0 },
    { label: "Tiền phòng", amt: totals.room, neg: true, color: "hsl(var(--status-danger-fg))", background: "hsl(var(--status-danger-bg))", show: totals.room > 0 },
  ].filter((c) => c.show);

  const doRecompute = () => { setRecomputing(true); onRecompute(); setTimeout(() => setRecomputing(false), 950); };

  return (
    <div className="sal-month">
      {/* ===== HERO COMMAND CENTER ===== */}
      <div className="sal-cmd">
        <div className="sal-cmd-main">
          <div className="sal-cmd-top">
            <div className="sal-monthnav">
              <button className="sal-monthbtn" aria-label="Tháng trước" onClick={onPrevMonth}><I.ChevronLeft size={17} /></button>
              <span className="sal-monthlabel">{period.label} · {period.year}</span>
              <button className="sal-monthbtn" aria-label="Tháng sau" onClick={onNextMonth}><I.ChevronRight size={17} /></button>
            </div>
            {locked ? (
              <span className="sal-status sal-status--locked"><I.Lock size={14} />Đã chốt</span>
            ) : (
              <span className="sal-status sal-status--draft"><span className="dot" />Bản nháp <small>· cập nhật realtime</small></span>
            )}
          </div>

          <div className="sal-cmd-cap"><I.BarChart size={16} />Tổng quỹ thực chi tháng này · {N} nhân sự</div>
          <div className="sal-cmd-num">{Math.round(treasury).toLocaleString("vi-VN")}<span className="u">₫</span></div>

          <div className="sal-cmd-chips">
            {chips.map((c, i) => (
              <span key={i} className="sal-cmd-chip" style={{ color: c.color, background: c.background, border: c.border || "1px solid transparent" }}>
                {c.label} <b>{c.neg ? "−" : "+"}{Math.round(c.amt).toLocaleString("vi-VN")}</b>
              </span>
            ))}
          </div>

          <div className="sal-cmd-actions">
            {canPay && <button className="sal-btn sal-btn--primary" onClick={() => setShowBulk(true)}><I.HandCoins size={16} />Trả lương hàng loạt</button>}
            {!locked && <button className="sal-btn sal-btn--outline" onClick={doRecompute}><I.RefreshCw size={15} style={recomputing ? { animation: "salSpin .95s linear" } : undefined} />Tính lại</button>}
            <button className="sal-btn sal-btn--outline" title="Xem biểu đồ lương các tháng" onClick={() => setChartModal(true)}><I.BarChart size={16} />Biểu đồ</button>
            <button className="sal-btn sal-btn--outline" onClick={(e) => setExporting({ rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}><I.Download size={15} />Xuất Excel</button>
            {canLock && (locked
              ? <button className="sal-btn sal-btn--outline sp" onClick={() => setShowLock(true)}><I.Unlock size={15} />Mở khoá</button>
              : <button className="sal-btn sal-btn--primary sp" onClick={() => setShowLock(true)}><I.Lock size={15} />Chốt tháng</button>)}
          </div>
        </div>

        {/* close readiness */}
        <div className="sal-ready">
          <div className="sal-ready-top">
            <Ring pct={readyPct} size={72} stroke={7}>
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 19, color: "hsl(var(--primary))" }}>{readyPct}%</span>
            </Ring>
            <div>
              <div className="tt">Tiến độ chốt lương</div>
              <div className="st">{doneSteps}/3 bước hoàn tất{unpaidCount > 0 ? ` · còn ${unpaidCount} phiếu chờ trả` : " · đã trả đủ"}</div>
            </div>
          </div>

          <div className="sal-ready-step">
            <span className="rd done"><I.Check size={14} /></span>
            <div className="rl"><b>Tính lương tự động</b><small style={{ color: "hsl(var(--primary))" }}>{N}/{N} nhân sự · xong</small></div>
          </div>
          <div className="sal-ready-step">
            <span className={"rd " + (stepPaid ? "done" : "active")}>{stepPaid ? <I.Check size={14} /> : 2}</span>
            <div className="rl">
              <b style={stepPaid ? undefined : { color: "hsl(var(--status-warning-fg))" }}>Trả lương</b>
              <small style={{ color: stepPaid ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>{paidCount}/{N} đã trả{stepPaid ? " · xong" : " · đang chờ"}</small>
            </div>
            {canPay && !stepPaid && !locked && (
              <button className="sal-btn sal-btn--primary sal-btn--sm" onClick={() => setShowBulk(true)}>Trả ngay</button>
            )}
          </div>
          <div className="sal-ready-step">
            <span className={"rd " + (locked ? "done" : "todo")}>{locked ? <I.Check size={14} /> : <I.Lock size={14} />}</span>
            <div className="rl"><b style={{ color: locked ? undefined : "hsl(var(--muted-foreground))" }}>Chốt &amp; khoá tháng</b><small style={{ color: "hsl(var(--muted-foreground))" }}>{locked ? "Đã khoá — số liệu đóng băng" : "Không thể sửa sau khi chốt"}</small></div>
          </div>
        </div>
      </div>

      {/* ===== KPI CARDS ===== */}
      <div className="sal-kpis">
        <div className="sal-kpi" style={{ borderLeftColor: "hsl(var(--status-info))" }}>
          <span className="ki" style={{ background: "hsl(var(--status-info) / .1)", color: "hsl(var(--status-info))" }}><I.Users size={22} /></span>
          <div>
            <div className="kv">{N}</div>
            <div className="kl">Nhân sự hưởng lương</div>
            <div className="kx" style={{ color: "hsl(var(--status-info))" }}>{mgrCount > 0 ? `${mgrCount} quản lý` : ""}{mgrCount > 0 && staffCount > 0 ? " · " : ""}{staffCount > 0 ? `${staffCount} nhân viên` : ""}{mgrCount === 0 && staffCount === 0 ? "—" : ""}</div>
          </div>
        </div>
        <div className="sal-kpi" style={{ borderLeftColor: "hsl(var(--primary))" }}>
          <Ring pct={Math.min(avgPct, 100)} size={48} stroke={5}><I.TrendingUp size={18} style={{ color: "hsl(var(--primary))" }} /></Ring>
          <div>
            <div className="kv">{withGoal.length ? `${avgPct}%` : "—"}</div>
            <div className="kl">Hiệu suất đội TB</div>
            <div className="kx" style={{ color: "hsl(var(--primary))" }}>{withGoal.length ? `${overCount}/${withGoal.length} vượt mục tiêu` : "Chưa đặt mục tiêu"}</div>
          </div>
        </div>
        <div className="sal-kpi" style={{ borderLeftColor: "hsl(var(--status-warning-strong))" }}>
          <span className="ki" style={{ background: "hsl(var(--status-warning) / .14)", color: "hsl(var(--status-warning-fg))" }}><I.Trophy size={22} /></span>
          <div>
            <div className="kv">{salShort(bonusPool)}</div>
            <div className="kl">Quỹ thưởng &amp; hoa hồng</div>
            <div className="kx" style={{ color: "hsl(var(--status-warning-fg))" }}>Thưởng việc + HH Sale</div>
          </div>
        </div>
        <div className="sal-kpi" style={{ borderLeftColor: "hsl(var(--status-danger))" }}>
          <span className="ki" style={{ background: "hsl(var(--status-danger) / .1)", color: "hsl(var(--status-danger-fg))" }}><I.Clock size={22} /></span>
          <div>
            <div className="kv">{unpaidCount}</div>
            <div className="kl">Phiếu chờ thanh toán</div>
            <div className="kx" style={{ color: "hsl(var(--status-danger-fg))" }}>{paidCount} đã trả · {unpaidCount} chưa trả</div>
          </div>
        </div>
      </div>

      {/* ===== PAYROLL TABLE ===== */}
      <div className="sal-card">
      <div className="sal-sheet-head">
        <span className="shi"><I.Wallet size={18} /></span>
        <div>
          <h3>Bảng lương {period.label}</h3>
          <p>Nhấp vào một con số để bóc tách chi tiết</p>
        </div>
      </div>
      <div className="sal-tablewrap">
        <table className="sal-sheet">
          <thead>
            <tr>
              <th className="l">Họ và tên</th>
              <th className="c">Ngày công</th>
              <th>Lương tháng</th>
              <th>Thưởng</th>
              <th>Lợi nhuận ĐT</th>
              <th>HH Sale</th>
              <th>Tổng lương</th>
              <th>Ứng lương</th>
              <th>Tiền phòng</th>
              <th>Thực nhận</th>
              <th className="c">Trạng thái</th>
              <th className="c"></th>
            </tr>
          </thead>
          <tbody>
            {managers.map((m) => {
              const c = m.calc!;
              const pct = m.incomeGoal ? Math.round((c.gross / m.incomeGoal) * 100) : 0;
              const paidState = isPaid(m);
              const rowLocked = m.status === "LOCKED";
              return (
                <tr key={m.id}>
                  <td className="l">
                    <div className="sal-namecell">
                      <span className="sal-ava" style={{ background: m.tone === "primary" ? "hsl(var(--primary))" : "hsl(var(--status-info))" }}>{m.initials}</span>
                      <div className="sal-nameinfo">
                        <span className="nm">{m.short}{m.alias ? <span className="sal-alias">{m.alias}</span> : null}</span>
                        <span className="rl">{m.role}</span>
                      </div>
                    </div>
                  </td>
                  <td className="c"><span className="sal-num" style={{ fontWeight: 600 }}>{m.workdays}</span></td>
                  <td><span className="sal-num">{salFmt(m.base)}</span></td>
                  <td>
                    <ClickNum value={c.bonus} onClick={(e) => openPop("bonus", m, e)} />
                    {!rowLocked && <div><button className="sal-addbonus" onClick={() => setDialog({ type: "adjust", m })}><I.Plus size={11} />Thưởng</button></div>}
                  </td>
                  <td>{m.investmentLocked
                    ? <ClickNum value={m.investment} onClick={(e) => openPop("investment", m, e)} />
                    : <button className="sal-link is-pending" onClick={(e) => openPop("investment", m, e)}><I.Hourglass size={13} />Chờ chốt</button>}</td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {m.commission > 0
                        ? <ClickNum value={m.commission} onClick={(e) => openPop("commission", m, e)} />
                        : <button className="sal-link sal-zero" onClick={(e) => openPop("commission", m, e)}>{salFmt(0)}<I.Info className="i" size={13} /></button>}
                      {m.commissionFlagged && m.commissionFlagged.length > 0 && (
                        <button title="Có phiếu hoa hồng đã thanh toán — bấm để kiểm tra"
                          onClick={(e) => openPop("commission", m, e)}
                          style={{ border: "none", background: "hsl(var(--status-danger-bg))", color: "hsl(var(--status-danger-fg))", width: 18, height: 18, borderRadius: 5, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, lineHeight: 1 }}>!</button>
                      )}
                    </span>
                  </td>
                  <td><span className="sal-num" style={{ fontWeight: 700 }}>{salFmt(c.gross)}</span></td>
                  <td>{m.advance > 0
                    ? <ClickNum value={m.advance} onClick={(e) => openPop("advance", m, e)} neg prefix="−" />
                    : <span className="sal-num sal-zero">0₫</span>}</td>
                  <td>{m.roomRent > 0
                    ? <ClickNum value={m.roomRent} onClick={(e) => openPop("room", m, e)} neg prefix="−" />
                    : <span className="sal-num sal-zero">0₫</span>}</td>
                  <td>
                    <div className="sal-rowgoal">
                      <span className="sal-takehome">{salFmt(c.takehome)}</span>
                      {m.incomeGoal > 0 && <>
                        <span className={"sal-rowbar" + (pct >= 100 ? " over" : "")}><span style={{ width: Math.min(pct, 100) + "%" }} /></span>
                        <span className="sal-rowgoalcap">{pct >= 100 ? "Vượt mục tiêu " : "Đạt "}{pct}% · mục tiêu {salShort(m.incomeGoal)}</span>
                      </>}
                    </div>
                  </td>
                  <td className="c">
                    {paidState ? <span className="sal-statebadge sal-statebadge--paid"><I.Check size={12} />Đã trả</span>
                      : rowLocked ? <span className="sal-statebadge sal-statebadge--locked"><I.Lock size={11} />Đã chốt</span>
                        : <span className="sal-statebadge sal-statebadge--draft"><span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />Nháp</span>}
                  </td>
                  <td className="c"><button className="sal-btn sal-btn--ghost sal-btn--icon sal-btn--sm" aria-label={"Tác vụ cho " + m.short} onClick={(e) => setMenu({ m, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}><I.MoreVertical size={16} /></button></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="lbl">Tổng cộng</td>
              <td></td>
              <td><span className="sal-num">{salFmt(totals.base)}</span></td>
              <td><span className="sal-num">{salFmt(totals.bonus)}</span></td>
              <td><span className="sal-num">{salFmt(totals.inv)}</span></td>
              <td><span className="sal-num">{salFmt(totals.com)}</span></td>
              <td><span className="sal-num" style={{ fontWeight: 800 }}>{salFmt(totals.gross)}</span></td>
              <td><span className="sal-num sal-neg">{totals.adv ? "−" + salFmt(totals.adv) : "0₫"}</span></td>
              <td><span className="sal-num sal-neg">{totals.room ? "−" + salFmt(totals.room) : "0₫"}</span></td>
              <td><span className="sal-takehome" style={{ fontSize: 16 }}>{salFmt(totals.take)}</span></td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>
      </div>

      {/* ===== LEADERBOARD + COST SPLIT ===== */}
      <div className="sal-insights">
        <div className="sal-card">
          <div className="sal-panel-head">
            <span className="pi" style={{ background: "hsl(var(--status-warning) / .12)", color: "hsl(var(--status-warning-fg))" }}><I.Trophy size={17} /></span>
            <div><h3>Bảng xếp hạng hiệu suất</h3><p>Theo % vượt mục tiêu tháng</p></div>
          </div>
          {ranked.map((m, i) => {
            const pct = pctOf(m);
            const ok = pct >= 100;
            const col = m.incomeGoal > 0 ? (ok ? "hsl(var(--primary))" : "hsl(var(--status-danger-fg))") : "hsl(var(--muted-foreground))";
            return (
              <div className="sal-lead-row" key={m.id}>
                <span className={"sal-lead-rank" + (i < 3 ? "" : " num")}>{i < 3 ? medals[i] : i + 1}</span>
                <span className="sal-ava" style={{ width: 32, height: 32, fontSize: 12, background: m.tone === "primary" ? "hsl(var(--primary))" : "hsl(var(--status-info))" }}>{m.initials}</span>
                <div className="lnm"><b>{m.short}</b><small>{m.incomeGoal > 0 ? `Mục tiêu ${salShort(m.incomeGoal)}` : "Chưa đặt mục tiêu"}</small></div>
                <span className="sal-lead-bar"><span style={{ width: Math.min(pct, 100) + "%", background: m.incomeGoal > 0 ? (ok ? "hsl(var(--primary))" : "hsl(var(--status-danger))") : "transparent" }} /></span>
                <span className="sal-lead-pct" style={{ color: col }}>{m.incomeGoal > 0 ? `${pct}%` : "—"}</span>
              </div>
            );
          })}
        </div>

        <div className="sal-card">
          <div className="sal-panel-head">
            <span className="pi" style={{ background: "hsl(var(--primary) / .1)", color: "hsl(var(--primary))" }}><I.PiggyBank size={17} /></span>
            <div><h3>Cấu phần quỹ lương</h3><p>Trước khấu trừ · {salShort(totals.gross)}</p></div>
          </div>
          <div className="sal-split-body">
            {splitComps.map((c, i) => (
              <div className="sal-split-row" key={i}>
                <span className="sk">{c.label}</span>
                <span className="sal-split-bar"><span style={{ width: (c.val / splitMax) * 100 + "%", background: c.color }} /></span>
                <span className="sal-split-v" style={{ color: c.color }}>{salShort(c.val)}</span>
              </div>
            ))}
          </div>
          <div className="sal-split-foot">
            {totals.adv > 0 && <div className="sal-split-ded"><span>− Ứng lương</span><span className="sal-num">{salFmt(totals.adv)}</span></div>}
            {totals.room > 0 && <div className="sal-split-ded"><span>− Tiền phòng</span><span className="sal-num">{salFmt(totals.room)}</span></div>}
            <div className="sal-split-net"><span className="nl">Thực chi</span><span className="nv">{salFmt(totals.take)}</span></div>
          </div>
        </div>
      </div>

      {/* Popovers */}
      {pop && (
        <Popover rect={pop.rect} width={pop.type === "bonus" ? 360 : 340} onClose={() => setPop(null)}>
          {pop.type === "bonus" && <BonusPop m={pop.m} periodText={periodText} locked={pop.m.status === "LOCKED"} onClose={() => setPop(null)} onOpenLedger={onOpenLedger}
            onAdjust={(adj) => { setPop(null); setDialog({ type: "adjust", m: pop.m, edit: adj }); }}
            onRemove={(id) => onRemoveAdjustment(id)} />}
          {pop.type === "investment" && <InvestmentPop m={pop.m} periodText={periodText} />}
          {pop.type === "commission" && <CommissionPop m={pop.m} />}
          {pop.type === "advance" && <AdvancePop m={pop.m} periodText={periodText} />}
          {pop.type === "room" && <RoomRentPop m={pop.m} periodText={periodText} />}
        </Popover>
      )}

      {/* Row menu */}
      {menu && <Menu rect={menu.rect} onClose={() => setMenu(null)} items={[
        { icon: "Eye", label: "Xem bảng kê của " + menu.m.short, onClick: () => onOpenLedger({ who: menu.m.id }) },
        { icon: "Gift", label: "Thêm thưởng / trừ", disabled: menu.m.status === "LOCKED", onClick: () => setDialog({ type: "adjust", m: menu.m }) },
        ...(canPay ? [{ icon: "Wallet", label: "Trả lương", onClick: () => setDialog({ type: "payout", m: menu.m }) }] : []),
        ...(canLock ? [{ sep: true } as any, (menu.m.status === "LOCKED")
          ? { icon: "Unlock", label: "Mở khoá tháng", onClick: () => setShowLock(true) }
          : { icon: "Lock", label: "Chốt tháng", onClick: () => setShowLock(true) }] : []),
      ]} />}

      {/* Export menu */}
      {exporting && <Menu rect={exporting.rect} onClose={() => setExporting(null)} items={[
        { icon: "Download", label: "In / Xuất PDF", onClick: () => window.print() },
      ]} />}

      {/* Dialogs */}
      {dialog?.type === "adjust" && <AdjustDialog m={dialog.m} edit={dialog.edit} onClose={() => setDialog(null)}
        onSave={(p) => onSaveAdjustment(dialog.m.id, p)} />}
      {dialog?.type === "payout" && <PayoutDialog m={dialog.m} accounts={accounts} period={period} onClose={() => setDialog(null)}
        onSave={(amt, acc, date, note) => onPayout(dialog.m.id, dialog.m.name, amt, acc, date, note)} />}
      {showBulk && <BulkPayoutDialog managers={managers} accounts={accounts} period={period} onClose={() => setShowBulk(false)} onSave={onBulkPayout} />}
      {showLock && <LockDialog locked={locked} period={period} onClose={() => setShowLock(false)} onConfirm={() => locked ? onUnlock() : onLock()} />}
      {chartModal && <SalChartModal managers={managers} onClose={() => setChartModal(false)} />}
    </div>
  );
}
