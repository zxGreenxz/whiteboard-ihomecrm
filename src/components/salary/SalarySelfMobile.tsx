// Self-view "Lương của tôi" — bản MOBILE (QUEST). Import từ thiết kế claude.ai/design
// "Lương của tôi - QUEST.dc.html": theme tối tím-vàng, gamified (hạng/chặng nhiệm vụ).
// DÙNG CHUNG dữ liệu SalManager với bản desktop (SalarySelf); chỉ khác cách trình bày.
// Rẽ nhánh desktop ↔ mobile bằng usePhoneViewport ở ManagerSalaryPage.
import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Trophy, Briefcase, Flame, Zap, Sparkles, Wrench, CalendarCheck, FileText,
  Banknote, Moon, TrendingUp, BarChart3, ChevronRight, ChevronLeft, X, Undo2,
  Wallet, ListChecks, Check, Target, type LucideIcon,
} from "lucide-react";
import { salFmt, salShort } from "./salaryFormat";
import { useCountUp } from "./salaryCommon";
import type { SalManager, SalLedgerRow } from "@/lib/managerSalary";

const bigNum = (v: number) => Math.round(v).toLocaleString("vi-VN");

// Hạng suy từ số mốc "chặng nhiệm vụ tháng" đã đạt (0..4) — bám dữ liệu thật
// (gross vs incomeGoal) thay vì cấp độ ảo. Khởi động/Lương cứng/Bứt phá/Vô địch.
const RANK_NAMES = ["Tân binh", "Đồng", "Bạc", "Vàng", "Vô địch"];

interface ScreenProps { m: SalManager; period: { label: string; year: number }; }

// ───────────────────────── icon theo loại dòng ledger ─────────────────────────
const FEED_ICON: Record<string, LucideIcon> = {
  JOB: Wrench, DAY_BONUS: CalendarCheck, CONTRACT: FileText, CASH: Banknote,
};
const FEED_TONE: Record<string, { bg: string; fg: string }> = {
  JOB: { bg: "rgba(52,211,153,.16)", fg: "#34D399" },
  DAY_BONUS: { bg: "rgba(255,210,63,.16)", fg: "#FFD23F" },
  CONTRACT: { bg: "rgba(139,92,246,.2)", fg: "#A78BFA" },
  CASH: { bg: "rgba(154,143,196,.16)", fg: "#9A8FC4" },
};

