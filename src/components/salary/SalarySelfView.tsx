// "Lương của tôi" (bản Claude Design 29/10/2026): nhân viên xem đủ từng khoản lương như
// tab "Thu nhập & thanh toán" của quản trị, chỉ xem. Thứ tự đọc: Tổng thu nhập − Trừ khi
// trả = Còn nhận (ghi chi tiết dưới từng cột) → hoạt động tháng kèm tiền → từng khoản
// (bấm mở căn cứ / đủ danh sách việc). Một component cho cả desktop và điện thoại.
import { useMemo, useState, type ReactNode } from "react";
import {
  Briefcase, Building2, CalendarCheck, ChevronLeft, ChevronRight, CircleMinus, CirclePlus, History,
  House, Info, ListChecks, Percent, Star, Trophy, Wallet, X,
} from "lucide-react";
import type { SalManager } from "@/lib/managerSalary";
import {
  bonusDaysOf, contractRowsOf, earnedJobRowsOf, selfSummaryOf, streakViewOf, type SelfSummary, type StreakView, type V5Plan,
} from "@/lib/salarySelfSummary";
import SalarySelfItems, { ToneTile } from "./SalarySelfItems";
import { SelfJourney, SelfLedger } from "./SalarySelfMore";
import { INCOME_GROUP } from "./salaryIncomeItems";
import type { ChipTone } from "./salaryFundUi";
import { salFmt, salShort, signedNum as money } from "./salaryFormat";
import "./salary.css";

interface Props {
  m: SalManager;
  period: { label: string; year: number };
  /** Cấu hình v5 (mốc chuỗi, ngân sách) — null với kỳ tính theo luật cũ. */
  v5Plan?: V5Plan | null;
  /** Bố cục điện thoại: xếp dọc, thanh tab dưới. */
  phone?: boolean;
  onExit?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
  requirePhoto?: boolean;
}

const tone = (t: ChipTone) => ({ color: `hsl(var(--status-${t}-fg))` });

function BreakRow({ t, icon, name, sub, value, strong, muted }: {
  t: ChipTone; icon: ReactNode; name: string; sub?: string; value: number; strong?: boolean; muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <ToneTile tone={t} size={strong ? 36 : 34}>{icon}</ToneTile>
      <span className="min-w-0 flex-1">
        <span className={"block " + (strong ? "text-[15px] font-extrabold" : "text-[14px] font-bold")} style={strong ? tone(t) : muted ? { color: "hsl(var(--muted-foreground))" } : undefined}>{name}</span>
        {sub && <span className="block text-xs text-muted-foreground">{sub}</span>}
      </span>
      <span className={"whitespace-nowrap font-extrabold " + (strong ? "text-[17px]" : "text-[15.5px]")}
        style={value < 0 ? tone("danger") : strong ? tone(t) : muted ? { color: "hsl(var(--muted-foreground))" } : undefined}>
        {money(value)}
      </span>
    </div>
  );
}

