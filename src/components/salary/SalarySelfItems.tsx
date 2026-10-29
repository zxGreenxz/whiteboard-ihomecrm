// "Lương của tôi" — danh sách TỪNG KHOẢN theo nhóm nguồn (cùng incomeItemsOf với tab
// "Thu nhập & thanh toán" của quản trị). Chỉ xem: bấm một khoản mở chi tiết ngay dưới
// dòng — căn cứ, mốc chuỗi, hoặc đủ danh sách việc/ngày đứng sau tiền thưởng.
import { useMemo, useState, type ReactNode } from "react";
import { Briefcase, Building2, Check, ChevronRight, House, Percent, X } from "lucide-react";
import type { SalLedgerRow, SalManager } from "@/lib/managerSalary";
import { bonusDaysOf, contractRowsOf, jobRowsOf, type SelfSummary, type StreakView } from "@/lib/salarySelfSummary";
import { INCOME_GROUP, incomeItemsOf, type IncomeItem } from "./salaryIncomeItems";
import { StChip, type ChipTone } from "./salaryFundUi";
import { bigNum, salFmt, signedNum as money } from "./salaryFormat";

type GroupKey = "vh" | "dh" | "sale" | "ded";
type Kind = "trace" | "streak" | "jobs" | "days" | "contract" | "plain";

interface Row {
  id: string;
  g: GroupKey;
  label: string;
  why: string;
  amount: number | null;
  chip: { t: string; tone: ChipTone };
  was?: number;
  strike?: boolean;
  kind: Kind;
  jobType?: string;
  trace: [string, string][];
}

// Dòng chỉ dành cho người quản trị (ai sửa, cách đổi mức, việc cần làm) không hiện cho nhân viên.
const ADMIN_TRACE = new Set(["Người sửa", "Đổi mức / ngừng", "Cần làm"]);

// Lý do sửa tay là ghi chú nội bộ của quản trị: nhân viên chỉ thấy số máy tính và số đã điều chỉnh.
function selfTrace(it: IncomeItem): [string, string][] {
  return it.trace
    .filter(([k]) => !ADMIN_TRACE.has(k))
    .map(([k, v]): [string, string] => (it.ovr && k === "Số đã sửa tay" ? ["Số đã điều chỉnh", salFmt(it.ovr.amount)] : [k, v]));
}

function selfRow(it: IncomeItem): Row {
  const kind: Kind = it.g === "dh"
    ? "plain"
    : it.id === "vh:streak" ? "streak"
    : it.id === "vh:ot" ? "days"
    : it.id === "vh:contract" ? "contract"
    : it.id.startsWith("vh:job:") ? "jobs"
    : "trace";
  return {
    id: it.id,
    g: it.g,
    label: it.label,
    why: it.ovr ? `Máy tính ${salFmt(it.ovr.computed)}` : it.why.replace(" — bấm để chuyển sang trả qua lương", ""),
    amount: it.amount,
    chip: it.ovr ? { t: "Đã điều chỉnh", tone: "tasks" } : it.chip,
    was: it.ovr ? it.ovr.computed : undefined,
    strike: it.strike,
    kind,
    jobType: kind === "jobs" ? it.id.slice("vh:job:".length) : undefined,
    trace: selfTrace(it),
  };
}

const GROUP_META: Record<GroupKey, { title: string; src: string; tone: ChipTone; Icon: typeof Briefcase }> = {
  vh: { title: INCOME_GROUP.vh.title, src: INCOME_GROUP.vh.src, tone: "success", Icon: Briefcase },
  dh: { title: INCOME_GROUP.dh.title, src: INCOME_GROUP.dh.src, tone: "info", Icon: Building2 },
  sale: { title: INCOME_GROUP.sale.title, src: INCOME_GROUP.sale.src, tone: "tasks", Icon: Percent },
  ded: { title: INCOME_GROUP.ded.title, src: "Không phải thu nhập — giảm tiền nhận", tone: "danger", Icon: House },
};