function FeedRow({ r }: { r: SalLedgerRow }) {
  const tone = FEED_TONE[r.item_type] || FEED_TONE.CASH;
  const Icon = FEED_ICON[r.item_type] || Banknote;
  const sub = [r.occurred_date, r.day_label, r.place].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-3 px-[18px] py-3 border-b border-[#322a55]/60 last:border-b-0">
      <span className="w-[34px] h-[34px] rounded-[10px] grid place-items-center shrink-0"
        style={{ background: tone.bg, color: tone.fg }}>
        <Icon size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-[#EDEAF7] truncate">{r.content}</div>
        <div className="text-[11px] text-[#9A8FC4] truncate">{sub || "—"}</div>
      </div>
      {r.bonus_amount == null ? (
        <span className="font-mono text-[12px] font-semibold text-[#9A8FC4] shrink-0">Không tính</span>
      ) : (
        <span className="font-mono text-[13.5px] font-bold text-[#34D399] shrink-0">+{salShort(r.bonus_amount)}</span>
      )}
    </div>
  );
}

// ───────────────────────────── màn HOME (Lương) ─────────────────────────────
function HomeScreen({ m, period, onExit, onOpenChart, onOpenBreak, onGoInvest, onGoList }: ScreenProps & {
  onExit: () => void; onOpenChart: () => void; onOpenBreak: () => void; onGoInvest: () => void; onGoList: () => void;
}) {
  const c = m.calc!;
  const gross = c.gross;
  const earned = useCountUp(gross, [gross]);
  const net = c.takehome - m.paid;
  const periodText = `${period.label}/${period.year}`;
  const goal = m.incomeGoal || 0;

  // Chặng nhiệm vụ (mốc tới mục tiêu thu nhập) — chung nguồn với "hạng".
  const stops = goal > 0 ? [
    { v: goal * 0.25, l: "Khởi động", Icon: Zap },
    { v: m.base, l: "Lương cứng", Icon: Briefcase },
    { v: goal * 0.75, l: "Bứt phá", Icon: Flame },
    { v: goal, l: "Vô địch", Icon: Trophy },
  ].sort((a, b) => a.v - b.v) : [];
  const reached = stops.filter((s) => gross >= s.v).length;
  const rankName = RANK_NAMES[reached];
  const nextRank = reached < 4 ? RANK_NAMES[reached + 1] : null;
  const pct = goal > 0 ? Math.round(Math.min(gross / goal, 1) * 100) : 0;
  const nextStop = stops.find((s) => s.v > gross);

  // Chips bóc tách thu nhập (chỉ hiện khoản > 0).
  const chips = [
    { label: "Lương cứng", v: m.base, minus: false, color: "#EDEAF7", bg: "rgba(255,255,255,.12)" },
    { label: "Thưởng việc", v: c.bonus, minus: false, color: "#FFD23F", bg: "rgba(255,210,63,.16)" },
    { label: "Đầu tư", v: m.investment, minus: false, color: "#9DE7C0", bg: "rgba(52,211,153,.18)" },
    { label: "HH Sale", v: m.commission, minus: false, color: "#C4B5FD", bg: "rgba(139,92,246,.22)" },
    { label: "Đã ứng", v: m.advance, minus: true, color: "#FFB3C6", bg: "rgba(255,122,160,.2)" },
    { label: "Tiền phòng", v: m.roomRent, minus: true, color: "#FFB3C6", bg: "rgba(255,122,160,.2)" },
  ].filter((x) => x.v > 0);

  const tiles = [
    { v: m.stats.jobs, l: "Thợ sửa chữa", x: `${m.stats.repairs} việc sửa chữa`, Icon: Wrench, bg: "rgba(52,211,153,.16)", fg: "#34D399" },
    { v: m.stats.afterHour, l: "Cú đêm", x: "HĐ ngoài giờ / CN / lễ", Icon: Moon, bg: "rgba(139,92,246,.18)", fg: "#A78BFA" },
    { v: m.stats.streak, l: "Chuỗi lửa", x: `${m.stats.streak} ngày liên tục 🔥`, Icon: Flame, bg: "rgba(255,122,160,.16)", fg: "#FF7AA0" },
    { v: m.stats.workdays, l: "Chuyên cần", x: `${m.stats.workdays} ngày công`, Icon: CalendarCheck, bg: "rgba(255,210,63,.16)", fg: "#FFD23F" },
  ];

  const feed = m.ledger.slice(0, 5);
  const feedSum = feed.reduce((s, r) => s + (r.bonus_amount || 0), 0);

  return (
    <div className="px-[14px] pt-3 pb-6 space-y-[14px]">
      {/* ───── HERO ───── */}
      <div className="relative rounded-[28px] overflow-hidden p-[22px]"
        style={{ background: "radial-gradient(110% 120% at 90% -10%, #5B3AA8 0%, transparent 55%), radial-gradient(100% 120% at -5% 115%, #7A4F12 0%, transparent 58%), #251C46" }}>
        <div className="absolute inset-0 pointer-events-none opacity-60"
          style={{ backgroundImage: "radial-gradient(rgba(255,210,63,.10) 1px, transparent 1px)", backgroundSize: "16px 16px" }} />

        {/* top: avatar + tên + period */}
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <span className="w-[46px] h-[46px] rounded-full grid place-items-center font-extrabold text-[16px] tabular-nums"
                style={{ background: "rgba(255,210,63,.16)", border: "2px solid #FFD23F", color: "#FFD23F" }}>
                {m.initials}
              </span>
              {goal > 0 && (
                <span className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 text-[9px] font-extrabold px-[7px] py-px rounded-full whitespace-nowrap"
                  style={{ color: "#17132A", background: "#FFD23F", boxShadow: "0 2px 6px rgba(255,210,63,.4)" }}>
                  Lv.{reached + 1}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[17px] font-extrabold text-white tracking-tight truncate">Chào {m.short}!</div>
              <div className="text-[12px] text-[#EDEAF7]/70 truncate">{m.role}{goal > 0 ? ` · hạng ${rankName}` : ""}</div>
            </div>
          </div>
          <div className="flex items-center gap-[7px] shrink-0">
            <span className="inline-flex items-center gap-[6px] text-[11px] font-semibold text-[#EDEAF7] px-[11px] py-[6px] rounded-full"
              style={{ background: "rgba(255,255,255,.12)" }}>
              <span className="w-[6px] h-[6px] rounded-full animate-pulse" style={{ background: "#FFD23F" }} />
              {periodText}
            </span>
            <button onClick={onExit} title="Quay lại" aria-label="Quay lại"
              className="w-8 h-8 rounded-full grid place-items-center shrink-0"
              style={{ background: "rgba(255,255,255,.12)", border: "1px solid rgba(255,255,255,.18)", color: "#EDEAF7" }}>
              <Undo2 size={16} />
            </button>
          </div>
        </div>

        {/* caption */}
        <div className="relative mt-5 flex items-center gap-2 text-[12.5px] text-[#EDEAF7]/85">
          <Trophy size={15} style={{ color: "#FFD23F" }} />
          Tổng thu nhập tích luỹ tháng này
          <span className="ml-auto inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide px-[7px] py-[2px] rounded-full"
            style={{ background: "rgba(255,210,63,.16)", color: "#FFD23F" }}>
            <span className="w-[5px] h-[5px] rounded-full animate-pulse" style={{ background: "#FFD23F" }} />Realtime
          </span>
        </div>

        {/* big number */}
        <div className="relative mt-1 font-extrabold tracking-tight tabular-nums leading-[1.04] text-[44px]"
          style={{ color: "#FFD23F", textShadow: "0 3px 22px rgba(255,210,63,.28)" }}>
          {bigNum(earned)}<span className="text-[22px] opacity-75 ml-[2px]">₫</span>
        </div>

        {/* lên hạng bar */}
        {goal > 0 && (
          <div className="relative mt-[15px]">
            <div className="flex items-center justify-between text-[11px] mb-[6px]">
              <span className="text-[#EDEAF7]/85 font-semibold">
                {nextRank ? <>Lên hạng <b style={{ color: "#FFD23F" }}>{nextRank}</b></> : <>Đỉnh cao <b style={{ color: "#FFD23F" }}>Vô địch</b> 🏆</>}
              </span>
              <span className="font-mono font-bold" style={{ color: "#FFD23F" }}>{pct}%</span>
            </div>
            <div className="h-[9px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.12)" }}>
              <span className="block h-full rounded-full transition-[width] duration-700"
                style={{ width: pct + "%", background: "linear-gradient(90deg,#FFD23F,#F5A623)", boxShadow: "0 0 14px rgba(255,210,63,.5)" }} />
            </div>
          </div>
        )}

        {/* breakdown chips */}
        <div className="relative flex flex-wrap gap-[7px] mt-[15px]">
          {chips.map((x) => (
            <button key={x.label} onClick={onOpenBreak}
              className="inline-flex items-center gap-[5px] text-[11.5px] font-semibold px-[11px] py-[6px] rounded-full"
              style={{ color: x.color, background: x.bg }}>
              {x.label} <b className="font-mono">{x.minus ? "−" : "+"}{salShort(x.v)}</b>
            </button>
          ))}
        </div>

        {/* còn nhận */}
        <div className="relative flex items-baseline gap-3 mt-[18px] pt-4 border-t" style={{ borderColor: "rgba(255,255,255,.16)" }}>
          <span className="text-[12.5px] text-[#EDEAF7]/85">Còn nhận</span>
          <span className="font-extrabold text-[26px] tracking-tight tabular-nums text-white">{bigNum(net)}</span>
          <span className="ml-auto inline-flex items-center gap-[5px] text-[11.5px] text-[#EDEAF7]/85">
            {m.paid > 0
              ? <>Đã trả {salShort(m.paid)}</>
              : <><Flame size={13} style={{ color: "#FF7AA0" }} />Chuỗi {m.stats.streak}</>}
          </span>
        </div>
      </div>

      {/* ───── QUEST ROAD ───── */}
      {goal > 0 && (
        <div className="rounded-[24px] p-[18px]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
          <div className="flex items-center gap-[7px] text-[13px] font-bold text-[#EDEAF7] mb-[6px]">
            <Trophy size={15} style={{ color: "#FFD23F" }} />Chặng nhiệm vụ tháng
          </div>
          <div className="relative h-[8px] mt-[34px] mx-4 mb-2 rounded-full" style={{ background: "rgba(255,255,255,.1)" }}>
            <div className="absolute inset-0 rounded-full overflow-hidden">
              <span className="block h-full rounded-full" style={{ width: pct + "%", background: "linear-gradient(90deg,#FFD23F,#F5A623)", boxShadow: "0 0 12px rgba(255,210,63,.5)" }} />
            </div>
            {stops.map((s, i) => {
              const left = Math.min((s.v / goal) * 100, 100);
              const on = gross >= s.v;
              const last = i === stops.length - 1;
              return (
                <span key={i} className="absolute top-1/2 grid place-items-center rounded-full"
                  style={{
                    left: left + "%", transform: "translate(-50%,-50%)",
                    width: last ? 34 : 30, height: last ? 34 : 30,
                    background: on ? "#FFD23F" : "#2C2452",
                    color: on ? "#17132A" : "#FFD23F",
                    border: on ? "2px solid #221C3E" : "2px dashed rgba(255,210,63,.5)",
                  }}>
                  {on ? <Check size={14} strokeWidth={3} /> : <s.Icon size={last ? 16 : 14} />}
                </span>
              );
            })}
          </div>
          <div className="flex justify-between mt-4 text-[10px] text-[#EDEAF7]/55">
            {stops.map((s, i) => (
              <span key={i} className="text-center leading-[1.4]" style={i === stops.length - 1 && gross >= s.v ? { color: "#FFD23F" } : undefined}>
                {s.l}<br /><b className="font-mono text-[#EDEAF7]/80">{salShort(s.v)}</b>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-[7px] mt-4 px-[13px] py-[11px] rounded-[14px] text-[12px]"
            style={{ background: "rgba(255,210,63,.1)", color: "#FFE08A" }}>
            <Target size={14} style={{ color: "#FFD23F" }} />
            {nextStop
              ? <>Còn <b className="font-mono" style={{ color: "#FFD23F" }}>{salFmt(nextStop.v - gross)}</b> để đạt mốc <b style={{ color: "#FFD23F" }}>{nextStop.l}</b></>
              : <>Đã chinh phục mọi mốc tháng này! 🏆</>}
          </div>
        </div>
      )}

      {/* ───── ACHIEVEMENTS ───── */}
      <div className="grid grid-cols-2 gap-[11px]">
        {tiles.map((t, i) => (
          <div key={i} className="p-[15px] rounded-[20px]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
            <div className="flex items-center gap-[9px]">
              <span className="w-[36px] h-[36px] rounded-[11px] grid place-items-center" style={{ background: t.bg, color: t.fg }}>
                <t.Icon size={18} />
              </span>
              <span className="font-extrabold text-[22px] text-[#EDEAF7] tabular-nums">{t.v}</span>
            </div>
            <div className="text-[12px] font-bold text-[#EDEAF7] mt-[9px]">{t.l}</div>
            <div className="text-[11px] text-[#9A8FC4] mt-px truncate">{t.x}</div>
          </div>
        ))}
      </div>

      {/* ───── QUEST FEED ───── */}
      <div className="rounded-[24px] overflow-hidden" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
        <div className="flex items-center gap-[9px] px-[18px] py-[15px] border-b" style={{ borderColor: "#322A55" }}>
          <span className="w-[30px] h-[30px] rounded-[9px] grid place-items-center" style={{ background: "rgba(255,210,63,.14)", color: "#FFD23F" }}>
            <Zap size={16} />
          </span>
          <div className="text-[14px] font-bold text-[#EDEAF7]">Nhiệm vụ đã hoàn thành</div>
          <button onClick={onGoList} className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold" style={{ color: "#FFD23F" }}>
            Tất cả <ChevronRight size={13} strokeWidth={2.5} />
          </button>
        </div>
        {feed.length === 0 ? (
          <div className="px-5 py-6 text-center text-[13px] text-[#9A8FC4]">Chưa có nhiệm vụ nào tháng này.</div>
        ) : feed.map((r, i) => <FeedRow key={i} r={r} />)}
        {feed.length > 0 && (
          <div className="flex items-center gap-2 px-[18px] py-3 border-t text-[12px]"
            style={{ borderColor: "#322A55", background: "rgba(255,210,63,.07)", color: "#FFD23F" }}>
            <Sparkles size={13} />{feed.length} nhiệm vụ gần đây cộng <b className="font-mono">+{salShort(feedSum)}</b>
          </div>
        )}
      </div>

      {/* ───── CHART BUTTON ───── */}
      <button onClick={onOpenChart}
        className="w-full flex items-center gap-3 p-[18px] rounded-[20px] text-left"
        style={{ background: "#221C3E", border: "1px solid #322A55" }}>
        <span className="w-[38px] h-[38px] rounded-[11px] grid place-items-center" style={{ background: "rgba(255,210,63,.14)", color: "#FFD23F" }}>
          <BarChart3 size={19} />
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-bold text-[#EDEAF7]">Hành trình 6 tháng</div>
          <div className="text-[11.5px] text-[#9A8FC4]">So sánh thành tích các tháng</div>
        </div>
        <ChevronRight size={18} strokeWidth={2.5} style={{ color: "#9A8FC4" }} />
      </button>

      {/* nhảy nhanh sang Đầu tư (nếu có) */}
      {m.investment > 0 && (
        <button onClick={onGoInvest}
          className="w-full flex items-center gap-3 p-[18px] rounded-[20px] text-left"
          style={{ background: "radial-gradient(120% 130% at 90% -10%, #1f9d57 0%, transparent 60%), #1E3A2C", border: "1px solid rgba(52,211,153,.3)" }}>
          <span className="w-[38px] h-[38px] rounded-[11px] grid place-items-center" style={{ background: "rgba(255,255,255,.16)", color: "#fff" }}>
            <TrendingUp size={19} />
          </span>
          <div className="flex-1">
            <div className="text-[13.5px] font-bold text-white">Lợi nhuận đầu tư</div>
            <div className="text-[11.5px] text-[#CFEFDD]">{salFmt(m.investment)} · {m.investmentBy.length} toà nhà</div>
          </div>
          <ChevronRight size={18} strokeWidth={2.5} style={{ color: "rgba(255,255,255,.7)" }} />
        </button>
      )}
    </div>
  );
}

// ──────────────────────────── màn LIST (Nhiệm vụ) ────────────────────────────
function ListScreen({ m, period, onBack }: ScreenProps & { onBack: () => void }) {
  const rows = m.ledger;
  const total = rows.reduce((s, r) => s + (r.bonus_amount || 0), 0);
  return (
    <div className="px-[14px] pt-3 pb-6">
      <div className="flex items-center gap-3 px-1 pb-3">
        <button onClick={onBack} aria-label="Về Lương" className="w-9 h-9 rounded-[11px] grid place-items-center shrink-0"
          style={{ background: "#221C3E", border: "1px solid #322A55", color: "#EDEAF7" }}>
          <ChevronLeft size={18} strokeWidth={2.5} />
        </button>
        <div className="min-w-0">
          <div className="text-[16px] font-extrabold text-[#EDEAF7]">Nhật ký nhiệm vụ</div>
          <div className="text-[11.5px] text-[#9A8FC4]">{period.label}/{period.year} · {rows.length} nhiệm vụ</div>
        </div>
        <span className="ml-auto font-extrabold text-[18px] tabular-nums" style={{ color: "#FFD23F" }}>+{salShort(total)}</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-[18px] px-5 py-12 text-center text-[13px] text-[#9A8FC4]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
          Chưa có nhiệm vụ nào tháng này.
        </div>
      ) : (
        <div className="rounded-[18px] overflow-hidden" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
          {rows.map((r, i) => <FeedRow key={i} r={r} />)}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── màn INVEST (Đầu tư) ───────────────────────────
function InvestScreen({ m, period, onBack }: ScreenProps & { onBack: () => void }) {
  const list = m.investmentBy.slice().sort((a, b) => b.amount - a.amount);
  const max = Math.max.apply(null, list.map((x) => x.amount).concat(1));
  return (
    <div className="px-[14px] pt-3 pb-6">
      <div className="flex items-center gap-3 px-1 pb-3">
        <button onClick={onBack} aria-label="Về Lương" className="w-9 h-9 rounded-[11px] grid place-items-center shrink-0"
          style={{ background: "#221C3E", border: "1px solid #322A55", color: "#EDEAF7" }}>
          <ChevronLeft size={18} strokeWidth={2.5} />
        </button>
        <div className="min-w-0">
          <div className="text-[16px] font-extrabold text-[#EDEAF7]">Lợi nhuận đầu tư</div>
          <div className="text-[11.5px] text-[#9A8FC4]">Chia lợi nhuận cổ đông · {period.label}/{period.year}</div>
        </div>
      </div>

      {/* total hero */}
      <div className="relative rounded-[24px] overflow-hidden p-5"
        style={{ background: "radial-gradient(110% 130% at 92% -10%, #2C6E4E 0%, transparent 55%), #1E3A2C" }}>
        <div className="absolute inset-0 pointer-events-none opacity-60"
          style={{ backgroundImage: "radial-gradient(rgba(52,211,153,.1) 1px, transparent 1px)", backgroundSize: "15px 15px" }} />
        <div className="relative flex items-center gap-2 text-[12.5px] text-[#EDEAF7]/85">
          <TrendingUp size={15} style={{ color: "#5BD08E" }} />Tổng lợi nhuận đầu tư tháng này
        </div>
        <div className="relative mt-[5px] font-extrabold text-[38px] tracking-tight tabular-nums" style={{ color: "#7BE7AC" }}>
          {bigNum(m.investment)}<span className="text-[19px] opacity-70 ml-[2px]">₫</span>
        </div>
        <div className="relative flex gap-2 mt-[14px]">
          <span className="inline-flex items-center gap-[6px] text-[11.5px] font-semibold px-[11px] py-[6px] rounded-full" style={{ color: "#CFEFDD", background: "rgba(255,255,255,.1)" }}>
            <Trophy size={13} />{m.investmentBy.length} toà nhà
          </span>
          <span className="ml-auto inline-flex items-center gap-[5px] text-[10px] font-bold uppercase tracking-wide px-[9px] py-[6px] rounded-full"
            style={{ color: m.investmentLocked ? "#9DE7C0" : "#FFD23F", background: m.investmentLocked ? "rgba(52,211,153,.12)" : "rgba(255,210,63,.12)" }}>
            {m.investmentLocked ? <><Check size={12} strokeWidth={2.4} />Đã chốt</> : <>Chờ chốt</>}
          </span>
        </div>
      </div>

      <div className="text-[11px] font-bold uppercase tracking-wide text-[#9A8FC4] mt-[18px] mb-[9px] px-1">Lợi nhuận theo từng nhà</div>

      {list.length === 0 ? (
        <div className="rounded-[18px] px-5 py-10 text-center text-[13px] text-[#9A8FC4]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
          {m.investmentLocked ? "Chưa có phần đầu tư tháng này." : "Chờ chốt Lợi nhuận cổ đông tháng này."}
        </div>
      ) : (
        <div className="space-y-[10px]">
          {list.map((x, i) => (
            <div key={i} className="px-4 py-[14px] rounded-[18px]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
              <div className="flex items-center gap-[10px]">
                <span className="font-mono font-bold text-[13.5px] text-[#EDEAF7]">{x.b}</span>
                <span className="ml-auto font-mono font-bold text-[14px]" style={{ color: "#7BE7AC" }}>{salFmt(x.amount)}</span>
              </div>
              <div className="h-[8px] rounded-full overflow-hidden mt-[11px]" style={{ background: "rgba(255,255,255,.08)" }}>
                <span className="block h-full rounded-full" style={{ width: (x.amount / max * 100) + "%", background: "linear-gradient(90deg,#34D399,#16A34A)" }} />
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between px-[18px] py-[15px] rounded-[18px] mt-[14px]"
            style={{ background: "rgba(52,211,153,.1)", border: "1px solid rgba(52,211,153,.25)" }}>
            <span className="text-[12.5px] font-bold uppercase tracking-wide" style={{ color: "#9DE7C0" }}>Tổng lợi nhuận</span>
            <span className="font-mono font-bold text-[18px]" style={{ color: "#7BE7AC" }}>{salFmt(m.investment)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── bottom sheets ─────────────────────────────
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} className="absolute inset-0 z-40 flex items-end justify-center" style={{ background: "rgba(10,6,22,.62)" }}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full max-h-[88%] overflow-y-auto px-[18px] pt-2 pb-6 [&::-webkit-scrollbar]:hidden"
        style={{ background: "#221C3E", borderTop: "1px solid #3A3163", borderRadius: "28px 28px 0 0" }}>
        <div className="w-10 h-1 rounded-full mx-auto my-[6px] mb-[14px]" style={{ background: "rgba(255,255,255,.2)" }} />
        <div className="flex items-center justify-between mb-[14px]">
          <div className="text-[16px] font-extrabold text-[#EDEAF7]">{title}</div>
          <button onClick={onClose} className="w-8 h-8 rounded-[10px] grid place-items-center"
            style={{ background: "#17132A", border: "1px solid #322A55", color: "#9A8FC4" }}>
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ChartSheet({ m, onClose }: { m: SalManager; onClose: () => void }) {
  const data = m.trend || [];
  const max = Math.max.apply(null, data.map((d) => d.gross).concat(1)) * 1.1;
  const avg = data.length ? Math.round(data.reduce((s, d) => s + d.gross, 0) / data.length) : 0;
  const best = data.reduce((a, b) => (b.gross > a.gross ? b : a), data[0] || { gross: 0, label: "" });
  return (
    <Sheet title="Hành trình 6 tháng" onClose={onClose}>
      {data.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-[#9A8FC4]">Chưa có dữ liệu các tháng trước (chốt tháng để tích luỹ).</div>
      ) : (
        <>
          <div className="flex items-end gap-[14px] h-[180px] px-1">
            {data.map((d, i) => {
              const h = Math.max((d.gross / max) * 100, 3);
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-[7px] h-full justify-end">
                  <span className="font-mono text-[10px]" style={{ color: d.current ? "#FFD23F" : "#9A8FC4", fontWeight: d.current ? 700 : 400 }}>
                    {salShort(d.gross)}
                  </span>
                  <div className="w-[60%] max-w-[34px] rounded-t-[8px]"
                    style={{
                      height: h + "%",
                      background: d.current ? "linear-gradient(180deg,#FFD23F,#F5A623)" : "rgba(255,210,63,.22)",
                      boxShadow: d.current ? "0 0 16px rgba(255,210,63,.4)" : undefined,
                    }} />
                  <span className="text-[11px]" style={{ color: d.current ? "#FFD23F" : "#9A8FC4", fontWeight: d.current ? 800 : 400 }}>
                    T{d.label.replace(/^0/, "")}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-4 pt-[14px] border-t text-[12px] text-[#9A8FC4]" style={{ borderColor: "#322A55" }}>
            <span>Trung bình <b className="font-mono text-[#EDEAF7]">{salShort(avg)}</b></span>
            <span>Cao nhất <b className="font-mono" style={{ color: "#FFD23F" }}>{salShort(best.gross)}</b> 🏆</span>
          </div>
        </>
      )}
    </Sheet>
  );
}

function BreakSheet({ m, period, onClose }: ScreenProps & { onClose: () => void }) {
  const c = m.calc!;
  const net = c.takehome - m.paid;
  const bonusCount = m.ledger.filter((r) => (r.bonus_amount || 0) > 0).length;
  const rows = [
    { label: "Lương cứng", v: m.base, neg: false, color: "#EDEAF7" },
    { label: "Thưởng việc", note: `${bonusCount} việc`, v: c.bonus, neg: false, color: "#FFD23F" },
    { label: "Đầu tư", note: "LN cổ đông", v: m.investment, neg: false, color: "#34D399" },
    { label: "Hoa hồng Sale", v: m.commission, neg: false, color: "#EDEAF7" },
    { label: "Đã ứng trước", v: m.advance, neg: true, color: "#FF7AA0" },
    { label: "Tiền phòng", v: m.roomRent, neg: true, color: "#FF7AA0" },
    { label: "Đã trả", v: m.paid, neg: true, color: "#FF7AA0" },
  ].filter((r) => r.v > 0);
  return (
    <Sheet title={`Bóc tách thu nhập ${period.label}`} onClose={onClose}>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between py-[11px] border-b" style={{ borderColor: "rgba(50,42,85,.7)" }}>
          <span className="text-[13px]" style={{ color: r.neg ? "#FFB3C6" : "#EDEAF7" }}>
            {r.label}{r.note ? <span className="text-[11px] text-[#9A8FC4]"> · {r.note}</span> : null}
          </span>
          <span className="font-mono font-bold" style={{ color: r.color }}>{r.neg ? "−" : "+"}{salFmt(r.v)}</span>
        </div>
      ))}
      <div className="flex items-center justify-between mt-[14px] px-4 py-[14px] rounded-[16px]"
        style={{ background: "rgba(255,210,63,.1)", border: "1px solid rgba(255,210,63,.25)" }}>
        <span className="text-[13px] font-bold text-[#EDEAF7]">Còn nhận</span>
        <span className="font-extrabold text-[20px] tabular-nums" style={{ color: "#FFD23F" }}>{salFmt(net)}</span>
      </div>
    </Sheet>
  );
}

// ───────────────────────────── root component ─────────────────────────────
type ScreenKey = "home" | "list" | "invest";
const NAV: { key: ScreenKey; label: string; Icon: LucideIcon }[] = [
  { key: "home", label: "Lương", Icon: Wallet },
  { key: "list", label: "Nhiệm vụ", Icon: ListChecks },
  { key: "invest", label: "Đầu tư", Icon: TrendingUp },
];

export default function SalarySelfMobile({ m, period, onExit }: ScreenProps & { onExit?: () => void }) {
  const navigate = useNavigate();
  const [screen, setScreen] = useState<ScreenKey>("home");
  const [sheet, setSheet] = useState<"chart" | "break" | null>(null);
  const exit = onExit || (() => navigate(-1));

  // Shell chiếm trọn màn (web-app) — khoá cuộn nền site khi mở.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    // Stage: nền "bàn" tối, canh giữa khung điện thoại (giống .hl-stage / .tt-stage).
    <div className="fixed inset-0 z-[60] overflow-hidden flex justify-center"
      style={{ background: "radial-gradient(80% 50% at 50% 0%, #241a44 0%, transparent 55%), #0d0a1a" }}>
      <div className="relative w-full max-w-[440px] flex flex-col overflow-hidden"
        style={{ height: "100dvh", background: "radial-gradient(80% 30% at 50% 0%, #241a44 0%, transparent 55%), #17132A" }}>
        {/* body cuộn */}
        <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden"
          style={{ WebkitOverflowScrolling: "touch", paddingTop: "env(safe-area-inset-top)" }}>
          {screen === "home" && (
            <HomeScreen m={m} period={period} onExit={exit}
              onOpenChart={() => setSheet("chart")} onOpenBreak={() => setSheet("break")}
              onGoInvest={() => setScreen("invest")} onGoList={() => setScreen("list")} />
          )}
          {screen === "list" && <ListScreen m={m} period={period} onBack={() => setScreen("home")} />}
          {screen === "invest" && <InvestScreen m={m} period={period} onBack={() => setScreen("home")} />}
        </div>

        {/* bottom nav (Lương / Nhiệm vụ / Đầu tư) */}
        <nav className="shrink-0 flex items-stretch px-5 pt-[9px] backdrop-blur"
          style={{ background: "rgba(23,19,42,.92)", borderTop: "1px solid #322A55", paddingBottom: "calc(env(safe-area-inset-bottom) + 9px)" }}>
          {NAV.map((n) => {
            const on = screen === n.key;
            return (
              <button key={n.key} onClick={() => setScreen(n.key)}
                className="flex-1 flex flex-col items-center gap-1 bg-transparent border-0 cursor-pointer"
                style={{ color: on ? "#FFD23F" : "#7A6FA0" }}>
                <n.Icon size={22} />
                <span className="text-[10px] font-semibold">{n.label}</span>
              </button>
            );
          })}
        </nav>

        {sheet === "chart" && <ChartSheet m={m} onClose={() => setSheet(null)} />}
        {sheet === "break" && <BreakSheet m={m} period={period} onClose={() => setSheet(null)} />}
      </div>
    </div>
  );
}