function Summary({ m, s, phone }: { m: SalManager; s: SelfSummary; phone?: boolean }) {
  const workParts = m.bonusAuto.filter((b) => b.amount !== 0).map((b) =>
    b.icon === "Flame" ? "chuỗi ngày" : b.icon === "CalendarCheck" ? "tăng ca CN/lễ" : b.icon === "FileClock" ? "ký HĐ ngoài giờ" : "việc " + b.label);
  const allowParts = m.adjustments.filter((a) => a.amount > 0).map((a) => a.label);
  const pos = [Math.max(0, s.vh), Math.max(0, s.sale), Math.max(0, s.dh)];
  const posSum = pos.reduce((a, b) => a + b, 0) || 1;
  const bars = [
    { w: pos[0] / posSum, c: INCOME_GROUP.vh.color, l: "Lương vận hành" },
    { w: pos[2] / posSum, c: INCOME_GROUP.dh.color, l: "Thu nhập đồng hành" },
    { w: pos[1] / posSum, c: INCOME_GROUP.sale.color, l: "Hoa hồng & thưởng Sale" },
  ].filter((b) => b.w > 0);
  const roomNote = s.roomRent > 0
    ? (m.roomRentInvoice ? "Tiền phòng trừ thẳng vào hoá đơn phòng — không chuyển khoản phần này." : "Chưa có hoá đơn phòng tháng kế — tiền phòng trừ theo mức cố định.")
    : null;
  const op = (c: string) => !phone && <div aria-hidden="true" className="flex items-start pt-7 text-[26px] font-light text-muted-foreground">{c}</div>;
  const v5 = m.v5;
  return (
    <section aria-label="Tóm tắt kỳ" className="flex flex-wrap items-start gap-2.5 rounded-[14px] border bg-card p-4 md:p-5">
      <div className="flex min-w-0 flex-[1.6_1_340px] flex-col gap-3">
        <div>
          <div className="text-[13px] font-semibold text-muted-foreground">Tổng thu nhập</div>
          <div className="mt-1 text-[28px] font-extrabold tracking-tight">{salFmt(s.gross)}</div>
        </div>
        {bars.length > 0 && (
          <div role="img" aria-label={"Cơ cấu thu nhập: " + bars.map((b) => `${b.l} ${Math.round(b.w * 100)}%`).join(", ")} className="flex h-2 gap-[3px]">
            {bars.map((b, i) => <span key={i} className="rounded-sm" style={{ width: b.w * 100 + "%", background: b.c }} />)}
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          <div className="overflow-hidden rounded-xl border">
            <div className="bg-muted/40"><BreakRow t="success" strong icon={<Briefcase size={19} />} name="Lương vận hành" sub={INCOME_GROUP.vh.src} value={s.vh} /></div>
            <div className="divide-y border-t">
              <BreakRow t="info" icon={<CalendarCheck size={18} />} name="Lương cứng"
                sub={v5 ? `Chuyên cần · ${v5.ticked}/${v5.nchuan} ngày công` : `${m.workdays} ngày công`} value={s.base} />
              {s.work !== 0 && <BreakRow t="warning" icon={<Star size={18} />} name="Thưởng" sub={workParts.join(" · ") || "Theo số đã chốt"} value={s.work} />}
              {s.allowance !== 0 && <BreakRow t="tasks" icon={<CirclePlus size={18} />} name="Phụ cấp & lương bổ sung" sub={allowParts.join(" · ")} value={s.allowance} />}
              {s.manualDeduct !== 0 && <BreakRow t="danger" icon={<CircleMinus size={18} />} name="Trừ nhập tay" sub={m.adjustments.filter((a) => a.amount < 0).map((a) => a.label).join(" · ")} value={s.manualDeduct} />}
              {s.other !== 0 && <BreakRow t="neutral" icon={<Info size={18} />} name="Khác theo số đã chốt" sub="Phần lệch giữa số chốt và các dòng đọc lại" value={s.other} />}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border">
            <BreakRow t="info" strong icon={<Building2 size={19} />} name="Thu nhập đồng hành" value={s.dh}
              sub={!m.investmentLocked ? "Lợi nhuận kỳ chưa chốt" : m.investmentBy.length ? `${m.investmentBy.length} tòa · lợi nhuận đã chốt` : "Kỳ này chưa có lợi nhuận được phân bổ"} />
          </div>
          <div className="overflow-hidden rounded-xl border">
            <BreakRow t="tasks" strong={s.sale !== 0} muted={s.sale === 0} icon={<Percent size={19} />} name="Hoa hồng & thưởng Sale" value={s.sale}
              sub={m.commissionItems.length ? `${m.commissionItems.length} phiếu hoa hồng` : "Kỳ này chưa có phiếu hoa hồng"} />
          </div>
        </div>
      </div>

      {op("−")}

      <div className={"flex min-w-0 flex-[1_1_220px] flex-col gap-3" + (phone ? " border-t border-dashed pt-3" : "")}>
        <div>
          <div className="text-[13px] font-semibold text-muted-foreground">{phone ? "− " : ""}Trừ khi trả</div>
          <div className="mt-1 text-[28px] font-extrabold tracking-tight" style={s.deductTotal > 0 ? tone("danger") : undefined}>{salFmt(s.deductTotal)}</div>
        </div>
        <div className="divide-y overflow-hidden rounded-xl border">
          <BreakRow t="danger" icon={<House size={18} />} name="Tiền phòng" value={-s.roomRent} muted={s.roomRent === 0}
            sub={s.roomRent > 0 ? m.roomRentItems.map((r) => r.label).join(" · ") : "Không trừ tiền phòng"} />
          <BreakRow t="neutral" icon={<Wallet size={18} />} name="Đã ứng trong kỳ" value={-s.advance} muted={s.advance === 0}
            sub={m.advanceItems.length ? `${m.advanceItems.length} lần ứng` : "Không có khoản ứng"} />
          {s.paidOut > 0 && <BreakRow t="neutral" icon={<Percent size={18} />} name="Hoa hồng đã chi từ sổ quỹ" value={-s.paidOut} sub="Đã nhận khi duyệt phiếu — không chuyển lại" />}
        </div>
        {roomNote && <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">{roomNote}</p>}
      </div>

      {op("=")}

      <div className="flex min-w-0 flex-[1_1_230px] flex-col gap-2.5 rounded-xl p-4" style={{ background: "hsl(var(--status-success-bg))" }}>
        <div>
          <div className="text-[13px] font-bold" style={tone("success")}>{phone ? "= " : ""}Còn nhận</div>
          <div className="text-[32px] font-extrabold tracking-tight" style={tone("success")}>{salFmt(s.net)}</div>
        </div>
        <div className="flex justify-between gap-2 text-[13.5px]" style={tone("success")}><span>Đã trả trong kỳ</span><b>{money(s.paid)}</b></div>
        <p className="m-0 text-[12.5px]" style={tone("success")}>{s.paid > 0 ? `Đã trả ${salFmt(s.paid)} trong kỳ.` : "Chưa trả lần nào trong kỳ."}</p>
      </div>
    </section>
  );
}

function StatCard({ big, label, pill, extra, moneyLabel, moneyValue }: {
  big: ReactNode; label: string; pill?: string; extra?: ReactNode; moneyLabel: string; moneyValue: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[14px] border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xl font-extrabold">{big}</span>
        {pill && <span className="rounded-full px-2.5 py-0.5 text-[12px] font-extrabold" style={{ background: "hsl(var(--status-success-bg))", ...tone("success") }}>{pill}</span>}
      </div>
      <div className="text-[13px] text-muted-foreground">{label}</div>
      {extra}
      <div className="mt-2 flex items-baseline justify-between gap-2 border-t pt-2 text-[13px]">
        <span className="text-muted-foreground">{moneyLabel}</span>
        <b style={tone("success")}>{moneyValue}</b>
      </div>
    </div>
  );
}

const Of = ({ a, b }: { a: ReactNode; b: ReactNode }) => <>{a}<span className="text-[15px] font-semibold text-muted-foreground">/{b}</span></>;

function Activity({ m, s, plan, streak, phone }: { m: SalManager; s: SelfSummary; plan: V5Plan | null; streak: StreakView | null; phone?: boolean }) {
  const v5 = m.v5;
  const sumOf = (icon: string) => m.bonusAuto.filter((b) => b.icon === icon).reduce((a, b) => a + b.amount, 0);
  const lineOf = (icon: string) => { const l = m.bonusAuto.filter((b) => b.icon === icon); return l.length === 1 ? l[0] : null; };
  const streakLine = lineOf("Flame");
  const jobs = earnedJobRowsOf(m).length;
  const jobLines = m.bonusAuto.filter((b) => b.icon === "Wrench");
  const days = bonusDaysOf(m).length;
  const contracts = contractRowsOf(m).length;
  return (
    <section aria-label="Hoạt động tháng" className={"grid gap-3 " + (phone ? "grid-cols-2" : "grid-cols-[repeat(auto-fit,minmax(210px,1fr))]")}>
      <StatCard big={v5 ? <Of a={v5.ticked} b={v5.nchuan} /> : m.workdays} label="Ngày công"
        moneyLabel="Lương cứng" moneyValue={v5 && plan?.attendBudget ? `${salShort(s.base)}/${salShort(plan.attendBudget)}` : money(s.base)} />
      {streak && (
        <StatCard big={<Of a={streak.days} b={streak.nchuan} />} label="Mốc chuỗi" pill={`đạt ${streak.reached}/${streak.steps.length} mốc`}
          extra={
            <div role="img" aria-label={"Mốc chuỗi: " + streak.steps.map((x) => `${x.label}${x.day != null ? " ngày" : ""} ${x.reached ? "đã đạt" : "chưa đạt"}`).join(", ")} className="text-[14px] font-extrabold">
              {streak.steps.map((x, i) => (
                <span key={i}>
                  {i > 0 && <span className="font-normal text-muted-foreground">/</span>}
                  <span style={x.reached ? tone("success") : { ...tone("danger"), textDecoration: "underline dashed", textUnderlineOffset: 3 }}>{x.label}</span>
                </span>
              ))}
            </div>
          }
          moneyLabel="Thưởng chuỗi"
          // Kỳ đã chốt: bảng kê đóng băng không còn dòng chuỗi riêng — tiền nằm trong số chốt, không phải 0.
          moneyValue={streakLine ? `${salShort(streakLine.amount)}/${salShort(streak.budget)}` : m.status === "LOCKED" ? "Gộp trong số chốt" : `0/${salShort(streak.budget)}`} />
      )}
      <StatCard big={jobs} label="Việc có thưởng" moneyLabel={jobLines.length === 1 && jobLines[0].note ? jobLines[0].note.replace(" việc", "") : `${jobs} việc`} moneyValue={money(sumOf("Wrench"))} />
      <StatCard big={days} label="Ngày CN / lễ có sửa" moneyLabel={lineOf("CalendarCheck")?.note?.replace(" ngày", "") || `${days} ngày`} moneyValue={money(sumOf("CalendarCheck"))} />
      {contracts > 0 && <StatCard big={contracts} label="Ký HĐ ngoài giờ / CN / lễ" moneyLabel={lineOf("FileClock")?.note?.replace(" HĐ", "") || `${contracts} HĐ`} moneyValue={money(sumOf("FileClock"))} />}
    </section>
  );
}

function Fold({ icon, title, sub, children }: { icon: ReactNode; title: string; sub: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="overflow-hidden rounded-[14px] border bg-card">
      <div className="flex flex-wrap items-center gap-3.5 px-4 py-3.5">
        <ToneTile tone="neutral" size={38}>{icon}</ToneTile>
        <div className="min-w-0 flex-[1_1_260px]">
          <h2 className="m-0 text-[15px] font-extrabold">{title}</h2>
          <p className="m-0 text-[12.5px] text-muted-foreground">{sub}</p>
        </div>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="sal-btn sal-btn--outline" style={{ minHeight: 44 }}>
          {open ? "Thu gọn" : "Mở"}
        </button>
      </div>
      {open && <div className="border-t">{children}</div>}
    </section>
  );
}

type Tab = "income" | "ledger" | "history";

export default function SalarySelfView({ m, period, v5Plan = null, phone, onExit, canPrev, canNext, onPrevMonth, onNextMonth, requirePhoto }: Props) {
  const s = useMemo(() => selfSummaryOf(m), [m]);
  const streak = useMemo(() => {
    if (!v5Plan || !m.v5 || m.v5.nchuan <= 0) return null;
    const line = m.bonusAuto.find((b) => b.icon === "Flame");
    return streakViewOf(v5Plan, m.v5, line ? line.amount : null);
  }, [m, v5Plan]);
  const [tab, setTab] = useState<Tab>("income");
  const locked = m.status === "LOCKED";
  const monthText = `${period.label}/${period.year}`;

  const header = (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-3 px-4 py-3 md:px-6">
        <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-[17px] font-extrabold text-primary-foreground">{m.initials}</span>
        <div className="min-w-0 flex-[1_1_160px]">
          <h1 className="m-0 truncate text-[18px] font-extrabold">{m.name}</h1>
          <p className="m-0 truncate text-[13px] text-muted-foreground">{m.role} · Lương của tôi</p>
        </div>
        {phone && onExit && (
          <button type="button" aria-label="Đóng" onClick={onExit} className="flex h-11 w-11 items-center justify-center rounded-[10px] border bg-card">
            <X size={18} aria-hidden="true" />
          </button>
        )}
        <div className={"flex items-center gap-2 " + (phone ? "w-full" : "")}>
          <nav aria-label="Chọn tháng" className={"flex items-center justify-between rounded-[10px] border bg-card " + (phone ? "flex-1" : "")}>
            <button type="button" aria-label="Tháng trước" disabled={!canPrev} onClick={onPrevMonth} className="flex h-11 w-11 items-center justify-center disabled:opacity-40"><ChevronLeft size={18} aria-hidden="true" /></button>
            <span className="min-w-[104px] px-2 text-center text-sm font-bold">{monthText}</span>
            <button type="button" aria-label="Tháng sau" disabled={!canNext} onClick={onNextMonth} className="flex h-11 w-11 items-center justify-center disabled:opacity-40"><ChevronRight size={18} aria-hidden="true" /></button>
          </nav>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-2 text-[12.5px] font-bold"
            style={{ background: `hsl(var(--status-${locked ? "success" : "warning"}-bg))`, ...tone(locked ? "success" : "warning") }}>
            <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full" style={{ background: "currentColor" }} />{locked ? "Đã chốt" : "Chưa chốt"}
          </span>
        </div>
      </div>
    </header>
  );

  const banner = (
    <div role="note" className="flex items-start gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[13px] leading-snug"
      style={{ background: `hsl(var(--status-${locked ? "success" : "warning"}-bg) / .6)`, ...tone(locked ? "success" : "warning") }}>
      <Info size={18} aria-hidden="true" className="mt-px shrink-0" />
      <span>{locked
        ? `Kỳ ${monthText} đã chốt — các số dưới đây là số đóng băng khi chốt lương.`
        : `Kỳ ${monthText} chưa chốt. Khoản "Tạm tính" có thể đổi đến khi quản trị chốt lương. Bấm một khoản để mở chi tiết ngay tại chỗ.`}</span>
    </div>
  );

  const income = (
    <>
      <Summary m={m} s={s} phone={phone} />
      <Activity m={m} s={s} plan={v5Plan} streak={streak} phone={phone} />
      {banner}
      <h2 className="m-0 mt-1 text-base font-extrabold">Từng khoản trong lương</h2>
      <SalarySelfItems m={m} summary={s} streak={streak} compact={phone} />
    </>
  );

  if (phone) {
    const NAV: { key: Tab; label: string; Icon: typeof Wallet }[] = [
      { key: "income", label: "Thu nhập", Icon: Wallet },
      { key: "ledger", label: "Bảng kê", Icon: ListChecks },
      { key: "history", label: "Lịch sử", Icon: History },
    ];
    return (
      <div className="sal-root flex min-h-full flex-col bg-background">
        {header}
        <main className="flex flex-1 flex-col gap-3 px-3.5 pb-6 pt-3.5">
          {tab === "income" && income}
          {tab === "ledger" && <section aria-label="Bảng kê công việc" className="overflow-hidden rounded-[14px] border bg-card"><SelfLedger m={m} requirePhoto={requirePhoto} compact /></section>}
          {tab === "history" && <section aria-label="Thành tích và hành trình" className="overflow-hidden rounded-[14px] border bg-card"><SelfJourney m={m} /></section>}
        </main>
        <nav aria-label="Mục chính" className="sticky bottom-0 flex border-t bg-card px-2.5 pt-1.5" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}>
          {NAV.map((n) => (
            <button key={n.key} type="button" aria-current={tab === n.key ? "page" : undefined} onClick={() => setTab(n.key)}
              className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11.5px]"
              style={tab === n.key ? { ...tone("success"), fontWeight: 700 } : { color: "hsl(var(--muted-foreground))", fontWeight: 600 }}>
              <n.Icon size={22} aria-hidden="true" />{n.label}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="sal-root min-h-full bg-background">
      {header}
      <main className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 pb-12 pt-5 md:px-6">
        {income}
        <Fold icon={<ListChecks size={18} />} title="Bảng kê đầy đủ" sub="Cả việc không được thưởng (thiếu ảnh, ký HĐ trong giờ) và các dòng thu tiền.">
          <SelfLedger m={m} requirePhoto={requirePhoto} />
        </Fold>
        <Fold icon={<Trophy size={18} />} title="Thành tích & hành trình các tháng" sub="Mục tiêu thu nhập và so sánh thu nhập các tháng.">
          <SelfJourney m={m} />
        </Fold>
      </main>
    </div>
  );
}
