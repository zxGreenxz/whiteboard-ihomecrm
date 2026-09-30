import { useSalaryFormFeedback } from "./useSalaryFormFeedback";
// Tab "Thu nhập & thanh toán" — gộp Thu nhập theo người + Thanh toán (bản Claude
// Design 26/09/2026). Trái: người nhận · Giữa: khoản theo 3 nhóm nguồn · Phải: khung
// thanh toán. Ghi tiền đi qua onPayout (salary_payout_v1, phiếu chờ duyệt).
// Super admin / chủ công ty sửa được số tiền từng khoản thu nhập (onEditAmount →
// salary_line_override_set_v1); số đã sửa đã áp sẵn trong SalManager (useManagerSalary).
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { todayISO } from "@/lib/collect";
import { fundLinesOf, isSupplementaryLabel } from "@/lib/salaryFundReport";
import type { SalAdjustment, SalAppliedOverride, SalManager } from "@/lib/managerSalary";
import { RECURRING_CATEGORY_LABEL, RECURRING_SOURCE_LABEL } from "@/lib/salaryRecurring";
import type { EditableLine } from "./SalaryAmountEditDialog";
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
  /** Khoá ghi đè số tiền (base, streak, job:…, rec:…, sale:…, dh:…) — không có thì không sửa được. */
  key?: string;
  /** Số máy tính (trước sửa tay). */
  computed?: number;
  ovr?: SalAppliedOverride | null;
  /** Hoa hồng ở sổ thật: phần đã/sẽ chi từ sổ đó — luôn đi kèm, trừ khỏi tiền chuyển. */
  paidElsewhere?: number;
  /** Phiếu HH chờ duyệt ở sổ thật — có thể gán quản lý để chuyển sang trả qua lương. */
  assignVoucherId?: string;
  assignVersion?: number;
}

// Dòng đã sửa tay: chip, dòng mô tả và các bước căn cứ hiện số máy tính + lý do.
function withOverride(it: Item, ovr: SalAppliedOverride | undefined): Item {
  if (!ovr) return { ...it, ovr: null, computed: it.amount ?? 0 };
  return {
    ...it,
    ovr,
    computed: ovr.computed,
    chip: { t: "Sửa tay", tone: "tasks" },
    why: `Máy tính ${salFmt(ovr.computed)} · ${ovr.reason}`,
    trace: [
      ...it.trace,
      ["Số máy tính", salFmt(ovr.computed)],
      ["Số đã sửa tay", `${salFmt(ovr.amount)} · ${ovr.reason}`],
      ["Người sửa", `${ovr.byName || "—"} · ${new Date(ovr.at).toLocaleString("vi-VN")}`],
    ],
  };
}

