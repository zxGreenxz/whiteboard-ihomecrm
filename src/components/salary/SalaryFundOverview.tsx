// Tab "Tổng quan kỳ" — 5 ô số + báo cáo "Tiền lương được chia thế nào?".
// Theo bản Claude Design "Quản trị lương và thu nhập" (26/09/2026). Chỉ đọc số;
// không đổi công thức lương. Nguồn lương = phí Quản lý đã công bố giá của các tòa.
import { useMemo, useState, type CSSProperties } from "react";
import type { SalManager } from "@/lib/managerSalary";
import {
  FUND_GROUPS, SUPPLEMENTARY_COLOR, fmtMillion, fundLinesOf, fundPeopleOf, groupTotals, mergeLines, per100,
  supplementaryTotal, type FundGroupKey, type FundLine,
} from "@/lib/salaryFundReport";
import type { PendingPayout } from "@/hooks/useSalaryFund";
import { salFmt } from "./salaryFormat";
import { LoadingState, SkeletonBar } from "@/components/loading/LoadingState";
import { MONO, MUTED, PanelHead, Seg, StChip, Switch, monthShort, type ChipTone } from "./salaryFundUi";

export interface FundPeriod {
  periodMonth: string;
  locked: boolean;
  managers: SalManager[];
  /** Tổng phí Quản lý đã công bố giá cho tháng. */
  fee: number;
  /** Chủ công ty cấp thêm (khoản định kỳ Lương QL bổ sung gắn toà) của kỳ. */
  owner?: number;
  loading: boolean;
}

interface Props {
  periods: FundPeriod[]; // cũ → mới; phần tử cuối là kỳ đang xem
  feeBuildings: number;
  feeUnpublished: number;
  pending: PendingPayout[];
  onOpenFund: (tab: "funding" | "rules") => void;
  onOpenPerson: (staffId: string) => void;
}

const LINE_COLORS: Record<string, string> = {
  base: "#3d4a57", streak: "#e0a526", ot: "#d0663a", contract: "#6334b7",
  "work-locked": "#9fcfb6", supplementary: SUPPLEMENTARY_COLOR, deduction: "#c32222", "extra-locked": "#b8c2cc",
};
const JOB_SHADES = ["#188552", "#2f9e8f", "#4caf7d", "#127046", "#7cc4a0"];
function lineColor(l: FundLine, idx: number): string {
  if (LINE_COLORS[l.key]) return LINE_COLORS[l.key];
  if (l.key.startsWith("job:")) return JOB_SHADES[idx % JOB_SHADES.length];
  return "#1561c1";
}

const pctTxt = (x: number) => (x * 100).toFixed(1).replace(".", ",") + "%";
const mNum = (n: number) => fmtMillion(n).replace("tr", "");

interface Exc { tag: string; tone: ChipTone; title: string; sub: string; cta: string; onClick: () => void; }

