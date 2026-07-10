// Self-view "Lương của tôi" — bản Năng lượng. Port từ kit SalarySelf.jsx.
import React, { useState } from "react";
import { SAL_ICONS } from "./salaryIcons";
import { salFmt, salShort, bigNum } from "./salaryFormat";
import { useCountUp, Ring, Popover, tint } from "./salaryCommon";
import { BonusPop, InvestmentPop, CommissionPop, AdvancePop } from "./salaryPopovers";
import { SalChartModal } from "./salaryChart";
import type { SalManager } from "@/lib/managerSalary";

const I = SAL_ICONS;

function Deltas({ m, periodText, onOpenLedger }: { m: SalManager; periodText: string; onOpenLedger?: () => void }) {
  const [pop, setPop] = useState<{ type: string; rect: DOMRect } | null>(null);
  const c = m.calc!;
  const open = (type: string, e: React.MouseEvent) => setPop({ type, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
  const items = [
    { key: "bonus", label: "Thưởng", v: c.bonus, icon: "Gift", minus: false, noPop: false },
    { key: "investment", label: "Đầu tư", v: m.investment, icon: "TrendingUp", minus: false, noPop: false },
    { key: "commission", label: "HH Sale", v: m.commission, icon: "HandCoins", minus: false, noPop: false },
    { key: "advance", label: "Đã ứng", v: m.advance, icon: "PiggyBank", minus: true, noPop: false },
    { key: "room", label: "Tiền phòng", v: m.roomRent, icon: "Home", minus: true, noPop: true },
  ].filter((x) => x.v > 0);
  return (
    <div className="sal-hero-deltas">
      {items.map((x) => (
        <button key={x.key}
          className={"sal-delta" + (x.minus ? " minus" : "") + (x.noPop ? "" : " clickable")}
          onClick={x.noPop ? undefined : (e) => open(x.key, e)}>
          {React.createElement(I[x.icon], { size: 13 })}{x.label} <b className="v">{x.minus ? "−" : "+"}{salShort(x.v)}</b>
          {x.noPop ? null : <I.Info size={12} style={{ opacity: .65, marginLeft: 1 }} />}
        </button>
      ))}
      {pop && (
        <Popover rect={pop.rect} width={pop.type === "bonus" ? 360 : 340} onClose={() => setPop(null)}>
          {pop.type === "bonus" && <BonusPop m={m} periodText={periodText} locked onClose={() => setPop(null)} onOpenLedger={onOpenLedger || (() => {})} onAdjust={() => {}} onRemove={() => {}} />}
          {pop.type === "investment" && <InvestmentPop m={m} periodText={periodText} />}
          {pop.type === "commission" && <CommissionPop m={m} />}
          {pop.type === "advance" && <AdvancePop m={m} periodText={periodText} />}
        </Popover>
      )}
    </div>
  );
}

function JourneyTrack({ m }: { m: SalManager }) {
  if (!m.incomeGoal) return null;
  const pct = Math.round((m.calc!.gross / m.incomeGoal) * 100);
  const done = pct >= 100;
  const stops = [
    { v: m.incomeGoal * 0.25, l: "Khởi động", icon: "Zap" },
    { v: m.base, l: "Lương cứng", icon: "Briefcase" },
    { v: m.incomeGoal * 0.75, l: "Bứt phá", icon: "Flame" },
    { v: m.incomeGoal, l: "Mục tiêu", icon: "Trophy" },
  ];
  const next = stops.find((s) => s.v > m.calc!.gross);
  return (
    <div className="sal-journey">
      <div className="sal-goal-top">
        <span className="g"><I.Target size={15} style={{ color: done ? "hsl(48 96% 62%)" : "#fff" }} />{done ? "Đã vượt mục tiêu tháng!" : "Mục tiêu thu nhập tháng"}</span>
        <span className="pct">{pct}%</span>
      </div>
      <div className="sal-track">
        <div className="sal-track-line"><span style={{ width: Math.min(pct, 100) + "%" }} /></div>
        {stops.map((s, i) => {
          const reached = m.calc!.gross >= s.v;
          const left = Math.min((s.v / m.incomeGoal) * 100, 100);
          return (
            <div className="sal-track-stop" key={i} style={{ left: left + "%" }}>
              <span className={"sal-track-dot" + (reached ? " on" : "")}>{React.createElement(I[reached ? "Check" : s.icon], { size: 14 })}</span>
              <span className="sal-track-lab">{s.l}<b>{salShort(s.v)}</b></span>
            </div>
          );
        })}
      </div>
      <div className="sal-journey-foot">
        {next
          ? <span><I.Rocket size={14} />Còn <b className="sal-num">{salFmt(next.v - m.calc!.gross)}</b> để đạt mốc <b>{next.l}</b></span>
          : <span><I.Trophy size={14} style={{ color: "hsl(48 96% 62%)" }} />Đã chinh phục mọi mốc tháng này!</span>}
      </div>
    </div>
  );
}

function Hero({ m, period, onOpenLedger }: { m: SalManager; period: { label: string; year: number }; onOpenLedger?: () => void }) {
  const earned = useCountUp(m.calc!.gross, [m.calc!.gross]);
  const net = m.calc!.takehome - m.paid;
  const [chartOpen, setChartOpen] = useState(false);
  const periodText = `${period.label}/${period.year}`;
  return (
    <div className="sal-hero">
      <div className="sal-hero-top">
        <div className="sal-hero-hi">
          <span className="sal-hero-ava">{m.initials}</span>
          <div><h2>Chào {m.short}!</h2><p>{m.role}{m.alias ? " · biệt danh " + m.alias : ""}</p></div>
        </div>
        <div className="sal-hero-periodwrap">
          <span className="sal-hero-period"><span className="sal-live"><span className="dot" /></span>{periodText} · đang diễn ra</span>
          <button className="sal-hero-chartbtn" title="Xem biểu đồ lương các tháng" onClick={() => setChartOpen(true)}><I.BarChart size={16} />Biểu đồ</button>
        </div>
      </div>
      <div className="sal-hero-mid">
        <div className="sal-hero-cap"><I.Sparkles size={15} />Bạn đã tích luỹ tháng này<span className="sal-livepill"><span className="dot" />Realtime</span></div>
        <div className="sal-hero-num">{bigNum(earned)}<span className="u">₫</span></div>
        <Deltas m={m} periodText={periodText} onOpenLedger={onOpenLedger} />
        <div className="sal-hero-net">
          <span className="lb">Còn nhận</span>
          <span className="vl">{salFmt(net)}</span>
          {m.paid > 0 ? <span className="paid">Đã trả {salFmt(m.paid)}</span> : <span className="paid"><I.Flame size={13} style={{ verticalAlign: "-2px" }} /> Chuỗi {m.stats.streak} ngày liên tục có việc</span>}
        </div>
        <JourneyTrack m={m} />
      </div>
      {chartOpen && <SalChartModal managers={[m]} onClose={() => setChartOpen(false)} />}
    </div>
  );
}

function StatTiles({ m }: { m: SalManager }) {
  const tiles = [
    { v: m.stats.jobs, l: "Việc đã làm", x: m.stats.repairs + " việc sửa chữa", icon: "Wrench", pct: Math.min((m.stats.jobs / 30) * 100, 100), tone: "primary" },
    { v: m.stats.afterHour, l: "HĐ ngoài giờ / CN / lễ", x: "+" + salShort(m.stats.afterHour * 50000) + " thưởng", icon: "FileClock", pct: Math.min((m.stats.afterHour / 15) * 100, 100), tone: "info" },
    { v: m.stats.streak, l: "Chuỗi ngày có việc", x: "Giữ phong độ!", icon: "Flame", pct: Math.min((m.stats.streak / 30) * 100, 100), tone: "warning" },
    { v: m.stats.workdays, l: "Ngày công", x: "Trong tháng", icon: "CalendarCheck", pct: Math.min((m.stats.workdays / 30) * 100, 100), tone: "success" },
  ];
  return (
    <div className="sal-self-stats">
      {tiles.map((t, i) => (
        <div className="sal-stat" key={i} style={{ borderLeftColor: `hsl(var(--${t.tone === "primary" ? "primary" : "status-" + t.tone}))` }}>
          <Ring pct={t.pct} size={54} stroke={6} color={`hsl(var(--${t.tone === "primary" ? "primary" : "status-" + t.tone + "-strong"}))`}>
            {React.createElement(I[t.icon], { size: 19, style: { color: `hsl(var(--${t.tone === "primary" ? "primary" : "status-" + t.tone + "-strong"}))` } })}
          </Ring>
          <div className="si"><span className="v">{t.v}</span><span className="l">{t.l}</span><span className="x"><I.ArrowUpRight size={12} />{t.x}</span></div>
        </div>
      ))}
    </div>
  );
}

function EnergyFeed({ m, onOpenLedger }: { m: SalManager; onOpenLedger?: () => void }) {
  const rows = m.ledger.slice(0, 6);
  const earned = rows.reduce((s, r) => s + (r.bonus_amount || 0), 0);
  const TINT: Record<string, string> = { JOB: "success", DAY_BONUS: "warning", CONTRACT: "info", CASH: "neutral" };
  const ICON: Record<string, string> = { JOB: "Wrench", DAY_BONUS: "CalendarCheck", CONTRACT: "FileClock", CASH: "Banknote" };
  return (
    <div className="sal-card sal-feedcard">
      <div className="sal-sec-head">
        <span className="ic"><I.Zap size={17} /></span>
        <h3>Mỗi việc một khoản thưởng</h3>
        {onOpenLedger && <button className="more" onClick={onOpenLedger}>Xem tất cả <I.ArrowRight size={13} /></button>}
      </div>
      <div className="sal-efeed">
        {rows.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Chưa có việc nào tháng này.</div>}
        {rows.map((r, i) => (
          <div className="sal-efeed-row" key={i}>
            <span className="sal-efeed-ic" style={tint(TINT[r.item_type])}>{React.createElement(I[ICON[r.item_type]], { size: 16 })}</span>
            <div className="sal-efeed-main"><b>{r.content}</b><small>{r.occurred_date}{r.day_label ? " · " + r.day_label : ""}{r.place ? " · " + r.place : ""}</small></div>
            {r.bonus_amount == null
              ? <span className="sal-efeed-amt zero">Không tính</span>
              : <span className="sal-efeed-amt">+{salFmt(r.bonus_amount)}</span>}
          </div>
        ))}
      </div>
      {rows.length > 0 && <div className="sal-efeed-foot"><I.Sparkles size={13} />Các việc gần đây cộng <b className="sal-num">+{salFmt(earned)}</b> vào thưởng tháng này</div>}
    </div>
  );
}

function InvestmentCard({ m }: { m: SalManager }) {
  if (!m.investmentBy.length) return null;
  const max = Math.max.apply(null, m.investmentBy.map((x) => x.amount)) || 1;
  return (
    <div className="sal-card">
      <div className="sal-sec-head"><span className="ic" style={{ background: "hsl(var(--status-info-bg))", color: "hsl(var(--status-info-fg))" }}><I.TrendingUp size={17} /></span><h3>Lợi nhuận đầu tư theo nhà</h3></div>
      <div style={{ padding: "6px 0 10px" }}>
        {m.investmentBy.map((x, i) => (
          <div className="sal-invrow" key={i}>
            <span className="bld">{x.b}</span>
            <span className="sal-invbar"><span style={{ width: (x.amount / max * 100) + "%" }} /></span>
            <span className="sal-invamt">{salFmt(x.amount)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 18px", borderTop: "1px solid hsl(var(--border))", background: "hsl(var(--muted) / .4)" }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "hsl(var(--muted-foreground))" }}>Tổng đầu tư</span>
        <span className="sal-num" style={{ fontWeight: 800, color: "hsl(var(--status-info-fg))" }}>{salFmt(m.investment)}</span>
      </div>
    </div>
  );
}

function HistoryCard({ m }: { m: SalManager }) {
  const rows = (m.trend || []).filter((d) => !d.current).slice().reverse();
  return (
    <div className="sal-card">
      <div className="sal-sec-head"><span className="ic" style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}><I.Clock size={17} /></span><h3>Lịch sử nhận lương</h3></div>
      <div>
        {rows.length === 0 && <div style={{ padding: 18, textAlign: "center", fontSize: 13, color: "hsl(var(--muted-foreground))" }}>Chưa có tháng nào đã chốt.</div>}
        {rows.map((h, i) => (
          <div className="sal-histrow" key={i}>
            <span className="pd">T{h.label.replace(/^0/, "")}</span>
            <span className="pay"><span className="sal-statebadge sal-statebadge--paid" style={{ marginRight: 7 }}><I.Check size={11} />Đã chốt</span>{h.paidOn || ""}</span>
            <span className="am">{salFmt(h.takehome)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SalarySelf({ m, period, onOpenLedger }: { m: SalManager; period: { label: string; year: number }; onOpenLedger?: () => void }) {
  return (
    <div className="sal-self">
      <Hero m={m} period={period} onOpenLedger={onOpenLedger} />
      <StatTiles m={m} />
      <EnergyFeed m={m} onOpenLedger={onOpenLedger} />
      <div className="sal-two">
        <InvestmentCard m={m} />
        <HistoryCard m={m} />
      </div>
    </div>
  );
}
