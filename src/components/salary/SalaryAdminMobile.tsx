// Tab "Quản trị viên" — bản MOBILE (QUEST). Import từ thiết kế claude.ai/design
// "Bảng lương quản lý - Mobile.dc.html": theme tối tím-vàng, 4 tab dưới đáy
// (Lương / Cá nhân / Bảng kê / Cấu hình). DÙNG CHUNG dữ liệu + callback với bản
// desktop (SalaryMonthly); chỉ khác cách trình bày. Rẽ nhánh desktop ↔ mobile
// bằng usePhoneViewport ở ManagerSalaryPage.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { todayISO } from "@/lib/collect";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Wallet, User, Zap, Settings, ChevronLeft, ChevronRight, RefreshCw, BarChart3,
  Lock, Unlock, HandCoins, X, Check, Info, AlertTriangle, Plus, Minus, Gift,
  Wrench, CalendarCheck, FileText, Banknote, TrendingUp, Trophy, Coins, type LucideIcon,
} from "lucide-react";
import { salFmt, salShort, bigNum } from "./salaryFormat";
import { useCountUp } from "./salaryCommon";
import SalaryConfig from "./SalaryConfig";
import SalarySelfMobile from "./SalarySelfMobile";
import { usePendingLeaveRequests, useApproveLeave, type PendingLeaveRequest } from "@/hooks/useMyDay";
import { isUnqualifiedContractRow, type SalManager, type SalAdjustment, type SalLedgerRow } from "@/lib/managerSalary";
import type { SalaryAccount, SalAdjustPayload } from "./SalaryMonthly";

// Ngày chi theo GIỜ LOCAL — toISOString() là UTC, chi lương lúc 00:00-07:00 VN
// sẽ rơi vào THÁNG TRƯỚC (audit 2026-07-20). Dùng helper canonical ở lib/collect.
const today = todayISO;
const parseNum = (s: string) => parseInt((s || "").replace(/\D/g, ""), 10) || 0;

interface AdminMobileProps {
  managers: SalManager[];
  period: { label: string; year: number };
  loading: boolean;
  locked: boolean;
  accounts: SalaryAccount[];
  canLock: boolean;
  canPay: boolean;
  canManageSalary: boolean;
  onSaveAdjustment: (staffId: string, payload: SalAdjustPayload) => void;
  onRemoveAdjustment: (adjId: string) => void;
  onPayout: (staffId: string, staffName: string, amount: number, accountId: string, voucherDate: string, note: string) => void;
  onBulkPayout: (rows: { staffId: string; staffName: string; amount: number }[], accountId: string) => void;
  onLock: () => void;
  onUnlock: () => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onRecompute: () => void;
}

// ───────────────────────── helpers chung ─────────────────────────
const avaTone = (m: SalManager) =>
  m.tone === "primary"
    ? { bg: "rgba(255,210,63,.16)", border: "#FFD23F", fg: "#FFD23F" }
    : { bg: "rgba(167,139,250,.16)", border: "#A78BFA", fg: "#C4B5FD" };

const remainOf = (m: SalManager) => (m.calc?.takehome ?? 0) - m.paid;
const isPaid = (m: SalManager) => remainOf(m) <= 0;
const pctOf = (m: SalManager) => (m.incomeGoal > 0 ? Math.round(((m.calc?.gross ?? 0) / m.incomeGoal) * 100) : 0);

const FEED_ICON: Record<string, LucideIcon> = {
  JOB: Wrench, DAY_BONUS: CalendarCheck, CONTRACT: FileText, CASH: Banknote,
};
const FEED_TONE: Record<string, { bg: string; fg: string }> = {
  JOB: { bg: "rgba(52,211,153,.16)", fg: "#34D399" },
  DAY_BONUS: { bg: "rgba(255,210,63,.16)", fg: "#FFD23F" },
  CONTRACT: { bg: "rgba(139,92,246,.2)", fg: "#A78BFA" },
  CASH: { bg: "rgba(154,143,196,.16)", fg: "#9A8FC4" },
};

// ───────────────────────── bottom sheet ─────────────────────────
function Sheet({ onClose, children, maxH = "88%" }: { onClose: () => void; children: React.ReactNode; maxH?: string }) {
  return (
    <div onClick={onClose} className="absolute inset-0 z-40 flex items-end justify-center" style={{ background: "rgba(10,6,22,.62)" }}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full overflow-y-auto px-[18px] pt-2 pb-6 [&::-webkit-scrollbar]:hidden"
        style={{ maxHeight: maxH, background: "#221C3E", borderTop: "1px solid #3A3163", borderRadius: "28px 28px 0 0" }}>
        <div className="w-10 h-1 rounded-full mx-auto my-[6px] mb-[14px]" style={{ background: "rgba(255,255,255,.2)" }} />
        {children}
      </div>
    </div>
  );
}

// input/select/textarea tối dùng chung
const fieldLabel = "block text-[11px] font-bold uppercase tracking-wide text-[#9A8FC4] mb-[6px]";
const darkInput: React.CSSProperties = {
  width: "100%", background: "#17132A", border: "1px solid #322A55", color: "#EDEAF7",
  borderRadius: 12, padding: "11px 13px", fontSize: 14, fontFamily: "inherit", outline: "none",
};

// 1 dòng bóc tách (nhãn trái · số tiền phải)
function DRow({ label, amount, color, neg }: { label: string; amount: number; color?: string; neg?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[11px] border-b" style={{ borderColor: "rgba(50,42,85,.7)" }}>
      <span className="text-[13px]" style={{ color: neg ? "#FFB3C6" : "#EDEAF7" }}>{label}</span>
      <span className="font-mono font-bold text-[13.5px] shrink-0" style={{ color: color || (neg ? "#FF7AA0" : "#EDEAF7") }}>
        {neg && amount > 0 ? "−" : ""}{salFmt(amount)}
      </span>
    </div>
  );
}