export default function SalaryFundOverview({ periods, feeBuildings, feeUnpublished, pending, onOpenFund, onOpenPerson }: Props) {
  const [sep, setSep] = useState(false);
  const [cmpIdx, setCmpIdx] = useState(periods.length - 1);
  const [excOpen, setExcOpen] = useState(false);
  const cur = periods[periods.length - 1];
  const sel = periods[Math.min(cmpIdx, periods.length - 1)];
  // Nguồn lương = phí Quản lý + chủ cấp thêm. Tách lương bổ sung riêng ⇒ lương căn bản
  // so với phí Quản lý thôi (phần bổ sung do chủ cấp, đứng ngoài phép so).
  const fundOf = (p: FundPeriod) => (sep ? p.fee : p.fee + (p.owner ?? 0));

  // ---- 5 ô số (kỳ đang xem) ----
  const mgrs = cur.managers;
  const people = useMemo(() => fundPeopleOf(mgrs), [mgrs]);
  const opTotal = people.reduce((s, p) => s + p.total, 0);
  const paid = mgrs.reduce((s, m) => s + m.paid, 0);
  const adv = mgrs.reduce((s, m) => s + m.advance, 0);
  const pendingBy = new Map<string, number>();
  for (const p of pending) pendingBy.set(p.staffId, (pendingBy.get(p.staffId) || 0) + p.amount);
  const pendingSum = pending.reduce((s, p) => s + p.amount, 0);
  const remain = mgrs.reduce((s, m) => {
    const left = Math.max(0, (m.calc?.takehome ?? 0) - m.paid);
    return s + Math.max(0, left - (pendingBy.get(m.id) || 0));
  }, 0);
  const cards = [
    { label: "Nguồn lương tháng", val: salFmt(cur.fee + (cur.owner ?? 0)), bar: "#9fcfb6", fg: undefined,
      sub: `Phí quản lý ${feeBuildings} tòa` + (cur.owner ? ` + chủ cấp ${salFmt(cur.owner)}` : " · chi ngày 1 hàng tháng") + (feeUnpublished ? ` · ${feeUnpublished} tòa chưa công bố giá` : ""), onClick: () => onOpenFund("funding") },
    { label: "Tổng lương vận hành", val: salFmt(opTotal), bar: "hsl(var(--foreground))", fg: undefined,
      sub: `${mgrs.length} người · ${cur.locked ? "đã chốt kỳ" : "tạm tính, chưa chốt kỳ"}`, onClick: () => mgrs[0] && onOpenPerson(mgrs[0].id) },
    { label: "Đã trả", val: salFmt(paid + adv), bar: "hsl(var(--status-neutral-strong))", fg: undefined,
      sub: `Phiếu chi đã duyệt ${salFmt(paid)}${adv ? " · ứng " + salFmt(adv) : ""}`, onClick: () => mgrs[0] && onOpenPerson(mgrs[0].id) },
    { label: "Đang chờ chi", val: salFmt(pendingSum), bar: "hsl(var(--status-info))", fg: "hsl(var(--status-info-fg))",
      sub: `${pending.length} phiếu chi chờ duyệt`, onClick: () => pending[0] && onOpenPerson(pending[0].staffId) },
    { label: "Còn phải trả", val: salFmt(remain), bar: "hsl(var(--primary))", fg: "hsl(var(--primary))",
      sub: "Thực nhận chưa lập phiếu · gồm Sale & đồng hành", onClick: () => mgrs[0] && onOpenPerson(mgrs[0].id) },
  ];

  // ---- Báo cáo cơ cấu ----
  const rep = useMemo(() => periods.map((p) => {
    const pp = fundPeopleOf(p.managers);
    const lines = mergeLines(pp, sep);
    const gt = groupTotals(lines);
    return { p, people: pp, lines, gt, total: lines.reduce((s, l) => s + l.amount, 0), supp: supplementaryTotal(pp) };
  }), [periods, sep]);
  const R = rep[Math.min(cmpIdx, rep.length - 1)];
  const prevR = cmpIdx > 0 ? rep[cmpIdx - 1] : null;
  const TR = R.total, FR = fundOf(sel);
  const fundLbl = sep ? "Phí quản lý" : "Nguồn lương";
  const groups = FUND_GROUPS.map((g) => ({ ...g, label: sep && g.key === "extra" ? "Phụ cấp" : g.label }));
  const gvals = groups.map((g) => R.gt[g.key]);
  const p100 = per100(gvals);
  const gmx = Math.max(TR, FR, 1);
  const over = TR - FR;
  const mLabel = "Tháng " + parseInt(sel.periodMonth.slice(5, 7), 10);
  const headA = FR > 0
    ? `${mLabel}${sep ? " lương căn bản " : " tổng lương "}${fmtMillion(TR)}, bằng ${Math.round((TR / FR) * 100)}% ${sep ? "phí quản lý " : "nguồn lương "}${fmtMillion(FR)} —`
    : `${mLabel}${sep ? " lương căn bản " : " tổng lương "}${fmtMillion(TR)} — chưa có nguồn lương để so sánh`;
  const headB = FR > 0 ? (over > 0 ? `vượt ${fmtMillion(over)}.` : `còn dư ${fmtMillion(-over)}.`) : "";
  const headColor = over > 0 ? "hsl(var(--status-danger-fg))" : "hsl(var(--status-success-fg))";

  const linesOf = (g: FundGroupKey) => R.lines.filter((l) => l.group === g).sort((a, b) => b.amount - a.amount);

  // Cột 3 tháng
  const CH = 150;
  const cMax = Math.max(1, ...rep.map((r) => Math.max(r.total, fundOf(r.p))));

  // Bảng thay đổi: nhóm → dòng (hợp key của cả 3 kỳ)
  const keyInfo = new Map<string, FundLine>();
  rep.forEach((r) => r.lines.forEach((l) => { if (!keyInfo.has(l.key)) keyInfo.set(l.key, l); }));
  const valOf = (r: (typeof rep)[number], key: string) => r.lines.find((l) => l.key === key)?.amount ?? 0;
  const selPrev = prevR ?? rep[Math.max(0, rep.length - 2)];
  const selCur = prevR ? R : rep[rep.length - 1];
  const dCell = (c: number, pv: number) => {
    if (Math.round((c - pv) / 1e5) === 0) return { d: "0", fg: MUTED };
    return { d: (c > pv ? "+" : "−") + mNum(Math.abs(c - pv)), fg: c > pv ? "hsl(var(--status-danger-fg))" : "hsl(var(--status-success-fg))" };
  };
  type ChgRow = { label: string; color: string; vals: number[]; bold: 0 | 1 | 2; indent: boolean; muteDelta?: boolean };
  const chg: ChgRow[] = [];
  groups.forEach((g) => {
    chg.push({ label: g.label, color: g.color, vals: rep.map((r) => r.gt[g.key]), bold: 1, indent: false });
    [...keyInfo.values()].filter((l) => l.group === g.key && !(sep && l.supplementary))
      .forEach((l) => chg.push({ label: l.label, color: lineColor(l, 0), vals: rep.map((r) => valOf(r, l.key)), bold: 0, indent: true }));
  });
  chg.push({ label: "Tổng lương", color: "hsl(var(--foreground))", vals: rep.map((r) => r.total), bold: 2, indent: false });
  chg.push({ label: fundLbl, color: "#9fcfb6", vals: rep.map((r) => fundOf(r.p)), bold: 1, indent: false, muteDelta: true });
  const iCur = rep.indexOf(selCur), iPrev = rep.indexOf(selPrev);

  // Mỗi người
  const pMax = Math.max(1, ...R.people.map((p) => p.lines.filter((l) => !(sep && l.supplementary)).reduce((s, l) => s + Math.max(0, l.amount), 0)));

  // ---- Cần xử lý trước khi chốt ----
  const exc: Exc[] = [];
  if (feeUnpublished) exc.push({ tag: "Chưa có giá", tone: "warning", title: `${feeUnpublished} tòa chưa công bố giá phí Quản lý`, sub: "Không cộng vào nguồn lương tháng cho tới khi chủ công bố giá", cta: "Nguồn lương", onClick: () => onOpenFund("funding") });
  for (const m of mgrs) {
    if (m.commissionFlagged?.length) exc.push({ tag: "Cần đối chiếu", tone: "danger", title: `${m.name} · ${m.commissionFlagged.length} phiếu HH đã tính vào lương người khác`, sub: "Không cộng lại — nếu sai người thì mở chốt lương người kia kỳ này rồi chốt lại", cta: "Thu nhập", onClick: () => onOpenPerson(m.id) });
    // Phiếu HH chờ duyệt còn ở sổ thật: duyệt sẽ ra tiền từ sổ đó, lương không trả lại.
    // Hoa hồng quản lý trả qua lương thì phải gán QL (chuyển sang sổ ảo) trước khi duyệt.
    const chuaGan = m.status !== "LOCKED" ? m.commissionItems.filter((c) => !c.approved && (c.paidElsewhere || 0) > 0) : [];
    if (chuaGan.length) exc.push({ tag: "Chưa gán QL", tone: "warning", title: `${m.name} · ${chuaGan.length} phiếu HH chờ duyệt còn ở sổ thật`, sub: "Duyệt sẽ chi từ sổ đó và lương không trả lại — muốn trả qua lương thì bấm khoản đó, chọn \"Chuyển sang trả qua lương\"", cta: "Thu nhập", onClick: () => onOpenPerson(m.id) });
    if (!m.investmentLocked) exc.push({ tag: "Chưa chốt", tone: "warning", title: `${m.name} · lợi nhuận kỳ chưa chốt`, sub: "Thu nhập đồng hành chưa đủ cơ sở — không phải bằng 0", cta: "Thu nhập", onClick: () => onOpenPerson(m.id) });
    if (m.status !== "LOCKED" && fundLinesOf(m).some((l) => l.supplementary && l.amount > 0)) exc.push({ tag: "Nhập tay", tone: "neutral", title: `${m.name} · lương QL bổ sung đang nhập tay trong Thưởng`, sub: "Khoản cố định hàng tháng — nên quản lý thành khoản định kỳ", cta: "Khoản định kỳ", onClick: () => onOpenFund("rules") });
  }
  for (const p of pending) {
    const m = mgrs.find((x) => x.id === p.staffId);
    exc.push({ tag: "Đang xử lý", tone: "info", title: `${m?.name ?? "—"} · phiếu chi ${salFmt(p.amount)} chờ duyệt`, sub: "Đã khoá lập phiếu mới cho người này tới khi phiếu được duyệt hoặc huỷ", cta: "Thanh toán", onClick: () => onOpenPerson(p.staffId) });
  }

  const card: CSSProperties = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, boxShadow: "var(--shadow-sm)" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12 }}>
        {cards.map((c) => (
          <button key={c.label} onClick={c.onClick}
            style={{ textAlign: "left", cursor: "pointer", background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderTop: `3px solid ${c.bar}`, borderRadius: 12, boxShadow: "var(--shadow-xs)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 600 }}>{c.label}</span>
            <span style={{ ...MONO, fontWeight: 800, fontSize: 20, letterSpacing: "-.02em", color: c.fg ?? "hsl(var(--foreground))" }}>{c.val}</span>
            <span style={{ fontSize: 11.5, color: MUTED }}>{c.sub}</span>
          </button>
        ))}
      </div>

      <div style={card}>
        <PanelHead title="Tiền lương được chia thế nào?" right={<>
          <Switch on={sep} onToggle={() => setSep(!sep)} label="Tách lương bổ sung riêng" />
          <Seg small value={String(cmpIdx)} onChange={(k) => setCmpIdx(Number(k))}
            options={periods.map((p, i) => ({ key: String(i), label: monthShort(p.periodMonth) + (p.locked ? " · đã chốt" : " · tạm tính") }))} />
        </>} />
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, borderBottom: "1px solid hsl(var(--border) / .6)" }}>
          {sel.loading ? <LoadingState label={`số liệu ${monthShort(sel.periodMonth)}`} rows={3} /> : <>
            <p style={{ margin: 0, fontSize: 18, lineHeight: 1.5, fontWeight: 600 }}>{headA} <span style={{ color: headColor, fontWeight: 800 }}>{headB}</span></p>
            <div style={{ position: "relative", paddingTop: 22 }}>
              <div style={{ display: "flex", height: 34, borderRadius: 8, overflow: "hidden", background: "hsl(var(--muted))" }}>
                {groups.map((g, j) => {
                  const w = Math.max(0, gvals[j]) / gmx;
                  return <div key={g.key} title={g.label} style={{ width: (w * 100).toFixed(2) + "%", background: g.color, display: "grid", placeItems: "center", color: "#fff", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden" }}>{w > 0.1 ? fmtMillion(gvals[j]) : ""}</div>;
                })}
              </div>
              {FR > 0 && <>
                <div style={{ position: "absolute", top: 0, bottom: -6, left: ((FR / gmx) * 100).toFixed(2) + "%", borderLeft: "2px dashed hsl(var(--foreground))" }} />
                <span style={{ position: "absolute", top: 0, left: ((FR / gmx) * 100).toFixed(2) + "%", transform: "translateX(-100%)", paddingRight: 6, fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" }}>{fundLbl} {fmtMillion(FR)}</span>
              </>}
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: "hsl(var(--status-neutral-fg))" }}>
              Cứ 100 đồng trả lương thì {p100[0]} đồng là lương cứng, {p100[1]} đồng là thưởng theo công việc, {p100[2]} {sep ? "đồng là phụ cấp." : "đồng là phụ cấp và lương bổ sung."}
            </p>
            {sep && (
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", border: "1px dashed hsl(var(--border))", borderRadius: 10, padding: "12px 16px", background: "hsl(var(--muted) / .4)" }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: SUPPLEMENTARY_COLOR, flex: "none" }} />
                <span style={{ flex: 1, minWidth: 220 }}><b style={{ fontSize: 13.5 }}>Lương QL bổ sung · tính riêng</b><br />
                  <span style={{ fontSize: 11.5, color: MUTED }}>Khoản cố định do chủ công ty cấp thêm, không nằm trong quỹ lương căn bản. Đang nhận diện từ khoản Thưởng nhập tay có nhãn “Bonus QL” / “lương bổ sung”.</span></span>
                <span style={{ textAlign: "right" }}>
                  <span style={{ ...MONO, display: "block", fontWeight: 800, fontSize: 18 }}>{fmtMillion(R.supp)}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: MUTED }}>Nguồn chủ cấp: chưa có dữ liệu</span>
                </span>
              </div>
            )}
          </>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
          {groups.map((g, j) => {
            const ls = linesOf(g.key);
            return (
              <div key={g.key} style={{ padding: "18px 20px", borderRight: "1px solid hsl(var(--border) / .6)", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: g.color, flex: "none" }} />
                  <b style={{ flex: 1, fontSize: 14 }}>{g.label}</b>
                  <span style={{ ...MONO, fontWeight: 800, fontSize: 22, color: g.color }}>{p100[j]}%</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: MUTED }}><span>{g.desc}</span><b style={{ ...MONO, color: "hsl(var(--foreground))", whiteSpace: "nowrap" }}>{salFmt(gvals[j])}</b></div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid hsl(var(--border) / .5)", paddingTop: 10 }}>
                  {ls.length === 0 && <span style={{ fontSize: 12, color: MUTED }}>Không có khoản nào.</span>}
                  {ls.map((l, i) => (
                    <div key={l.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5 }}><span>{l.label}</span><span style={{ ...MONO, whiteSpace: "nowrap", color: l.amount < 0 ? "hsl(var(--status-danger-fg))" : undefined }}>{salFmt(l.amount)}</span></div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ flex: 1, height: 5, borderRadius: 3, background: "hsl(var(--muted))", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: TR > 0 ? Math.max(0, Math.round((l.amount / TR) * 100)) + "%" : 0, background: lineColor(l, i), opacity: .75 }} /></span>
                        <span style={{ fontSize: 11, color: MUTED, minWidth: 96, textAlign: "right" }}>{TR > 0 ? pctTxt(l.amount / TR) : "—"} tổng lương</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))", gap: 18, alignItems: "stretch" }}>
        <div style={{ ...card, display: "flex", flexDirection: "column" }}>
          <PanelHead title="So sánh 3 tháng" sub="Cột là tổng lương, vạch đứt là nguồn lương. Bấm một cột để xem tháng đó." />
          <div style={{ padding: "20px 28px 12px", display: "flex", alignItems: "flex-end", justifyContent: "space-around", gap: 20, height: 260 }}>
            {rep.map((r, i) => {
              const a = i === cmpIdx;
              const f = fundOf(r.p);
              return (
                <button key={r.p.periodMonth} onClick={() => setCmpIdx(i)}
                  style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1, maxWidth: 110, height: "100%", justifyContent: "flex-end", opacity: a ? 1 : .55 }}>
                  {/* Cột tháng chưa có số: cột xám thay chữ "Đang tải…" (chủ chốt 02/10/2026). */}
                  {r.p.loading ? <span role="status" style={{ width: "100%", height: "45%", display: "flex" }}>
                    <span className="sr-only">Đang tải số liệu {monthShort(r.p.periodMonth)}…</span>
                    <SkeletonBar className="ld-appear h-full w-full rounded-b-none" />
                  </span> : <>
                    <span style={{ ...MONO, fontWeight: 800, fontSize: 13 }}>{fmtMillion(r.total)}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: r.total > f ? "hsl(var(--status-danger-fg))" : "hsl(var(--status-success-fg))" }}>{f > 0 ? Math.round((r.total / f) * 100) + "% nguồn" : "chưa có nguồn"}</span>
                    <span style={{ width: "100%", height: Math.round((Math.max(0, r.total) / cMax) * CH), display: "flex", flexDirection: "column-reverse", borderRadius: "6px 6px 0 0", overflow: "hidden" }}>
                      {groups.map((g) => <span key={g.key} style={{ display: "block", height: Math.round((Math.max(0, r.gt[g.key]) / cMax) * CH), background: g.color, flex: "none" }} />)}
                    </span>
                    {f > 0 && <span style={{ position: "relative", width: "100%", height: 0 }}><span style={{ position: "absolute", left: -8, right: -8, bottom: Math.round((f / cMax) * CH) + 6, borderTop: "2px dashed hsl(var(--foreground))" }} /></span>}
                  </>}
                  <span style={{ fontSize: 12.5, fontWeight: a ? 800 : 500, borderTop: "1px solid hsl(var(--border))", width: "100%", paddingTop: 6, textAlign: "center" }}>{monthShort(r.p.periodMonth)}{r.p.locked ? "" : " · tạm"}</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "0 20px 16px", fontSize: 11.5, color: "hsl(var(--status-neutral-fg))" }}>
            {groups.map((g) => <span key={g.key} style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: g.color }} />{g.label}</span>)}
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, borderTop: "2px dashed hsl(var(--foreground))" }} />{fundLbl}</span>
          </div>
        </div>

        <div style={{ ...card, minWidth: 0 }}>
          <PanelHead title={`Từng khoản thay đổi ra sao · ${monthShort(selCur.p.periodMonth)} so với ${monthShort(selPrev.p.periodMonth)}`}
            sub={"Đơn vị: triệu đồng. " + rep.map((r) => monthShort(r.p.periodMonth) + (r.p.locked ? " đã chốt" : " tạm tính")).join(" · ") + "."} />
          <div style={{ overflowX: "auto" }}><div style={{ minWidth: 440 }}>
            <div style={{ display: "grid", gridTemplateColumns: `1.8fr ${rep.map(() => "64px").join(" ")} 84px`, gap: "0 10px", padding: "9px 20px", background: "hsl(var(--muted) / .5)", borderBottom: "1px solid hsl(var(--border))", fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: MUTED }}>
              <span>Khoản</span>{rep.map((r) => <span key={r.p.periodMonth} style={{ textAlign: "right" }}>{monthShort(r.p.periodMonth)}</span>)}<span style={{ textAlign: "right" }}>Thay đổi</span>
            </div>
            {chg.map((r, k) => {
              const dc = dCell(r.vals[iCur], r.vals[iPrev]);
              return (
                <div key={k} style={{ display: "grid", gridTemplateColumns: `1.8fr ${rep.map(() => "64px").join(" ")} 84px`, gap: "0 10px", alignItems: "center", padding: "8px 20px", borderBottom: "1px solid hsl(var(--border) / .5)", background: r.bold === 2 ? "hsl(var(--muted))" : r.bold === 1 ? "hsl(var(--muted) / .35)" : "hsl(var(--card))", fontWeight: r.bold === 2 ? 800 : r.bold === 1 ? 700 : 500, fontSize: 12.5 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: r.indent ? 12 : 0 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: "none" }} />{r.label}</span>
                  {r.vals.map((v, i) => <span key={i} style={{ ...MONO, textAlign: "right" }}>{rep[i].p.loading ? "…" : mNum(v)}</span>)}
                  <span style={{ ...MONO, textAlign: "right", color: r.muteDelta ? MUTED : dc.fg }}>{dc.d}</span>
                </div>
              );
            })}
          </div></div>
        </div>
      </div>

      <div style={card}>
        <PanelHead title={`Mỗi người nhận bao nhiêu · ${monthShort(sel.periodMonth)}/${sel.periodMonth.slice(0, 4)}`} sub="Chỉ tính phần trả từ quỹ lương. Bấm tên để xem từng khoản." />
        {R.people.map((p) => {
          const ls = p.lines.filter((l) => !(sep && l.supplementary));
          const part = (g: FundGroupKey) => ls.filter((l) => l.group === g).reduce((s, l) => s + Math.max(0, l.amount), 0);
          const tot = ls.reduce((s, l) => s + l.amount, 0);
          const w = (v: number) => ((v / pMax) * 100).toFixed(1) + "%";
          return (
            <button key={p.id} onClick={() => onOpenPerson(p.id)}
              style={{ display: "grid", gridTemplateColumns: "minmax(110px,170px) minmax(0,1fr) 110px 56px", gap: 14, alignItems: "center", width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid hsl(var(--border) / .6)", background: "hsl(var(--card))", padding: "12px 20px", cursor: "pointer" }}>
              <b style={{ fontSize: 13 }}>{p.name}</b>
              <span style={{ display: "flex", height: 14, borderRadius: 4, overflow: "hidden", background: "hsl(var(--muted))" }}>
                <span style={{ width: w(part("base")), background: FUND_GROUPS[0].color }} />
                <span style={{ width: w(part("work")), background: FUND_GROUPS[1].color }} />
                <span style={{ width: w(part("extra")), background: FUND_GROUPS[2].color }} />
              </span>
              <span style={{ ...MONO, textAlign: "right", fontWeight: 700 }}>{fmtMillion(tot)}</span>
              <span style={{ textAlign: "right", fontSize: 12, color: MUTED }}>{TR > 0 ? Math.round((tot / TR) * 100) + "%" : "—"}</span>
            </button>
          );
        })}
      </div>

      <div style={card}>
        <button onClick={() => setExcOpen(!excOpen)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", border: 0, background: "transparent", padding: "14px 20px", textAlign: "left", cursor: "pointer" }}>
          <b style={{ fontSize: 14 }}>Cần xử lý trước khi chốt</b>
          <span style={{ fontSize: 11, fontWeight: 700, background: exc.length ? "hsl(var(--status-danger-bg))" : "hsl(var(--status-success-bg))", color: exc.length ? "hsl(var(--status-danger-fg))" : "hsl(var(--status-success-fg))", padding: "1px 7px", borderRadius: 999 }}>{exc.length}</span>
          <span style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 600, color: "hsl(var(--primary))" }}>{excOpen ? "Thu gọn ▴" : "Xem ▾"}</span>
        </button>
        {excOpen && (
          <div style={{ borderTop: "1px solid hsl(var(--border))" }}>
            {exc.length === 0 && <div style={{ padding: "14px 20px", fontSize: 12.5, color: MUTED }}>Không còn việc cần xử lý.</div>}
            {exc.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: "1px solid hsl(var(--border) / .6)", flexWrap: "wrap" }}>
                <StChip tone={e.tone}>{e.tag}</StChip>
                <span style={{ flex: 1, minWidth: 220 }}><b style={{ fontSize: 13, fontWeight: 600 }}>{e.title}</b><br /><span style={{ fontSize: 11.5, color: MUTED }}>{e.sub}</span></span>
                <button onClick={e.onClick} className="sal-btn sal-btn--outline sal-btn--sm" style={{ color: "hsl(var(--primary))" }}>{e.cta} →</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