function itemsOf(m: SalManager): Item[] {
  const locked = m.status === "LOCKED";
  const out: Item[] = [];
  for (const l of fundLinesOf(m)) {
    // Khoản nhập tay đi riêng bên dưới để giữ id (sửa/xoá được); ở đây chỉ còn
    // dòng lệch theo số đã chốt của nhóm này.
    if (l.group === "extra" && l.key !== "extra-locked") continue;
    const isAdj = l.group === "extra";
    const key = l.key === "base" || (l.group === "work" && l.key !== "work-locked") ? l.key : undefined;
    out.push(withOverride({
      id: "vh:" + l.key, g: "vh", label: l.label, why: l.note || "", amount: l.amount, payable: true, key,
      chip: locked ? { t: "Đã chốt", tone: "success" } : isAdj ? { t: "Nhập tay", tone: "neutral" } : { t: "Tạm tính", tone: "warning" },
      trace: [
        ["Căn cứ", l.note || l.label],
        [l.group === "base" ? "Bằng chứng" : isAdj ? "Cách phát sinh" : "Bằng chứng",
          l.group === "base" ? `${m.workdays} ngày công · bảng kê công việc` : isAdj ? "Thưởng/Trừ nhập tay trong bảng lương" : `${m.stats.jobs} việc trong bảng kê · ${m.stats.repairs} việc sửa chữa`],
        ["Trạng thái kỳ", locked ? "Đã chốt — dùng số đóng băng" : "Chưa chốt — số có thể đổi đến khi chốt"],
        ["Nguồn chịu tiền", GROUP.vh.src],
      ],
    }, key ? m.overrides?.[key] : undefined));
  }
  m.adjustments.filter((a) => a.recurring).forEach((a) => {
    const r = a.recurring!;
    const key = a.id as string;
    out.push(withOverride({
      id: key, g: "vh", label: a.label, amount: a.amount, payable: true, key,
      why: `${RECURRING_CATEGORY_LABEL[r.category]} định kỳ` + (a.note ? " · " + a.note : ""),
      chip: locked ? { t: "Đã chốt", tone: "success" } : { t: "Định kỳ", tone: "info" },
      trace: [
        ["Cách phát sinh", "Khoản định kỳ — tự áp mỗi kỳ theo phiên bản đang hiệu lực"],
        ["Loại", RECURRING_CATEGORY_LABEL[r.category] + (r.buildingName ? ` · ${r.buildingName}` : "")],
        ["Nguồn chịu tiền", RECURRING_SOURCE_LABEL[r.category] + (r.category === "SUPPLEMENTARY" ? " — không ghi vào thu chi của toà" : "")],
        ["Đổi mức / ngừng", "Nguồn lương & khoản định kỳ → Khoản định kỳ"],
      ],
    }, m.overrides?.[key]));
  });
  m.adjustments.filter((a) => !a.recurring).forEach((a, i) => out.push({
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
  // Hoa hồng (migration 20260927155251, phương án A): phiếu ở sổ ảo "Hoa hồng QL chờ trả
  // lương" trả qua lương; phiếu ở sổ thật là thu nhập nhưng tiền đã/sẽ ra từ sổ đó, nên
  // luôn đi kèm (không bỏ chọn được) và bị trừ lại ở khung thanh toán.
  m.commissionItems.forEach((c, i) => {
    const key = c.voucherId ? "sale:" + c.voucherId : undefined;
    const fromBook = (c.paidElsewhere || 0) > 0;
    const book = c.paidFrom || "sổ quỹ khác";
    const status = c.approved ? "Đã duyệt (đã tính chi phí tòa)" : "Chờ duyệt — tự duyệt khi chốt lương";
    const chip: Item["chip"] = locked
      ? { t: "Đã chốt", tone: "success" }
      : !fromBook ? { t: "Trả qua lương", tone: "success" }
      : c.approved ? { t: "Đã chi từ sổ", tone: "neutral" }
      : { t: "Chưa gán QL", tone: "warning" };
    const why = !fromBook
      ? (locked ? "Đã chốt cùng bảng lương" : c.approved ? "Đã duyệt · trả qua lương" : "Chờ duyệt · tự duyệt khi chốt, trả qua lương")
      : c.approved ? `Đã chi từ sổ ${book} — tính thu nhập, không chuyển lại`
      : `Khi duyệt sẽ chi từ sổ ${book} — bấm để chuyển sang trả qua lương`;
    out.push(withOverride({
      id: "sale:" + (c.voucherId || i), g: "sale", label: c.label, amount: c.amount, payable: true, key, why, chip,
      paidElsewhere: fromBook ? c.paidElsewhere : 0,
      assignVoucherId: fromBook && !c.approved && !locked ? c.voucherId : undefined,
      assignVersion: c.version,
      trace: [
        ["Phiếu Sale nguồn", c.label],
        ["Quản lý nhận", c.assigned ? "Chọn ở ô QL của phiếu" : "Khớp tên người nhận trên phiếu"],
        ["Trạng thái phiếu", status],
        ["Sổ giữ tiền", fromBook ? `${book} (sổ thật) — tiền ra từ sổ này, lương không chuyển lại` : "Hoa hồng QL chờ trả lương (sổ ảo) — tiền trả qua lương"],
        ["Chi phí tòa", "Ghi một lần tại phiếu Sale nguồn — trả qua lương không ghi thêm"],
        ["Nguồn chịu tiền", GROUP.sale.src],
      ],
    }, key ? m.overrides?.[key] : undefined));
  });
  m.commissionFlagged.forEach((c, i) => {
    const inc = c.includedElsewhere;
    const ky = inc ? inc.period.slice(5, 7) + "/" + inc.period.slice(0, 4) : "này";
    // Dấu khoá theo (phiếu, kỳ) và meta chỉ trả dấu của kỳ đang xem ⇒ ở đây luôn là
    // "đã tính cho NGƯỜI KHÁC trong kỳ này".
    out.push({
      id: "sale-paid:" + (c.voucherId || i), g: "sale", label: c.label, amount: c.amount, payable: false, strike: true,
      why: `Đã tính vào lương kỳ ${ky} của người khác — không cộng lại`,
      chip: { t: "Đã tính cho người khác", tone: "neutral" },
      trace: [
        ["Phiếu Sale nguồn", c.label],
        ["Dấu chốt lương", `Đã tính vào lương kỳ ${ky} của một quản lý khác`],
        ["Kết quả", "Không cộng vào thu nhập người này — mỗi phần hoa hồng chỉ vào lương một người"],
        ["Cần làm", "Nếu sai người: mở chốt lương người kia kỳ này rồi chốt lại"],
      ],
    });
  });
  if (!m.investmentLocked) {
    out.push({
      id: "dh:pending", g: "dh", label: "Lợi nhuận kỳ chưa chốt", amount: null, payable: false,
      why: "Chưa đủ cơ sở xác nhận — không phải bằng 0", chip: { t: "Lợi nhuận chưa chốt", tone: "warning" },
      trace: [["Trạng thái", "Lợi nhuận tòa chưa chốt"], ["Nguồn chịu tiền", GROUP.dh.src]],
    });
  } else {
    m.investmentBy.forEach((a, i) => {
      const key = "dh:" + a.b;
      out.push(withOverride({
        id: "dh:" + a.b + i, g: "dh", label: `${a.b} · lợi nhuận kỳ`, amount: a.amount, payable: a.amount !== 0, key,
        why: a.amount > 0 ? "Đã chốt · phân bổ theo thỏa thuận hiện hành" : "Đã chốt · phần phân bổ bằng 0",
        chip: a.amount > 0 ? { t: "Đã xác nhận", tone: "success" } : { t: "Đã chốt · bằng 0", tone: "neutral" },
        trace: [["Tòa", a.b], ["Lợi nhuận tòa", "Đã chốt"], ["Thỏa thuận", "Tỷ lệ đọc từ thỏa thuận tòa"], ["Nguồn chịu tiền", GROUP.dh.src]],
      }, m.overrides?.[key]));
    });
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
  onPayout: (staffId: string, staffName: string, amount: number, accountId: string, voucherDate: string, note: string) => Promise<unknown> | void;
  /** Mutation trả lương đang chạy — khoá nút để không lập phiếu hai lần. */
  payBusy: boolean;
  onOpenLedger: (f: { who: string }) => void;
  onAdjust: (m: SalManager, edit?: SalAdjustment | null) => void;
  onRemoveAdjustment: (adjId: string) => void;
  /** Super admin / chủ công ty của tổ chức (server quyết qua salary_can_edit_amounts_v1). */
  canEditAmounts: boolean;
  onEditAmount: (m: SalManager, line: EditableLine) => void;
  /**
   * Gán phiếu hoa hồng (chờ duyệt, ở sổ thật) cho chính người này → chuyển sang sổ ảo
   * "Hoa hồng QL chờ trả lương", tiền trả qua lương (assign_commission_manager_v1).
   * Không truyền = không hiện nút. Server tự kiểm quyền sửa phiếu.
   */
  onAssignCommission?: (m: SalManager, voucherId: string, expectedVersion?: number) => void;
  assignBusy?: boolean;
}

const card: CSSProperties = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, boxShadow: "var(--shadow-sm)" };

export default function SalaryIncomePay(props: Props) {
  const { managers, period, pending, onSelect } = props;
  const m = managers.find((x) => x.id === props.selectedId) || managers[0];
  const [trace, setTrace] = useState<Item | null>(null);
  // Người vừa lập phiếu trong phiên: khoá cho tới khi danh sách phiếu chờ duyệt
  // tải lại (paid chỉ tăng khi duyệt nên số tiền không tự giảm sau khi lập).
  const [justPaid, setJustPaid] = useState<Set<string>>(new Set());
  const pendingKey = pending.map((q) => q.voucherId).sort().join(",");
  useEffect(() => { setJustPaid(new Set()); }, [pendingKey]);
  if (!m) return null;
  const pendingOf = (id: string) => pending.filter((p) => p.staffId === id);
  const editOf = (i: Item): (() => void) | undefined =>
    props.canEditAmounts && m.status !== "LOCKED" && i.key && i.amount != null
      ? () => props.onEditAmount(m, { key: i.key as string, label: i.label, computed: i.computed ?? i.amount ?? 0, current: i.amount ?? 0, ovr: i.ovr ?? null })
      : undefined;

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

      <PersonDetail key={m.id} m={m} {...props} pendingList={pendingOf(m.id)} onTrace={setTrace} editOf={editOf}
        justPaid={justPaid.has(m.id)}
        onPayout={async (...a) => { const result = await props.onPayout(...a); setJustPaid((s) => new Set(s).add(a[0])); return result; }} />

      {trace && <TraceDrawer item={trace} who={m.name} period={`${period.label}/${period.year}`} onClose={() => setTrace(null)}
        onOpenLedger={trace.g === "vh" && !trace.adj && !trace.id.startsWith("rec:") ? () => { setTrace(null); props.onOpenLedger({ who: m.id }); } : undefined}
        onEdit={trace.adj && m.status !== "LOCKED" ? () => { const a = trace.adj; setTrace(null); props.onAdjust(m, a); } : undefined}
        onRemove={trace.adj?.id && m.status !== "LOCKED" ? () => { const id = trace.adj!.id!; setTrace(null); props.onRemoveAdjustment(id); } : undefined}
        onEditAmount={(() => { const f = editOf(trace); return f ? () => { setTrace(null); f(); } : undefined; })()}
        onAssign={trace.assignVoucherId && props.onAssignCommission
          ? () => { const vid = trace.assignVoucherId!; const ver = trace.assignVersion; setTrace(null); props.onAssignCommission!(m, vid, ver); }
          : undefined}
        assignLabel={`Chuyển sang trả qua lương (gán ${m.short})`} assignBusy={!!props.assignBusy} />}
    </div>
  );
}

function PersonDetail({ m, period, accounts, canPay, onPayout, payBusy, justPaid, onAdjust, pendingList, onTrace, editOf }: Props & {
  m: SalManager; pendingList: PendingPayout[]; onTrace: (i: Item) => void; justPaid: boolean;
  editOf: (i: Item) => (() => void) | undefined;
}) {
  const feedback = useSalaryFormFeedback("lập phiếu chi lương");
  const items = useMemo(() => itemsOf(m), [m]);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [acc, setAcc] = useState(accounts[0]?.id || "");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState(`Lương ${period.label}/${period.year}`);
  const hasPending = pendingList.length > 0 || justPaid;
  // Kỳ đã chốt: trả đúng số đóng băng — khoản HH/ứng/đầu tư live có thể trôi sau khi
  // chốt (phiếu HH duyệt ở nơi khác, ứng huỷ…), nên không cho chọn từng khoản.
  const fz = m.status === "LOCKED" ? m.frozen ?? null : null;
  const lockedPay = m.status === "LOCKED";
  const blocked = hasPending || !canPay || payBusy;
  // Khoản âm và hoa hồng đã chi từ sổ thật luôn đi kèm (bỏ chọn cái sau không đổi tiền
  // chuyển, chỉ làm lệch thu nhập); trạng thái bỏ chọn cũ không áp cho khoản đã thành âm.
  const forced = (i: Item) => (i.amount ?? 0) < 0 || (i.paidElsewhere ?? 0) > 0;
  const chosen = items.filter((i) => i.payable && (lockedPay || forced(i) || !off[i.id]));
  const bySrc = (g: GroupKey) => chosen.filter((i) => i.g === g).reduce((s, i) => s + (i.amount ?? 0), 0);
  const vS = fz && m.calc ? m.calc.gross - fz.investment - fz.commission : bySrc("vh");
  const sS = fz ? fz.commission : bySrc("sale");
  const dS = fz ? fz.investment : bySrc("dh");
  const totalOb = vS + sS + dS;
  const advance = fz ? fz.advance : m.advance;
  // Hoa hồng đã/sẽ chi từ sổ thật. Kỳ chốt: suy từ số đóng băng (gross − ứng − phòng −
  // thực nhận) để các dòng luôn cộng khớp, kể cả kỳ chốt trước khi có tách này (= 0).
  const paidOut = lockedPay && m.calc
    ? Math.max(0, m.calc.gross - advance - m.roomRent - m.calc.takehome)
    : chosen.reduce((s, i) => s + (i.paidElsewhere ?? 0), 0);
  // Chọn đủ mọi khoản ⇒ tiền chuyển = thực nhận − đã trả, đúng số của bảng lương cũ.
  const cash = lockedPay && m.calc
    ? Math.max(0, m.calc.takehome - m.paid)
    : Math.max(0, totalOb - advance - m.roomRent - paidOut - m.paid);

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
              const ok = i.payable && !blocked && !lockedPay && !forced(i); // khoản trừ / HH đã chi từ sổ luôn đi kèm
              return (
                <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid hsl(var(--border) / .45)", opacity: i.payable ? 1 : .7, flexWrap: "wrap" }}>
                  <input type="checkbox" aria-label={"Đưa vào thanh toán: " + i.label} checked={i.payable && (lockedPay || forced(i) || !off[i.id])} disabled={!ok}
                    onChange={() => setOff((s) => ({ ...s, [i.id]: !s[i.id] }))} style={{ accentColor: "hsl(var(--primary))", width: 16, height: 16, margin: 0 }} />
                  <button onClick={() => onTrace(i)} style={{ flex: 1, minWidth: 180, border: 0, background: "transparent", padding: 0, textAlign: "left", cursor: "pointer" }}>
                    <b style={{ display: "block", fontSize: 12.5, fontWeight: 600 }}>{i.label}</b><span style={{ fontSize: 11, color: MUTED }}>{i.why}</span>
                  </button>
                  <StChip tone={i.chip.tone}>{i.chip.t}</StChip>
                  <span style={{ ...MONO, minWidth: 100, textAlign: "right", fontWeight: 600, textDecoration: i.strike ? "line-through" : "none", color: i.amount == null ? "hsl(var(--status-warning-fg))" : (i.amount < 0 ? "hsl(var(--status-danger-fg))" : undefined) }}>{i.amount == null ? "Chưa đủ cơ sở" : salFmt(i.amount)}</span>
                  {(() => {
                    const edit = editOf(i);
                    return edit ? (
                      <button className="sal-btn sal-btn--ghost sal-btn--icon sal-btn--sm" aria-label={"Sửa số tiền: " + i.label} title="Sửa số tiền" onClick={edit}>✎</button>
                    ) : null;
                  })()}
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

    <div ref={feedback.root} style={{ ...card, boxShadow: "var(--shadow-md)", position: "sticky", top: 16, flex: "1 1 300px", maxWidth: 380, minWidth: 280 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid hsl(var(--border))" }}><b style={{ fontSize: 14 }}>Thanh toán cho {m.short}</b><div style={{ fontSize: 11.5, color: MUTED }}>Kỳ {period.label}/{period.year}</div></div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <Row k="Quỹ lương vận hành" v={salFmt(vS)} dot={GROUP.vh.color} />
          <Row k="Chi phí tòa · khoản Sale nguồn" v={salFmt(sS)} dot={GROUP.sale.color} />
          <Row k="Phân bổ lợi nhuận" v={salFmt(dS)} dot={GROUP.dh.color} />
          <Row k={lockedPay ? "Tổng thu nhập đã chốt" : "Tổng thu nhập được chọn"} v={salFmt(totalOb)} strong />
          {advance > 0 && <Row k="Đã ứng (trừ lúc ứng)" v={"−" + salFmt(advance)} fg="hsl(var(--status-danger-fg))" />}
          {paidOut > 0 && <Row k="Hoa hồng chi từ sổ thật (không chuyển lại)" v={"−" + salFmt(paidOut)} fg="hsl(var(--status-danger-fg))" />}
          {m.paid > 0 && <Row k="Đã trả trước đó" v={"−" + salFmt(m.paid)} fg="hsl(var(--status-danger-fg))" />}
        </div>
        {m.roomRent > 0 && (
          <div style={{ fontSize: 12, background: "hsl(var(--muted) / .5)", border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "10px 12px" }}>
            <b>Trừ tiền phòng {salFmt(m.roomRent)}</b><br />
            <span style={{ color: MUTED }}>{m.roomRentInvoice ? "Trừ thẳng vào hóa đơn phòng, không chuyển khoản phần này." : "Chưa có hóa đơn phòng tháng kế — trừ theo mức cố định trong cấu hình."}</span>
          </div>
        )}
        <div {...feedback.field("amount")} tabIndex={-1} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: "2px solid hsl(var(--border))", paddingTop: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "hsl(var(--primary))" }}>Tiền thực chuyển</span>
          <span style={{ ...MONO, fontWeight: 800, fontSize: 18, color: "hsl(var(--primary))" }}>{salFmt(cash)}</span>
        </div>
        <div className="sal-field"><label>Chi từ sổ</label>
          <select className="sal-select" style={{ height: 40 }} {...feedback.field("account")} value={acc} onChange={(e) => setAcc(e.target.value)} disabled={blocked}>
            {accounts.length === 0 ? <option value="">— Chưa có sổ quỹ —</option> : accounts.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>{feedback.issue("account")}</div>
        <div className="sal-field"><label>Ngày chi</label>
          <input type="date" className="sal-input mono" {...feedback.field("date")} value={date} onChange={(e) => setDate(e.target.value)} disabled={blocked} />{feedback.issue("date")}</div>
        <div className="sal-field"><label>Ghi chú</label>
          <input className="sal-input" value={note} onChange={(e) => setNote(e.target.value)} disabled={blocked} /></div>
        <button className="sal-btn sal-btn--primary" style={{ justifyContent: "center" }}
          disabled={blocked || feedback.saving || feedback.blocked}
          onClick={() => void feedback.run(() => onPayout(m.id, m.name, cash, acc, date, note), () => {}, {amount: cash <= 0 ? "Không còn tiền phải chuyển." : undefined, account: !acc ? "Chọn sổ quỹ chi lương." : undefined, date: !date ? "Chọn ngày chi lương." : undefined})}>
          {!canPay ? "Không có quyền trả lương" : payBusy ? "Đang lập phiếu…" : hasPending ? "Đang có phiếu chờ duyệt" : cash <= 0 ? "Không còn tiền phải chuyển" : "Lập yêu cầu thanh toán"}
        </button>{feedback.notice}{feedback.issue("amount")}
        {lockedPay && <span style={{ fontSize: 11.5, color: "hsl(var(--status-warning-fg))" }}>Kỳ đã chốt — trả theo số đã chốt, không chọn từng khoản.</span>}
        <span style={{ fontSize: 11.5, color: MUTED }}>Tạo một phiếu chi lương chờ duyệt (không tính KQKD). Khi đã có phiếu chờ duyệt, người này bị khóa để không lập trùng. Bấm tên khoản để xem căn cứ.</span>
      </div>
    </div>
  </>;
}

function TraceDrawer({ item, who, period, onClose, onOpenLedger, onEdit, onRemove, onEditAmount, onAssign, assignLabel, assignBusy }: {
  item: Item; who: string; period: string; onClose: () => void; onOpenLedger?: () => void; onEdit?: () => void; onRemove?: () => void;
  onEditAmount?: () => void; onAssign?: () => void; assignLabel?: string; assignBusy?: boolean;
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
        {onAssign && (
          <>
            <button className="sal-btn sal-btn--primary" disabled={assignBusy} onClick={onAssign}>{assignBusy ? "Đang chuyển…" : assignLabel}</button>
            <span style={{ fontSize: 11.5, color: MUTED }}>Phiếu chuyển sang sổ ảo "Hoa hồng QL chờ trả lương": duyệt vẫn tính chi phí tòa nhưng không ra tiền sổ thật; tiền trả qua lương.</span>
          </>
        )}
        {onEditAmount && <button className="sal-btn sal-btn--outline" onClick={onEditAmount}>{item.ovr ? "Sửa lại số tiền / bỏ sửa tay" : "Sửa số tiền"}</button>}
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