// ───────────────────────── header dùng chung ─────────────────────────
function AdminHeader({ period, onBack, onRecompute, onPrevMonth, onNextMonth, recomputing }: {
  period: { label: string; year: number }; onBack: () => void; onRecompute: () => void;
  onPrevMonth: () => void; onNextMonth: () => void; recomputing: boolean;
}) {
  return (
    <div className="flex items-center gap-[11px] px-4 pt-1.5 pb-3.5">
      <button onClick={onBack} aria-label="Quay lại" className="w-9 h-9 rounded-[13px] grid place-items-center shrink-0"
        style={{ background: "rgba(139,92,246,.18)", border: "2px solid #A78BFA", color: "#C4B5FD" }}>
        <ChevronLeft size={20} strokeWidth={2.5} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-extrabold text-[#EDEAF7] tracking-tight">Bảng lương quản lý</div>
        <div className="text-[11.5px] text-[#9A8FC4]">Quản trị viên · toàn đội</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button onClick={onRecompute} aria-label="Tính lại" className="w-8 h-8 rounded-full grid place-items-center"
          style={{ background: "rgba(255,255,255,.08)", color: "#9A8FC4" }}>
          <RefreshCw size={15} className={recomputing ? "animate-spin" : undefined} />
        </button>
        <div className="inline-flex items-center rounded-full" style={{ background: "rgba(255,210,63,.14)" }}>
          <button onClick={onPrevMonth} aria-label="Tháng trước" className="w-7 h-7 grid place-items-center" style={{ color: "#FFD23F" }}><ChevronLeft size={16} /></button>
          <span className="text-[11px] font-bold px-0.5 whitespace-nowrap" style={{ color: "#FFD23F" }}>{period.label}</span>
          <button onClick={onNextMonth} aria-label="Tháng sau" className="w-7 h-7 grid place-items-center" style={{ color: "#FFD23F" }}><ChevronRight size={16} /></button>
        </div>
      </div>
    </div>
  );
}

// ───────────────── loading (gaming) — đổi tháng vẫn ở trong shell tối ─────────────────
function LoadingScreen({ period, onBack, onRecompute, onPrevMonth, onNextMonth, recomputing }: {
  period: { label: string; year: number }; onBack: () => void; onRecompute: () => void;
  onPrevMonth: () => void; onNextMonth: () => void; recomputing: boolean;
}) {
  return (
    <div className="pb-5">
      <AdminHeader period={period} onBack={onBack} onRecompute={onRecompute} onPrevMonth={onPrevMonth} onNextMonth={onNextMonth} recomputing={recomputing} />
      <div className="relative mx-3.5 rounded-[28px] overflow-hidden p-8 flex flex-col items-center"
        style={{ background: "radial-gradient(110% 120% at 90% -10%, #5B3AA8 0%, transparent 55%), radial-gradient(100% 120% at -5% 115%, #7A4F12 0%, transparent 58%), #251C46" }}>
        <div className="absolute inset-0 pointer-events-none opacity-60"
          style={{ backgroundImage: "radial-gradient(rgba(255,210,63,.10) 1px, transparent 1px)", backgroundSize: "16px 16px" }} />
        <div className="relative w-[92px] h-[92px]">
          <svg className="animate-spin" width={92} height={92} viewBox="0 0 92 92" style={{ filter: "drop-shadow(0 0 10px rgba(255,210,63,.45))" }}>
            <circle cx={46} cy={46} r={40} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={8} />
            <circle cx={46} cy={46} r={40} fill="none" stroke="#FFD23F" strokeWidth={8} strokeLinecap="round" strokeDasharray="70 200" />
          </svg>
          <span className="absolute inset-0 grid place-items-center animate-pulse" style={{ color: "#FFD23F" }}><Coins size={30} /></span>
        </div>
        <div className="relative mt-4 text-[15px] font-extrabold" style={{ color: "#FFD23F" }}>Đang tính bảng lương…</div>
        <div className="relative mt-1 text-[12px]" style={{ color: "#9A8FC4" }}>{period.label} · {period.year}</div>
      </div>
      <div className="mx-3.5 mt-3.5 flex flex-col gap-[9px]">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[66px] rounded-[18px] animate-pulse"
            style={{ background: "#221C3E", border: "1px solid #322A55", animationDelay: `${i * 140}ms` }} />
        ))}
      </div>
    </div>
  );
}