export function ToneTile({ tone, children, size = 36 }: { tone: ChipTone; children: ReactNode; size?: number }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-[10px]"
      style={{ width: size, height: size, background: `hsl(var(--status-${tone}-bg))`, color: `hsl(var(--status-${tone}-fg))` }}>
      {children}
    </span>
  );
}

const fmtDM = (iso: string) => {
  const p = (iso || "").split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : iso || "—";
};

function DayTag({ label }: { label: string }) {
  if (!label) return null;
  return <span className="ml-1.5 rounded-full px-1.5 py-px text-[10.5px] font-extrabold" style={{ background: "hsl(var(--status-danger-bg))", color: "hsl(var(--status-danger-fg))" }}>{label}</span>;
}

function Trace({ trace, tone }: { trace: [string, string][]; tone: ChipTone }) {
  return (
    <ol className="m-0 list-none p-0">
      {trace.map(([k, v], i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden="true" className="flex w-2.5 shrink-0 flex-col items-center">
            <span className="mt-1 h-2.5 w-2.5 rounded-full" style={{ background: `hsl(var(--status-${tone}-fg))` }} />
            {i < trace.length - 1 && <span className="w-0.5 flex-1 bg-border" />}
          </span>
          <span className="min-w-0 pb-3">
            <span className="block text-xs text-muted-foreground">{k}</span>
            <span className="block text-[13.5px] font-semibold leading-snug">{v}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Milestones({ sv }: { sv: StreakView }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2" role="list" aria-label={`Mốc chuỗi: đạt ${sv.reached}/${sv.steps.length}`}>
      {sv.steps.map((s, i) => (
        <span key={i} role="listitem" className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-bold"
          style={s.reached
            ? { background: "hsl(var(--status-success-bg))", color: "hsl(var(--status-success-fg))", borderColor: "transparent" }
            : { background: "hsl(var(--card))", color: "hsl(var(--status-danger-fg))", borderColor: "hsl(var(--status-danger-fg) / .5)", borderStyle: "dashed" }}>
          {s.reached ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <X size={13} strokeWidth={3} aria-hidden="true" />}
          {s.day != null ? `${s.label} ngày` : s.label}
          <span className="font-semibold opacity-80">+{bigNum(s.delta)}</span>
          <span className="sr-only">{s.reached ? "đã đạt" : "chưa đạt"}</span>
        </span>
      ))}
    </div>
  );
}

function JobList({ rows, unit, compact }: { rows: SalLedgerRow[]; unit: string; compact?: boolean }) {
  const total = rows.reduce((s, r) => s + (r.bonus_amount || 0), 0);
  if (!rows.length) return <p className="m-0 text-[13px] text-muted-foreground">Chưa có {unit} nào trong bảng kê kỳ này.</p>;
  const photoAll = rows.every((r) => r.has_photo === true);
  return (
    <div>
      <p className="mb-2 mt-0 text-[12.5px] text-muted-foreground">
        <b className="text-foreground">{rows.length} {unit}</b> đủ điều kiện{photoAll ? " · đều có ảnh nghiệm thu" : ""}
      </p>
      <div className="overflow-hidden rounded-[10px] border bg-card">
        {compact ? (
          <ul className="m-0 list-none p-0">
            {rows.map((r, i) => (
              <li key={(r.source_id || "") + i} className="flex gap-2.5 border-t px-3 py-2 text-[12.5px] first:border-t-0">
                <span className="w-6 shrink-0 text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">{r.content || "—"}</span>
                  <span className="text-muted-foreground">{fmtDM(r.occurred_date)} · {r.place || "—"}<DayTag label={r.day_label} /></span>
                </span>
                <span className="whitespace-nowrap font-bold" style={{ color: "hsl(var(--status-success-fg))" }}>+{bigNum(r.bonus_amount || 0)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-muted/60 text-left text-[11.5px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="w-10 px-3 py-2 font-bold">#</th>
                  <th scope="col" className="w-24 px-3 py-2 font-bold">Ngày</th>
                  <th scope="col" className="w-44 px-3 py-2 font-bold">Toà · phòng</th>
                  <th scope="col" className="px-3 py-2 font-bold">Việc</th>
                  <th scope="col" className="w-14 px-3 py-2 text-center font-bold">Ảnh</th>
                  <th scope="col" className="w-24 px-3 py-2 text-right font-bold">Thưởng</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={(r.source_id || "") + i} className="border-t">
                    <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="whitespace-nowrap px-3 py-2">{fmtDM(r.occurred_date)}<DayTag label={r.day_label} /></td>
                    <td className="px-3 py-2 text-muted-foreground">{r.place || "—"}</td>
                    <td className="px-3 py-2">{r.content || "—"}</td>
                    <td className="px-3 py-2 text-center">
                      {r.has_photo ? <Check size={16} strokeWidth={2.6} aria-label="Có ảnh nghiệm thu" style={{ color: "hsl(var(--status-success-fg))" }} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-bold" style={{ color: "hsl(var(--status-success-fg))" }}>+{bigNum(r.bonus_amount || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-between border-t-2 bg-muted/60 px-3 py-2.5 text-[13px] font-extrabold">
          <span>Tổng {rows.length} {unit}</span>
          <span style={{ color: "hsl(var(--status-success-fg))" }}>{bigNum(total)}</span>
        </div>
      </div>
    </div>
  );
}

function DayList({ m }: { m: SalManager }) {
  const days = bonusDaysOf(m);
  if (!days.length) return <p className="m-0 text-[13px] text-muted-foreground">Chưa có ngày CN / lễ nào trong bảng kê kỳ này.</p>;
  return (
    <div className="flex flex-col gap-2.5">
      {days.map(({ row, jobs }, i) => (
        <div key={(row.source_id || "") + i} className="overflow-hidden rounded-[10px] border bg-card">
          <div className="flex flex-wrap items-center gap-2.5 border-b px-3.5 py-2.5">
            <DayTag label={row.day_label || "CN"} />
            <b className="text-[13.5px]">{fmtDM(row.occurred_date)}</b>
            <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">{row.content || "Ngày CN / lễ có làm việc"} · {jobs.length} việc</span>
            <b className="text-sm" style={{ color: "hsl(var(--status-success-fg))" }}>+{bigNum(row.bonus_amount || 0)}</b>
          </div>
          {jobs.map((j, k) => (
            <div key={(j.source_id || "") + k} className="flex flex-wrap gap-x-3 border-t px-3.5 py-2 text-[13px] first:border-t-0">
              <span className="w-40 shrink-0 text-muted-foreground">{j.place || "—"}</span>
              <span className="min-w-0 flex-1">{j.content || "—"}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Detail({ row, m, tone, streak, compact }: { row: Row; m: SalManager; tone: ChipTone; streak: StreakView | null; compact?: boolean }) {
  if (row.kind === "jobs") return <JobList rows={jobRowsOf(m, row.jobType || "")} unit="việc" compact={compact} />;
  if (row.kind === "contract") return <JobList rows={contractRowsOf(m)} unit="hợp đồng" compact={compact} />;
  if (row.kind === "days") return <DayList m={m} />;
  // Thưởng chuỗi: căn cứ là chuỗi ngày + mốc, không phải số việc trong bảng kê.
  const trace: [string, string][] = row.kind === "streak" && streak
    ? [["Chuỗi ngày có việc", `${streak.days}/${streak.nchuan} ngày · đạt ${streak.reached}/${streak.steps.length} mốc`], ...row.trace.filter(([k]) => k !== "Bằng chứng")]
    : row.trace;
  return (
    <>
      {row.kind === "streak" && streak && <Milestones sv={streak} />}
      <div className="pb-0.5 pt-1 text-[11.5px] font-extrabold uppercase tracking-wide text-muted-foreground">Căn cứ</div>
      <div className="pt-2"><Trace trace={trace} tone={tone} /></div>
    </>
  );
}

function Amount({ row }: { row: Row }) {
  const neg = (row.amount ?? 0) < 0;
  return (
    <span className="flex min-w-[112px] flex-col items-end">
      {row.was != null && <span className="text-xs text-muted-foreground line-through">{money(row.was)}</span>}
      <span className={"whitespace-nowrap text-[15px] font-bold" + (row.strike ? " line-through" : "")}
        style={{ color: row.amount == null ? "hsl(var(--status-warning-fg))" : neg ? "hsl(var(--status-danger-fg))" : undefined }}>
        {row.amount == null ? "Chưa đủ cơ sở" : money(row.amount)}
      </span>
    </span>
  );
}

interface Props {
  m: SalManager;
  summary: SelfSummary;
  streak: StreakView | null;
  compact?: boolean;
  /** Khoản mở sẵn khi vào trang (id dòng), mặc định không mở. */
  initialOpen?: string | null;
}

export default function SalarySelfItems({ m, summary, streak, compact, initialOpen = null }: Props) {
  const [open, setOpen] = useState<string | null>(initialOpen);
  const rows = useMemo(() => incomeItemsOf(m).map(selfRow), [m]);
  const ded: Row[] = useMemo(() => {
    const out: Row[] = [];
    m.roomRentItems.forEach((r, i) => out.push({
      id: "ded:room:" + i, g: "ded", label: "Tiền phòng", why: r.label + " · cấn trừ khi trả lương", amount: -r.amount, kind: "trace",
      chip: { t: "Cấn trừ", tone: "danger" },
      trace: [["Hoá đơn", r.label], ["Cách trừ", m.roomRentInvoice ? "Trừ thẳng vào hoá đơn phòng, không chuyển khoản phần này" : "Trừ theo mức cố định trong cấu hình lương"], ["Ảnh hưởng", "Giảm tiền nhận — không giảm tổng thu nhập"]],
    }));
    m.advanceItems.forEach((a, i) => out.push({
      id: "ded:adv:" + i, g: "ded", label: a.label, why: `Ứng ngày ${a.date} · đã nhận, trừ vào lương kỳ`, amount: -a.amount, kind: "trace",
      chip: { t: "Đã ứng", tone: "neutral" },
      trace: [["Ngày ứng", a.date], ["Ảnh hưởng", "Đã nhận trước — trừ khỏi tiền nhận kỳ này"]],
    }));
    if (summary.paidOut > 0) out.push({
      id: "ded:book", g: "ded", label: "Hoa hồng đã chi từ sổ quỹ", why: "Đã nhận khi duyệt phiếu hoa hồng — không chuyển lại qua lương", amount: -summary.paidOut, kind: "trace",
      chip: { t: "Đã chi từ sổ", tone: "neutral" },
      trace: [["Ảnh hưởng", "Là thu nhập của kỳ nhưng tiền đã ra từ sổ quỹ — trừ khỏi tiền nhận để không trả hai lần"]],
    });
    return out;
  }, [m, summary.paidOut]);

  const dhMax = Math.max(1, ...m.investmentBy.map((x) => Math.abs(x.amount)));
  const groups: { key: GroupKey; total: number; rows: Row[]; empty: string }[] = [
    { key: "vh", total: summary.vh, rows: rows.filter((r) => r.g === "vh"), empty: "Kỳ này chưa có khoản lương vận hành." },
    { key: "dh", total: summary.dh, rows: rows.filter((r) => r.g === "dh").sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)), empty: "Kỳ này chưa có lợi nhuận được phân bổ." },
    { key: "sale", total: summary.sale, rows: rows.filter((r) => r.g === "sale"), empty: "Kỳ này chưa có phiếu hoa hồng nào ghi cho bạn." },
    { key: "ded", total: -summary.deductTotal, rows: ded, empty: "Kỳ này không có khoản ứng hay cấn trừ." },
  ];

  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => {
        const meta = GROUP_META[g.key];
        return (
          <section key={g.key} aria-label={meta.title} className="overflow-hidden rounded-[14px] border bg-card">
            <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
              <ToneTile tone={meta.tone}><meta.Icon size={19} /></ToneTile>
              <div className={"min-w-0 " + (compact ? "flex-1" : "flex-[1_1_200px]")}>
                <h3 className="m-0 text-[15.5px] font-extrabold" style={{ color: `hsl(var(--status-${meta.tone}-fg))` }}>{meta.title}</h3>
                <p className="m-0 text-xs text-muted-foreground">{meta.src}</p>
              </div>
              {!compact && <span className="text-[12.5px] text-muted-foreground">{g.rows.length} {g.key === "dh" ? "tòa" : "khoản"}</span>}
              <span className={"text-right text-base font-extrabold " + (compact ? "" : "min-w-[112px]")} style={{ color: g.total < 0 ? "hsl(var(--status-danger-fg))" : `hsl(var(--status-${meta.tone}-fg))` }}>{money(g.total)}</span>
            </div>
            {g.rows.length === 0 && <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">{g.empty}</p>}
            {g.rows.map((r) => {
              if (r.kind === "plain") {
                const w = r.amount == null ? 0 : (Math.abs(r.amount) / dhMax) * 100;
                return (
                  <div key={r.id} className="flex flex-wrap items-center gap-3.5 border-t px-4 py-3 first:border-t-0">
                    <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
                      <span className="text-sm font-semibold">{r.label}</span>
                      <span className="text-[12.5px] text-muted-foreground">{r.why}</span>
                      {r.amount != null && (
                        <span aria-hidden="true" className="mt-1 block h-[5px] max-w-[360px] rounded bg-muted">
                          <span className="block h-full rounded" style={{ width: w + "%", background: (r.amount ?? 0) < 0 ? "hsl(var(--status-danger-fg))" : INCOME_GROUP.dh.color }} />
                        </span>
                      )}
                    </span>
                    <StChip tone={r.chip.tone}>{r.chip.t}</StChip>
                    <Amount row={r} />
                  </div>
                );
              }
              const isOpen = open === r.id;
              const panelId = "self-item-" + r.id.replace(/[^a-zA-Z0-9_-]/g, "_");
              const cta = isOpen ? "Thu gọn"
                : r.kind === "jobs" ? `Xem ${jobRowsOf(m, r.jobType || "").length} việc`
                : r.kind === "contract" ? `Xem ${contractRowsOf(m).length} HĐ`
                : r.kind === "days" ? `Xem ${bonusDaysOf(m).length} ngày`
                : "Căn cứ";
              return (
                <div key={r.id} className="border-t first:border-t-0">
                  <button type="button" aria-expanded={isOpen} aria-controls={panelId} onClick={() => setOpen(isOpen ? null : r.id)}
                    className={"flex w-full flex-wrap items-center gap-x-3.5 gap-y-1.5 border-0 px-4 py-3 text-left transition-colors hover:bg-muted/50 " + (isOpen ? "bg-muted/50" : "bg-card")}>
                    <span className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
                      <span className="text-sm font-semibold">{r.label}</span>
                      {r.why && <span className="text-[12.5px] leading-snug text-muted-foreground">{r.why}</span>}
                    </span>
                    <StChip tone={r.chip.tone}>{r.chip.t}</StChip>
                    <Amount row={r} />
                    <span className="inline-flex min-w-[96px] items-center justify-end gap-1 text-[12.5px] font-bold" style={{ color: "hsl(var(--status-success-fg))" }}>
                      {cta}
                      <ChevronRight size={16} aria-hidden="true" className="transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : undefined }} />
                    </span>
                  </button>
                  {isOpen && (
                    <div id={panelId} className="bg-muted/50 px-4 pb-4 pt-1.5">
                      <Detail row={r} m={m} tone={meta.tone} streak={streak} compact={compact} />
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