function EmptyScreen({ period, onBack, onRecompute, onPrevMonth, onNextMonth, recomputing, canManageSalary, onGoConfig }: {
  period: { label: string; year: number }; onBack: () => void; onRecompute: () => void;
  onPrevMonth: () => void; onNextMonth: () => void; recomputing: boolean; canManageSalary: boolean; onGoConfig: () => void;
}) {
  return (
    <div className="pb-5">
      <AdminHeader period={period} onBack={onBack} onRecompute={onRecompute} onPrevMonth={onPrevMonth} onNextMonth={onNextMonth} recomputing={recomputing} />
      <div className="mx-3.5 mt-2 rounded-[24px] px-6 py-12 flex flex-col items-center text-center" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
        <span className="w-[60px] h-[60px] rounded-[18px] grid place-items-center mb-4" style={{ background: "rgba(255,210,63,.14)", color: "#FFD23F" }}><Wallet size={28} /></span>
        <div className="text-[15px] font-extrabold text-[#EDEAF7]">Chưa có quản lý hưởng lương</div>
        <div className="text-[12px] text-[#9A8FC4] mt-1.5 leading-[1.5]">Vào tab Cấu hình để thêm quản lý vào diện hưởng lương, đặt lương cứng và tiền phòng.</div>
        {canManageSalary && (
          <button onClick={onGoConfig} className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-bold rounded-[13px] px-5 py-2.5"
            style={{ color: "#17132A", background: "#FFD23F", border: "none" }}><Settings size={15} />Mở Cấu hình</button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── HOME (Lương) ─────────────────────────
function HomeScreen({ managers, period, locked, totals, metrics, canPay, canLock, recomputing, pendingLeaveCount, onBack, onRecompute, onPrevMonth, onNextMonth, onOpenBreakdown, onOpenBatch, onOpenClose, onOpenLeave }: {
  managers: SalManager[]; period: { label: string; year: number }; locked: boolean;
  totals: Totals; metrics: Metrics; canPay: boolean; canLock: boolean; recomputing: boolean; pendingLeaveCount: number;
  onBack: () => void; onRecompute: () => void; onPrevMonth: () => void; onNextMonth: () => void;
  onOpenBreakdown: (m: SalManager) => void; onOpenBatch: () => void; onOpenClose: () => void; onOpenLeave: () => void;
}) {
  const treasury = useCountUp(totals.take, [totals.take]);
  const { N, readyPct, doneSteps, unpaidCount, overCount, withGoalCount } = metrics;

  const chips = [
    { label: "Lương", v: totals.base, color: "#EDEAF7", bg: "rgba(255,255,255,.12)", minus: false },
    { label: "Đầu tư", v: totals.inv, color: "#9DE7C0", bg: "rgba(52,211,153,.18)", minus: false },
    { label: "Thưởng", v: totals.bonus, color: "#FFD23F", bg: "rgba(255,210,63,.16)", minus: false },
    { label: "HH", v: totals.com, color: "#C4B5FD", bg: "rgba(139,92,246,.22)", minus: false },
    { label: "Khấu trừ", v: totals.adv + totals.room, color: "#FFB3C6", bg: "rgba(255,122,160,.2)", minus: true },
  ].filter((c) => c.v > 0);

  const ranked = [...managers].sort((a, b) => pctOf(b) - pctOf(a));

  return (
    <div className="pb-5">
      <AdminHeader period={period} onBack={onBack} onRecompute={onRecompute} onPrevMonth={onPrevMonth} onNextMonth={onNextMonth} recomputing={recomputing} />

      {/* treasury hero */}
      <div className="relative mx-3.5 rounded-[28px] overflow-hidden p-[22px]"
        style={{ background: "radial-gradient(110% 120% at 90% -10%, #5B3AA8 0%, transparent 55%), radial-gradient(100% 120% at -5% 115%, #7A4F12 0%, transparent 58%), #251C46" }}>
        <div className="absolute inset-0 pointer-events-none opacity-60"
          style={{ backgroundImage: "radial-gradient(rgba(255,210,63,.10) 1px, transparent 1px)", backgroundSize: "16px 16px" }} />
        <div className="relative flex items-center gap-2 text-[12.5px] text-[#EDEAF7]/85">
          <BarChart3 size={15} style={{ color: "#FFD23F" }} />
          Tổng quỹ thực chi · {N} nhân sự
          <span className="ml-auto inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide px-[7px] py-[2px] rounded-full"
            style={locked ? { background: "rgba(52,211,153,.16)", color: "#7BE7AC" } : { background: "rgba(255,210,63,.16)", color: "#FFD23F" }}>
            {locked ? <><Lock size={10} />Đã chốt</> : <><span className="w-[5px] h-[5px] rounded-full animate-pulse" style={{ background: "#FFD23F" }} />Nháp</>}
          </span>
        </div>
        <div className="relative mt-1.5 font-extrabold tabular-nums leading-[1.04] text-[42px] tracking-tight"
          style={{ color: "#FFD23F", textShadow: "0 3px 22px rgba(255,210,63,.28)" }}>
          {bigNum(treasury)}<span className="text-[21px] opacity-75 ml-[2px]">₫</span>
        </div>

        <div className="relative flex flex-wrap gap-1.5 mt-3.5">
          {chips.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-[5px] text-[11px] font-semibold px-2.5 py-[5px] rounded-full"
              style={{ color: c.color, background: c.bg }}>
              {c.label} <b className="font-mono">{c.minus ? "−" : ""}{salShort(c.v)}</b>
            </span>
          ))}
        </div>

        {(canPay || canLock) && (
          <div className="relative flex gap-[9px] mt-[18px]">
            {canPay && (
              <button onClick={onOpenBatch} className="flex-1 inline-flex items-center justify-center gap-[7px] text-[13px] font-bold rounded-[13px] py-3"
                style={{ color: "#17132A", background: "#FFD23F", border: "none", boxShadow: "0 6px 18px rgba(255,210,63,.3)" }}>
                <HandCoins size={16} />Trả lương hàng loạt
              </button>
            )}
            {canLock && (
              <button onClick={onOpenClose} aria-label={locked ? "Mở khoá tháng" : "Chốt tháng"}
                className={(canPay ? "w-[46px]" : "flex-1 gap-[7px] text-[13px] font-bold") + " inline-flex items-center justify-center rounded-[13px] py-3"}
                style={{ color: "#9DE7C0", background: "rgba(52,211,153,.16)", border: "1px solid rgba(52,211,153,.3)" }}>
                {locked ? <Unlock size={18} /> : <Lock size={18} />}{!canPay && (locked ? "Mở khoá tháng" : "Chốt tháng")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* close progress */}
      <div className="flex items-center gap-3.5 mx-3.5 mt-3.5 px-4 py-[15px] rounded-[20px]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
        <ProgressRing pct={readyPct} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-[#EDEAF7]">Tiến độ chốt lương</div>
          <div className="text-[11px] text-[#9A8FC4] mt-0.5">
            {doneSteps}/3 bước · {unpaidCount > 0 ? <>còn <b style={{ color: "#FFD23F" }}>{unpaidCount} phiếu</b> chờ trả</> : <b style={{ color: "#7BE7AC" }}>đã trả đủ</b>}
            {!locked && doneSteps >= 2 ? " & chốt" : ""}
          </div>
        </div>
      </div>

      {/* đơn xin nghỉ chờ duyệt */}
      {pendingLeaveCount > 0 && (
        <button onClick={onOpenLeave}
          className="flex items-center gap-3.5 mx-3.5 mt-[9px] px-4 py-[15px] rounded-[20px] text-left"
          style={{ background: "rgba(255,210,63,.08)", border: "1px solid rgba(255,210,63,.28)" }}>
          <span className="w-[46px] h-[46px] rounded-full grid place-items-center shrink-0" style={{ background: "rgba(255,210,63,.16)", color: "#FFD23F" }}>
            <CalendarCheck size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-[#EDEAF7]">Đơn xin nghỉ chờ duyệt</div>
            <div className="text-[11px] text-[#9A8FC4] mt-0.5">Chạm để duyệt hoặc từ chối</div>
          </div>
          <span className="w-6 h-6 rounded-full grid place-items-center font-extrabold text-[12px] shrink-0" style={{ background: "#FFD23F", color: "#17132A" }}>{pendingLeaveCount}</span>
        </button>
      )}

      {/* team roster */}
      <div className="flex items-center justify-between mx-[18px] mt-[18px] mb-2.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-[#9A8FC4]">Đội của bạn · {N} người</span>
        {withGoalCount > 0 && <span className="text-[11px] font-bold" style={{ color: "#34D399" }}>{overCount}/{withGoalCount} vượt mục tiêu</span>}
      </div>
      <div className="mx-3.5 flex flex-col gap-[9px]">
        {ranked.map((m) => {
          const t = avaTone(m);
          const pct = pctOf(m);
          const ok = pct >= 100;
          const paid = isPaid(m);
          return (
            <button key={m.id} onClick={() => onOpenBreakdown(m)}
              className="flex items-center gap-3 px-[15px] py-[13px] rounded-[18px] text-left"
              style={{ background: "#221C3E", border: "1px solid #322A55" }}>
              <span className="relative w-10 h-10 rounded-full grid place-items-center font-extrabold text-[13px] shrink-0 tabular-nums"
                style={{ background: t.bg, border: `2px solid ${t.border}`, color: t.fg }}>
                {m.initials}
                <span className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 text-[8px] font-extrabold px-[5px] rounded-full"
                  style={{ color: "#17132A", background: t.border }}>{m.workdays}</span>
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-bold text-[#EDEAF7] truncate">{m.short}{m.alias ? <span className="text-[#9A8FC4] font-normal"> · {m.alias}</span> : null}</div>
                <div className="text-[11px] text-[#9A8FC4] truncate">{m.role}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono font-bold text-[14px]" style={{ color: paid ? "#9A8FC4" : "#7BE7AC" }}>{bigNum(m.calc?.takehome ?? 0)}</div>
                <div className="text-[10px] font-bold mt-px" style={{ color: m.incomeGoal > 0 ? (ok ? "#34D399" : "#FF9DB4") : "#9A8FC4" }}>
                  {m.incomeGoal > 0 ? <>{ok ? "↑" : "↓"} {pct}% mục tiêu</> : (paid ? "đã trả" : "chờ trả")}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 23, c = 2 * Math.PI * r;
  const off = useCountUp(c * (1 - Math.max(0, Math.min(pct, 100)) / 100), [pct]);
  return (
    <div className="relative w-[54px] h-[54px] shrink-0">
      <svg width={54} height={54}>
        <circle cx={27} cy={27} r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth={6} />
        <circle cx={27} cy={27} r={r} fill="none" stroke="#FFD23F" strokeWidth={6} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 27 27)" />
      </svg>
      <span className="absolute inset-0 grid place-items-center font-mono font-bold text-[14px]" style={{ color: "#FFD23F" }}>{pct}%</span>
    </div>
  );
}

// ───────────────────────── CÁ NHÂN (Member) — mở self-view y như nhân viên ─────────────────────────
// Chạm 1 người → mở SalarySelfMobile (đúng trải nghiệm "Lương của tôi" của NV).
function MemberScreen({ managers, onPick }: { managers: SalManager[]; onPick: (m: SalManager) => void }) {
  const ranked = [...managers].sort((a, b) => pctOf(b) - pctOf(a));
  return (
    <div className="pb-5">
      <div className="px-[18px] pt-2 pb-3">
        <div className="text-[18px] font-extrabold text-[#EDEAF7]">Bảng lương cá nhân</div>
        <div className="text-[11.5px] text-[#9A8FC4]">Mở bảng lương đúng như nhân viên tự xem</div>
      </div>
      <div className="mx-3.5 flex flex-col gap-[9px]">
        {ranked.map((m) => {
          const t = avaTone(m);
          const pct = pctOf(m);
          const ok = pct >= 100;
          const paid = isPaid(m);
          return (
            <button key={m.id} onClick={() => onPick(m)}
              className="flex items-center gap-3 px-[15px] py-[14px] rounded-[18px] text-left"
              style={{ background: "#221C3E", border: "1px solid #322A55" }}>
              <span className="relative w-11 h-11 rounded-full grid place-items-center font-extrabold text-[14px] shrink-0 tabular-nums"
                style={{ background: t.bg, border: `2px solid ${t.border}`, color: t.fg }}>
                {m.initials}
                <span className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 text-[8px] font-extrabold px-[5px] rounded-full"
                  style={{ color: "#17132A", background: t.border }}>{m.workdays}</span>
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-bold text-[#EDEAF7] truncate">{m.short}{m.alias ? <span className="text-[#9A8FC4] font-normal"> · {m.alias}</span> : null}</div>
                <div className="text-[11px] text-[#9A8FC4] truncate">{m.role} · {m.workdays} công</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono font-bold text-[14px]" style={{ color: paid ? "#9A8FC4" : "#7BE7AC" }}>{bigNum(m.calc?.takehome ?? 0)}</div>
                <div className="text-[10px] font-bold mt-px" style={{ color: m.incomeGoal > 0 ? (ok ? "#34D399" : "#FF9DB4") : "#9A8FC4" }}>
                  {m.incomeGoal > 0 ? <>{ok ? "↑" : "↓"} {pct}% mục tiêu</> : (paid ? "đã trả" : "chờ trả")}
                </div>
              </div>
              <ChevronRight size={18} strokeWidth={2.5} className="shrink-0" style={{ color: "#7A6FA0" }} />
            </button>
          );
        })}
      </div>
      <div className="mx-3.5 mt-3.5 flex items-center gap-2 px-3.5 py-3 rounded-[14px] text-[11.5px]"
        style={{ background: "rgba(167,139,250,.1)", border: "1px solid rgba(167,139,250,.22)", color: "#C4B5FD" }}>
        <Info size={14} className="shrink-0" />Chạm vào một người để xem bảng lương gamified y như nhân viên thấy.
      </div>
    </div>
  );
}

// ───────────────────────── BẢNG KÊ (Log) ─────────────────────────
function LogScreen({ ledger, managers, nameById, period }: {
  ledger: SalLedgerRow[]; managers: SalManager[]; nameById: Map<string, string>; period: { label: string; year: number };
}) {
  const [filter, setFilter] = useState<string | null>(null); // null = tất cả
  // Ẩn việc ký HĐ làm trong giờ — sai điều kiện từ đầu, không bao giờ có thưởng.
  const sorted = useMemo(
    () => ledger.filter((r) => !isUnqualifiedContractRow(r)).sort((a, b) => (a.occurred_date < b.occurred_date ? 1 : -1)),
    [ledger],
  );
  const rows = useMemo(() => (filter ? sorted.filter((r) => r.staff_id === filter) : sorted), [sorted, filter]);
  const total = rows.reduce((s, r) => s + (r.bonus_amount || 0), 0);
  const ranked = [...managers].sort((a, b) => pctOf(b) - pctOf(a));
  const filterName = filter ? (nameById.get(filter) || "") : "Toàn đội";
  return (
    <div className="px-3.5 pt-2 pb-5">
      <div className="flex items-center gap-3 px-1 pb-3">
        <div className="flex-1 min-w-0">
          <div className="text-[18px] font-extrabold text-[#EDEAF7]">Bảng kê công việc</div>
          <div className="text-[11.5px] text-[#9A8FC4]">{filterName} · {period.label}/{period.year} · {rows.length} việc</div>
        </div>
        <span className="font-mono font-extrabold text-[17px] shrink-0" style={{ color: "#FFD23F" }}>+{salShort(total)}</span>
      </div>

      {/* lọc theo nhân viên — mặc định "Tất cả" */}
      <div className="flex gap-2 overflow-x-auto pb-3 px-1 [&::-webkit-scrollbar]:hidden">
        <button onClick={() => setFilter(null)} className="shrink-0 text-[12px] font-semibold px-3.5 py-1.5 rounded-full"
          style={filter === null ? { color: "#17132A", background: "#FFD23F", border: "none" } : { color: "#CFC9E0", background: "#221C3E", border: "1px solid #322A55" }}>
          Tất cả
        </button>
        {ranked.map((m) => {
          const on = filter === m.id;
          const t = avaTone(m);
          return (
            <button key={m.id} onClick={() => setFilter(m.id)} className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-full"
              style={on ? { color: "#17132A", background: t.border, border: "none" } : { color: "#CFC9E0", background: "#221C3E", border: "1px solid #322A55" }}>
              <span className="w-4 h-4 rounded-full grid place-items-center text-[8px] font-extrabold"
                style={on ? { background: "rgba(0,0,0,.18)", color: "#17132A" } : { background: t.bg, color: t.fg }}>{m.initials}</span>
              {m.short}
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-[18px] px-5 py-12 text-center text-[13px] text-[#9A8FC4]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
          Chưa có việc nào tháng này.
        </div>
      ) : (
        <div className="flex flex-col gap-[9px]">
          {rows.map((r, i) => {
            const tone = FEED_TONE[r.item_type] || FEED_TONE.CASH;
            const Icon = FEED_ICON[r.item_type] || Banknote;
            const who = nameById.get(r.staff_id) || "";
            const sub = [who, r.occurred_date?.slice(5), r.place].filter(Boolean).join(" · ");
            return (
              <div key={i} className="flex items-center gap-3 px-[15px] py-[13px] rounded-[16px]" style={{ background: "#221C3E", border: "1px solid #322A55" }}>
                <span className="w-[34px] h-[34px] rounded-[10px] grid place-items-center shrink-0" style={{ background: tone.bg, color: tone.fg }}><Icon size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-[#EDEAF7] truncate">{r.content}</div>
                  <div className="text-[11px] text-[#9A8FC4] truncate">{sub || "—"}{r.day_label ? <span style={{ color: "#FF7AA0" }}> · {r.day_label}</span> : null}</div>
                </div>
                {r.bonus_amount == null ? (
                  <span className="font-mono text-[12px] font-semibold text-[#9A8FC4] shrink-0">Không tính</span>
                ) : (
                  <span className="font-mono font-bold text-[13px] shrink-0" style={{ color: "#34D399" }}>+{salShort(r.bonus_amount)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── CẤU HÌNH (Config) ─────────────────────────
function ConfigScreen() {
  return (
    <div className="pb-5">
      <div className="px-[18px] pt-2 pb-3">
        <div className="text-[18px] font-extrabold text-[#EDEAF7]">Cấu hình lương</div>
        <div className="text-[11.5px] text-[#9A8FC4]">Quy tắc tính lương toàn đội</div>
      </div>
      {/* SalaryConfig vốn theme sáng (.sal-root) — đặt trên nền sáng để đọc/sửa được đầy đủ. */}
      <div className="sal-root mx-3.5 rounded-[20px] overflow-hidden" style={{ background: "hsl(var(--background))", padding: 12 }}>
        <SalaryConfig />
      </div>
    </div>
  );
}

// ───────────────────────── SHEETS ─────────────────────────
function BreakdownSheet({ m, canPay, locked, onClose, onPayout, onAdjust, onGoLog }: {
  m: SalManager; canPay: boolean; locked: boolean; onClose: () => void;
  onPayout: () => void; onAdjust: () => void; onGoLog: () => void;
}) {
  const c = m.calc!;
  const t = avaTone(m);
  const remain = remainOf(m);
  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center gap-2.5 mb-3.5">
        <span className="w-10 h-10 rounded-full grid place-items-center font-extrabold text-[13px] tabular-nums"
          style={{ background: t.bg, border: `2px solid ${t.border}`, color: t.fg }}>{m.initials}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-extrabold text-[#EDEAF7] truncate">{m.short}{m.alias ? ` · ${m.alias}` : ""}</div>
          <div className="text-[11px] text-[#9A8FC4]">{m.role} · {m.workdays} công</div>
        </div>
        <button onClick={onClose} className="w-8 h-8 rounded-[10px] grid place-items-center" style={{ background: "#17132A", border: "1px solid #322A55", color: "#9A8FC4" }}><X size={16} strokeWidth={2.5} /></button>
      </div>
      <DRow label="Lương tháng" amount={m.base} />
      <DRow label="Thưởng việc" amount={c.bonus} color="#FFD23F" />
      <DRow label="Lợi nhuận đầu tư" amount={m.investment} color="#34D399" />
      <DRow label="Hoa hồng Sale" amount={m.commission} color="#C4B5FD" />
      <DRow label="Đã ứng" amount={m.advance} neg />
      <DRow label="Tiền phòng" amount={m.roomRent} neg />
      <div className="flex items-center justify-between mt-3 px-4 py-3.5 rounded-[16px]" style={{ background: "rgba(255,210,63,.1)", border: "1px solid rgba(255,210,63,.25)" }}>
        <span className="text-[13px] font-bold text-[#EDEAF7]">Thực nhận{remain !== c.takehome ? ` · còn ${salShort(remain)}` : ""}</span>
        <span className="font-extrabold text-[20px]" style={{ color: "#FFD23F" }}>{salFmt(c.takehome)}</span>
      </div>
      <div className="flex gap-2.5 mt-3.5">
        <button onClick={onGoLog} className="flex-1 inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold rounded-[13px] py-3"
          style={{ background: "#17132A", border: "1px solid #322A55", color: "#FFD23F" }}><Zap size={14} />Bảng kê</button>
        {!locked && (
          <button onClick={onAdjust} className="flex-1 inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold rounded-[13px] py-3"
            style={{ background: "#17132A", border: "1px solid #322A55", color: "#EDEAF7" }}><Gift size={14} />Thưởng / trừ</button>
        )}
      </div>
      {canPay && remain > 0 && (
        <button onClick={onPayout} className="w-full mt-2.5 inline-flex items-center justify-center gap-1.5 text-[13.5px] font-bold rounded-[13px] py-3.5"
          style={{ color: "#17132A", background: "#FFD23F", border: "none" }}><HandCoins size={16} />Trả lương</button>
      )}
    </Sheet>
  );
}

function PayoutSheet({ m, accounts, period, onClose, onSave }: {
  m: SalManager; accounts: SalaryAccount[]; period: { label: string; year: number };
  onClose: () => void; onSave: (amount: number, accountId: string, voucherDate: string, note: string) => void;
}) {
  const remain = Math.max(remainOf(m), 0);
  const [amount, setAmount] = useState(String(remain));
  const [acc, setAcc] = useState(accounts[0]?.id || "");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState(`Lương ${period.label}/${period.year}`);
  const numVal = parseNum(amount);
  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center gap-2.5 mb-3.5">
        <span className="w-10 h-10 rounded-[12px] grid place-items-center" style={{ background: "rgba(255,210,63,.16)", color: "#FFD23F" }}><HandCoins size={20} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-extrabold text-[#EDEAF7]">Trả lương</div>
          <div className="text-[11px] text-[#9A8FC4] truncate">{m.short} · còn nhận {salFmt(remain)}</div>
        </div>
        <button onClick={onClose} className="w-8 h-8 rounded-[10px] grid place-items-center" style={{ background: "#17132A", border: "1px solid #322A55", color: "#9A8FC4" }}><X size={16} strokeWidth={2.5} /></button>
      </div>
      <div className="space-y-3">
        <div>
          <label className={fieldLabel}>Số tiền</label>
          <input style={{ ...darkInput, fontFamily: "'Space Mono',monospace" }} inputMode="numeric"
            value={numVal ? numVal.toLocaleString("vi-VN") : amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label className={fieldLabel}>Chi từ sổ quỹ</label>
          <select style={darkInput} value={acc} onChange={(e) => setAcc(e.target.value)}>
            {accounts.length === 0 ? <option value="">— Chưa có sổ quỹ —</option> : accounts.map((b) => <option key={b.id} value={b.id} style={{ color: "#000" }}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className={fieldLabel}>Ngày chi</label>
          <input type="date" style={{ ...darkInput, fontFamily: "'Space Mono',monospace", colorScheme: "dark" }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className={fieldLabel}>Ghi chú</label>
          <textarea style={{ ...darkInput, minHeight: 60, resize: "none" }} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex items-start gap-2 text-[11.5px] text-[#9A8FC4]"><Info size={14} className="mt-0.5 shrink-0" />Tạo phiếu chi trong sổ thu chi — không tính KQKD.</div>
      </div>
      <div className="flex gap-2.5 mt-4">
        <button onClick={onClose} className="flex-1 text-[13.5px] font-semibold rounded-[13px] py-3" style={{ color: "#CFC9E0", background: "#17132A", border: "1px solid #322A55" }}>Huỷ</button>
        <button disabled={!numVal || !acc} onClick={() => { onSave(numVal, acc, date, note); onClose(); }}
          className="inline-flex items-center justify-center gap-1.5 text-[13.5px] font-bold rounded-[13px] py-3" style={{ flex: 1.5, color: "#17132A", background: "#FFD23F", border: "none", opacity: !numVal || !acc ? 0.5 : 1 }}>
          <Check size={16} />Ghi phiếu chi
        </button>
      </div>
    </Sheet>
  );
}

function BatchSheet({ managers, accounts, period, onClose, onSave }: {
  managers: SalManager[]; accounts: SalaryAccount[]; period: { label: string; year: number };
  onClose: () => void; onSave: (rows: { staffId: string; staffName: string; amount: number }[], accountId: string) => void;
}) {
  const rows = managers.map((m) => ({ m, remain: remainOf(m) })).filter((r) => r.remain > 0);
  const total = rows.reduce((s, r) => s + r.remain, 0);
  const [acc, setAcc] = useState(accounts[0]?.id || "");
  return (
    <Sheet onClose={onClose}>
      <span className="w-[50px] h-[50px] rounded-[15px] grid place-items-center mb-3.5" style={{ background: "rgba(255,210,63,.16)", color: "#FFD23F" }}><HandCoins size={25} /></span>
      <div className="text-[17px] font-extrabold text-[#EDEAF7]">Trả lương hàng loạt?</div>
      <div className="text-[12.5px] text-[#9A8FC4] mt-1.5">{rows.length === 0 ? "Tất cả đã được trả đủ." : <>Tạo phiếu chi cho <b style={{ color: "#EDEAF7" }}>{rows.length} nhân sự</b>, tổng thực chi:</>}</div>
      {rows.length > 0 && <div className="font-extrabold text-[27px] mt-1.5 mb-2" style={{ color: "#FFD23F" }}>{salFmt(total)}</div>}

      {rows.length > 0 && (
        <div className="mt-1 mb-3.5 max-h-[180px] overflow-y-auto [&::-webkit-scrollbar]:hidden">
          {rows.map((r) => {
            const t = avaTone(r.m);
            return (
              <div key={r.m.id} className="flex items-center gap-3 py-2.5 border-b last:border-b-0" style={{ borderColor: "rgba(50,42,85,.6)" }}>
                <span className="w-8 h-8 rounded-full grid place-items-center font-extrabold text-[12px] tabular-nums" style={{ background: t.bg, border: `2px solid ${t.border}`, color: t.fg }}>{r.m.initials}</span>
                <span className="flex-1 text-[13px] font-semibold text-[#EDEAF7] truncate">{r.m.short}</span>
                <span className="font-mono font-bold text-[13.5px]" style={{ color: "#7BE7AC" }}>{salFmt(r.remain)}</span>
              </div>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mb-2">
          <label className={fieldLabel}>Chi từ sổ quỹ</label>
          <select style={darkInput} value={acc} onChange={(e) => setAcc(e.target.value)}>
            {accounts.length === 0 ? <option value="">— Chưa có sổ quỹ —</option> : accounts.map((b) => <option key={b.id} value={b.id} style={{ color: "#000" }}>{b.name}</option>)}
          </select>
        </div>
      )}

      <div className="flex gap-2.5 mt-3.5">
        <button onClick={onClose} className="flex-1 text-[13.5px] font-semibold rounded-[13px] py-3" style={{ color: "#CFC9E0", background: "#17132A", border: "1px solid #322A55" }}>Huỷ</button>
        <button disabled={!rows.length || !acc} onClick={() => { onSave(rows.map((r) => ({ staffId: r.m.id, staffName: r.m.short, amount: r.remain })), acc); onClose(); }}
          className="inline-flex items-center justify-center gap-1.5 text-[13.5px] font-bold rounded-[13px] py-3" style={{ flex: 1.5, color: "#17132A", background: "#FFD23F", border: "none", opacity: !rows.length || !acc ? 0.5 : 1 }}>
          <Check size={16} />Xác nhận trả
        </button>
      </div>
    </Sheet>
  );
}

function AdjustSheet({ m, edit, onClose, onSave }: {
  m: SalManager; edit?: SalAdjustment | null; onClose: () => void; onSave: (p: SalAdjustPayload) => void;
}) {
  const [kind, setKind] = useState<"Thưởng" | "Trừ">(edit ? (edit.amount < 0 ? "Trừ" : "Thưởng") : "Thưởng");
  const [label, setLabel] = useState(edit ? edit.label : "");
  const [amount, setAmount] = useState(edit ? String(Math.abs(edit.amount)) : "");
  const [note, setNote] = useState(edit?.note || "");
  const numVal = parseNum(amount);
  const ok = !!label.trim() && !!numVal;
  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center gap-2.5 mb-3.5">
        <span className="w-10 h-10 rounded-[12px] grid place-items-center" style={{ background: "rgba(255,210,63,.16)", color: "#FFD23F" }}><Gift size={20} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-extrabold text-[#EDEAF7]">{edit ? "Sửa thưởng / trừ" : "Thêm thưởng / trừ"}</div>
          <div className="text-[11px] text-[#9A8FC4] truncate">{m.short}</div>
        </div>
        <button onClick={onClose} className="w-8 h-8 rounded-[10px] grid place-items-center" style={{ background: "#17132A", border: "1px solid #322A55", color: "#9A8FC4" }}><X size={16} strokeWidth={2.5} /></button>
      </div>
      <div className="space-y-3">
        <div>
          <label className={fieldLabel}>Loại</label>
          <div className="flex gap-2">
            <button onClick={() => setKind("Thưởng")} className="flex-1 inline-flex items-center justify-center gap-1.5 text-[13px] font-bold rounded-[11px] py-2.5"
              style={kind === "Thưởng" ? { color: "#17132A", background: "#34D399", border: "none" } : { color: "#7BE7AC", background: "#17132A", border: "1px solid #322A55" }}><Plus size={15} />Thưởng</button>
            <button onClick={() => setKind("Trừ")} className="flex-1 inline-flex items-center justify-center gap-1.5 text-[13px] font-bold rounded-[11px] py-2.5"
              style={kind === "Trừ" ? { color: "#17132A", background: "#FF7AA0", border: "none" } : { color: "#FFB3C6", background: "#17132A", border: "1px solid #322A55" }}><Minus size={15} />Trừ</button>
          </div>
        </div>
        <div>
          <label className={fieldLabel}>Nội dung</label>
          <input style={darkInput} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="VD: Bonus QL, hỗ trợ xăng…" autoFocus />
        </div>
        <div>
          <label className={fieldLabel}>Số tiền</label>
          <input style={{ ...darkInput, fontFamily: "'Space Mono',monospace" }} inputMode="numeric"
            value={numVal ? numVal.toLocaleString("vi-VN") : amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </div>
        <div>
          <label className={fieldLabel}>Ghi chú</label>
          <textarea style={{ ...darkInput, minHeight: 60, resize: "none" }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tuỳ chọn…" />
        </div>
      </div>
      <div className="flex gap-2.5 mt-4">
        <button onClick={onClose} className="flex-1 text-[13.5px] font-semibold rounded-[13px] py-3" style={{ color: "#CFC9E0", background: "#17132A", border: "1px solid #322A55" }}>Huỷ</button>
        <button disabled={!ok} onClick={() => { onSave({ id: edit?.id, kind: kind === "Trừ" ? "DEDUCTION" : "BONUS", label: label.trim(), amount: numVal, note: note.trim() || null }); onClose(); }}
          className="inline-flex items-center justify-center gap-1.5 text-[13.5px] font-bold rounded-[13px] py-3" style={{ flex: 1.5, color: "#17132A", background: "#FFD23F", border: "none", opacity: ok ? 1 : 0.5 }}>
          <Check size={16} />Lưu
        </button>
      </div>
    </Sheet>
  );
}

function CloseSheet({ locked, period, unpaidCount, onClose, onConfirm }: {
  locked: boolean; period: { label: string; year: number }; unpaidCount: number; onClose: () => void; onConfirm: () => void;
}) {
  return (
    <Sheet onClose={onClose}>
      <span className="w-[50px] h-[50px] rounded-[15px] grid place-items-center mb-3.5"
        style={locked ? { background: "rgba(255,210,63,.16)", color: "#FFD23F" } : { background: "rgba(52,211,153,.16)", color: "#34D399" }}>
        {locked ? <Unlock size={25} /> : <Lock size={25} />}
      </span>
      <div className="text-[17px] font-extrabold text-[#EDEAF7]">{locked ? `Mở khoá tháng ${period.label}?` : `Chốt & khoá tháng ${period.label}?`}</div>
      <div className="text-[12.5px] text-[#9A8FC4] mt-1.5 leading-[1.5]">
        {locked
          ? "Mở khoá cho phép sửa lại số liệu. Mọi thay đổi việc/HĐ cũ sẽ lại ảnh hưởng tháng này."
          : <>Sau khi chốt sẽ <b style={{ color: "#FFB3C6" }}>không thể chỉnh sửa</b>. Hệ thống tính lần cuối và đóng băng toàn bộ bảng lương.</>}
      </div>
      {!locked && unpaidCount > 0 && (
        <div className="flex items-center gap-2 my-3.5 px-3 py-2.5 rounded-[13px] text-[11.5px]" style={{ background: "rgba(255,122,160,.1)", border: "1px solid rgba(255,122,160,.22)", color: "#FFB3C6" }}>
          <AlertTriangle size={15} className="shrink-0" />Còn {unpaidCount} phiếu chưa trả — nên trả lương trước khi chốt.
        </div>
      )}
      <div className="flex gap-2.5 mt-3.5">
        <button onClick={onClose} className="flex-1 text-[13.5px] font-semibold rounded-[13px] py-3" style={{ color: "#CFC9E0", background: "#17132A", border: "1px solid #322A55" }}>Huỷ</button>
        <button onClick={() => { onConfirm(); onClose(); }}
          className="inline-flex items-center justify-center gap-1.5 text-[13.5px] font-bold rounded-[13px] py-3"
          style={{ flex: 1.5, color: "#17132A", background: locked ? "#FFD23F" : "#34D399", border: "none" }}>
          {locked ? <><Unlock size={16} />Mở khoá</> : <><Lock size={16} />Vẫn chốt</>}
        </button>
      </div>
    </Sheet>
  );
}

// ───────────────────────── ĐƠN XIN NGHỈ (Sheet) ─────────────────────────
function LeaveSheet({ rows, decidingKey, onClose, onDecide }: {
  rows: PendingLeaveRequest[]; decidingKey: string | null; onClose: () => void;
  onDecide: (userId: string, workDate: string, approve: boolean) => void;
}) {
  const dmy = (iso: string) => { const [, m, d] = iso.split("-"); return `${d}/${m}`; };
  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center gap-2.5 mb-3.5">
        <span className="w-10 h-10 rounded-[12px] grid place-items-center" style={{ background: "rgba(255,210,63,.16)", color: "#FFD23F" }}><CalendarCheck size={20} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-extrabold text-[#EDEAF7]">Đơn xin nghỉ có lương</div>
          <div className="text-[11px] text-[#9A8FC4]">{rows.length} đơn đang chờ duyệt</div>
        </div>
        <button onClick={onClose} className="w-8 h-8 rounded-[10px] grid place-items-center" style={{ background: "#17132A", border: "1px solid #322A55", color: "#9A8FC4" }}><X size={16} strokeWidth={2.5} /></button>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-[16px] px-5 py-10 text-center text-[13px] text-[#9A8FC4]" style={{ background: "#17132A", border: "1px solid #322A55" }}>
          Không còn đơn nào chờ duyệt.
        </div>
      ) : (
        <div className="flex flex-col gap-[9px]">
          {rows.map((r) => {
            const key = `${r.user_id}-${r.work_date}`;
            const pending = decidingKey === key;
            return (
              <div key={key} className="px-[15px] py-[13px] rounded-[16px]" style={{ background: "#17132A", border: "1px solid #322A55" }}>
                <div className="text-[13.5px] font-bold text-[#EDEAF7] truncate">{r.staff_name}</div>
                <div className="text-[11px] text-[#9A8FC4] truncate mt-0.5">Ngày {dmy(r.work_date)}{r.reason ? " · " + r.reason : ""}</div>
                <div className="flex gap-2 mt-2.5">
                  <button disabled={pending} onClick={() => onDecide(r.user_id, r.work_date, false)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold rounded-[11px] py-2.5"
                    style={{ color: "#FFB3C6", background: "rgba(255,122,160,.12)", border: "1px solid rgba(255,122,160,.28)", opacity: pending ? .6 : 1 }}>
                    <X size={14} />Từ chối
                  </button>
                  <button disabled={pending} onClick={() => onDecide(r.user_id, r.work_date, true)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 text-[12.5px] font-bold rounded-[11px] py-2.5"
                    style={{ color: "#17132A", background: "#FFD23F", border: "none", opacity: pending ? .6 : 1 }}>
                    <Check size={14} />Duyệt
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

// ───────────────────────── root ─────────────────────────
type Tab = "home" | "member" | "log" | "config";
type SheetState =
  | { kind: "breakdown"; m: SalManager }
  | { kind: "payout"; m: SalManager }
  | { kind: "adjust"; m: SalManager; edit?: SalAdjustment | null }
  | { kind: "batch" }
  | { kind: "close" }
  | { kind: "leave" }
  | null;

interface Totals { base: number; bonus: number; inv: number; com: number; gross: number; adv: number; room: number; take: number; }
interface Metrics { N: number; readyPct: number; doneSteps: number; unpaidCount: number; paidCount: number; overCount: number; withGoalCount: number; }

const NAV: { key: Tab; label: string; Icon: LucideIcon }[] = [
  { key: "home", label: "Lương", Icon: Wallet },
  { key: "member", label: "Cá nhân", Icon: User },
  { key: "log", label: "Bảng kê", Icon: Zap },
  { key: "config", label: "Cấu hình", Icon: Settings },
];

export default function SalaryAdminMobile(props: AdminMobileProps) {
  const { managers, period, loading, locked, accounts, canLock, canPay, canManageSalary,
    onSaveAdjustment, onPayout, onBulkPayout, onLock, onUnlock,
    onPrevMonth, onNextMonth, onRecompute } = props;
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("home");
  const [sheet, setSheet] = useState<SheetState>(null);
  const [selfMember, setSelfMember] = useState<SalManager | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const recomputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: pendingLeaves = [] } = usePendingLeaveRequests();
  const approveLeave = useApproveLeave();
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const onDecideLeave = (userId: string, workDate: string, approve: boolean) => {
    const key = `${userId}-${workDate}`;
    setDecidingKey(key);
    approveLeave.mutate({ user: userId, date: workDate, approve }, {
      onSuccess: () => toast.success(approve ? "Đã duyệt phép" : "Đã từ chối phép"),
      onError: (e: any) => toast.error(e?.message || "Có lỗi xảy ra, thử lại"),
      onSettled: () => setDecidingKey(null),
    });
  };

  // Shell chiếm trọn màn (web-app) — khoá cuộn nền site khi mở.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    };
  }, []);

  const handleRecompute = () => {
    onRecompute();
    setRecomputing(true);
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    recomputeTimer.current = setTimeout(() => setRecomputing(false), 900);
  };

  const totals: Totals = useMemo(() => managers.reduce((t, m) => {
    const c = m.calc!;
    t.base += m.base; t.bonus += c.bonus; t.inv += m.investment; t.com += m.commission;
    t.gross += c.gross; t.adv += m.advance; t.room += m.roomRent; t.take += c.takehome; return t;
  }, { base: 0, bonus: 0, inv: 0, com: 0, gross: 0, adv: 0, room: 0, take: 0 }), [managers]);

  const metrics: Metrics = useMemo(() => {
    const N = managers.length;
    const paidCount = managers.filter(isPaid).length;
    const withGoal = managers.filter((m) => m.incomeGoal > 0);
    const overCount = withGoal.filter((m) => pctOf(m) >= 100).length;
    const stepPaid = N > 0 && paidCount === N;
    const doneSteps = 1 + (stepPaid ? 1 : 0) + (locked ? 1 : 0);
    return { N, paidCount, unpaidCount: N - paidCount, overCount, withGoalCount: withGoal.length,
      doneSteps, readyPct: Math.round((doneSteps / 3) * 100) };
  }, [managers, locked]);

  const ledger = useMemo(() => managers.flatMap((m) => m.ledger), [managers]);
  const nameById = useMemo(() => new Map(managers.map((m) => [m.id, m.short])), [managers]);

  const headerNav = { onBack: () => navigate(-1), onRecompute: handleRecompute, onPrevMonth, onNextMonth, recomputing };

  return (
    <div className="fixed inset-0 z-[60] overflow-hidden flex justify-center"
      style={{ background: "radial-gradient(80% 50% at 50% 0%, #241a44 0%, transparent 55%), #0d0a1a" }}>
      <div className="relative w-full max-w-[440px] flex flex-col overflow-hidden"
        style={{ height: "100dvh", background: "radial-gradient(80% 30% at 50% 0%, #241a44 0%, transparent 55%), #17132A" }}>
        <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden"
          style={{ WebkitOverflowScrolling: "touch", paddingTop: "env(safe-area-inset-top)" }}>
          {loading ? (
            <LoadingScreen period={period} {...headerNav} />
          ) : managers.length === 0 && tab !== "config" && pendingLeaves.length === 0 ? (
            <EmptyScreen period={period} {...headerNav} canManageSalary={canManageSalary} onGoConfig={() => setTab("config")} />
          ) : tab === "home" ? (
            <HomeScreen managers={managers} period={period} locked={locked} totals={totals} metrics={metrics}
              canPay={canPay} canLock={canLock} recomputing={recomputing} pendingLeaveCount={pendingLeaves.length}
              onBack={headerNav.onBack} onRecompute={handleRecompute} onPrevMonth={onPrevMonth} onNextMonth={onNextMonth}
              onOpenBreakdown={(m) => setSheet({ kind: "breakdown", m })}
              onOpenBatch={() => setSheet({ kind: "batch" })} onOpenClose={() => setSheet({ kind: "close" })}
              onOpenLeave={() => setSheet({ kind: "leave" })} />
          ) : tab === "member" ? (
            <MemberScreen managers={managers} onPick={(m) => setSelfMember(m)} />
          ) : tab === "log" ? (
            <LogScreen key={period.label + period.year} ledger={ledger} managers={managers} nameById={nameById} period={period} />
          ) : (
            canManageSalary && <ConfigScreen />
          )}
        </div>

        {/* bottom nav */}
        <nav className="shrink-0 flex items-stretch px-3 pt-[9px] backdrop-blur"
          style={{ background: "rgba(23,19,42,.92)", borderTop: "1px solid #322A55", paddingBottom: "calc(env(safe-area-inset-bottom) + 9px)" }}>
          {NAV.filter((n) => n.key !== "config" || canManageSalary).map((n) => {
            const on = tab === n.key;
            return (
              <button key={n.key} onClick={() => setTab(n.key)}
                className="flex-1 flex flex-col items-center gap-1 bg-transparent border-0"
                style={{ color: on ? "#FFD23F" : "#7A6FA0" }}>
                <n.Icon size={22} />
                <span className="text-[10px] font-semibold">{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Self-view y như nhân viên — overlay full-screen (có nav riêng Lương/Nhiệm vụ/Đầu tư) */}
        {selfMember && <SalarySelfMobile m={selfMember} period={period} onExit={() => setSelfMember(null)} />}

        {/* sheets */}
        {sheet?.kind === "breakdown" && (
          <BreakdownSheet m={sheet.m} canPay={canPay} locked={locked} onClose={() => setSheet(null)}
            onPayout={() => setSheet({ kind: "payout", m: sheet.m })}
            onAdjust={() => setSheet({ kind: "adjust", m: sheet.m })}
            onGoLog={() => { setSheet(null); setTab("log"); }} />
        )}
        {sheet?.kind === "payout" && (
          <PayoutSheet m={sheet.m} accounts={accounts} period={period} onClose={() => setSheet(null)}
            onSave={(amt, acc, date, note) => onPayout(sheet.m.id, sheet.m.name, amt, acc, date, note)} />
        )}
        {sheet?.kind === "adjust" && (
          <AdjustSheet m={sheet.m} edit={sheet.edit} onClose={() => setSheet(null)}
            onSave={(p) => onSaveAdjustment(sheet.m.id, p)} />
        )}
        {sheet?.kind === "batch" && (
          <BatchSheet managers={managers} accounts={accounts} period={period} onClose={() => setSheet(null)} onSave={onBulkPayout} />
        )}
        {sheet?.kind === "close" && (
          <CloseSheet locked={locked} period={period} unpaidCount={metrics.unpaidCount} onClose={() => setSheet(null)}
            onConfirm={() => (locked ? onUnlock() : onLock())} />
        )}
        {sheet?.kind === "leave" && (
          <LeaveSheet rows={pendingLeaves} decidingKey={decidingKey} onClose={() => setSheet(null)} onDecide={onDecideLeave} />
        )}
      </div>
    </div>
  );
}
