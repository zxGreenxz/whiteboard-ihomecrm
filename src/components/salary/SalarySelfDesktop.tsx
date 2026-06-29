// Self-view "Lương của tôi" — bản DESKTOP (QUEST). Port từ thiết kế claude.ai/design
// "Lương của tôi - Desktop QUEST.dc.html": theme tối tím-vàng, gamified (hạng/chặng).
// Trang TRỌN MÀN (web-app, KHÔNG MainLayout) — mở ở TAB MỚI khi nhân viên bấm
// "Bảng lương" ở sidebar. Dùng CHUNG dữ liệu SalManager với bản mobile/desktop cũ.
import React, { useEffect, useState } from "react";
import {
  Trophy, Briefcase, Flame, Zap, Wrench, CalendarCheck, FileText,
  Banknote, Moon, TrendingUp, BarChart3, ChevronLeft, ChevronRight, X, Wallet,
  Check, CheckCircle2, Target, AlertTriangle, Clock,
  type LucideIcon,
} from "lucide-react";
import { salFmt, salShort } from "./salaryFormat";
import { useCountUp } from "./salaryCommon";
import type { SalManager, SalLedgerRow } from "@/lib/managerSalary";

const bigNum = (v: number) => Math.round(v).toLocaleString("vi-VN");
const plus = (v: number) => Math.round(Math.abs(v)).toLocaleString("vi-VN");

const RANK_NAMES = ["Tân binh", "Đồng", "Bạc", "Vàng", "Vô địch"];

// màu theme
const C = {
  text: "#EDEAF7", sub: "#9A8FC4", soft: "#CFC9E0", muted: "#6A5F90",
  gold: "#FFD23F", goldDim: "#E3B341", goldSoft: "#FFE08A",
  green: "#34D399", greenSoft: "#7BE7AC", greenMint: "#9DE7C0",
  purple: "#A78BFA", purpleSoft: "#C4B5FD",
  pink: "#FF7AA0", pinkSoft: "#FFB3C6",
  card: "#221C3E", border: "#322A55", ink: "#17132A", dot: "#2C2452",
};

interface PeriodLite { label: string; year: number; }

type DeskProps = {
  m: SalManager;
  period: PeriodLite;
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
};

// ─────────────── meta loại dòng ledger ───────────────
const TYPE_META: Record<string, { label: string; Icon: LucideIcon; bg: string; fg: string }> = {
  JOB: { label: "Việc", Icon: Wrench, bg: "rgba(52,211,153,.16)", fg: C.green },
  DAY_BONUS: { label: "Ngày CN/Lễ", Icon: CalendarCheck, bg: "rgba(255,210,63,.16)", fg: C.gold },
  CONTRACT: { label: "HĐ", Icon: FileText, bg: "rgba(139,92,246,.2)", fg: C.purple },
  CASH: { label: "Thu tiền", Icon: Banknote, bg: "rgba(154,143,196,.16)", fg: C.sub },
};

function fmtDM(iso: string): string {
  const p = (iso || "").split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : iso || "—";
}

// ─────────────── ring tròn (achievement) ───────────────
function Ring({ pct, color }: { pct: number; color: string }) {
  const R = 24, CIRC = 2 * Math.PI * R;
  const off = CIRC * (1 - Math.min(Math.max(pct, 0), 100) / 100);
  return (
    <svg width="56" height="56" viewBox="0 0 56 56">
      <circle cx="28" cy="28" r={R} fill="none" stroke={C.dot} strokeWidth="5" />
      <circle cx="28" cy="28" r={R} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
        strokeDasharray={CIRC} strokeDashoffset={off} transform="rotate(-90 28 28)"
        style={{ transition: "stroke-dashoffset 1s cubic-bezier(.16,1,.3,1)" }} />
    </svg>
  );
}

// ─────────────── HEADER (hàng nổi bật, KHÔNG logo / KHÔNG tiêu đề) ───────────────
// Avatar + tên (Space Grotesk to) nằm thẳng đầu khu nội dung; tháng + "Đang diễn
// ra" dồn về phải. Bỏ logo iHomeCRM và chữ "Lương của tôi" theo thiết kế mới.
function Header({ m, period, onPrevMonth, onNextMonth, canPrev, canNext }: DeskProps) {
  const live = m.status !== "LOCKED";
  const reached = useReached(m);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
      <div style={{ position: "relative" }}>
        <span style={{ width: 54, height: 54, borderRadius: "50%", background: "rgba(255,210,63,.16)", border: `2px solid ${C.gold}`, color: C.gold, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18, fontFamily: "'Space Grotesk',sans-serif" }}>{m.initials}</span>
        {m.incomeGoal > 0 && (
          <span style={{ position: "absolute", bottom: -8, left: "50%", transform: "translateX(-50%)", fontSize: 9, fontWeight: 800, color: C.ink, background: C.gold, padding: "1px 8px", borderRadius: 999, fontFamily: "'Space Grotesk',sans-serif" }}>Lv.{reached + 1}</span>
        )}
      </div>
      <div style={{ lineHeight: 1.18 }}>
        <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 26, fontWeight: 700, letterSpacing: "-.02em", color: "#fff" }}>{m.short}</div>
        <div style={{ fontSize: 13, color: C.sub, marginTop: 1 }}>{m.role} · Bảng lương cá nhân</div>
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 2, background: C.card, border: `1px solid ${C.border}`, borderRadius: 13, padding: 5 }}>
          <button onClick={onPrevMonth} disabled={!canPrev} title="Tháng trước"
            style={{ width: 32, height: 32, border: "none", background: "transparent", color: canPrev ? C.sub : C.muted, borderRadius: 9, cursor: canPrev ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft size={18} strokeWidth={2.4} />
          </button>
          <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 14, fontWeight: 700, color: C.gold, padding: "0 12px", minWidth: 84, textAlign: "center" }}>
            T{period.label.replace(/\D/g, "")}/{period.year}
          </span>
          <button onClick={onNextMonth} disabled={!canNext} title="Tháng sau"
            style={{ width: 32, height: 32, border: "none", background: "transparent", color: canNext ? C.sub : C.muted, borderRadius: 9, cursor: canNext ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ChevronRight size={18} strokeWidth={2.4} />
          </button>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 700, color: live ? "#5BD08E" : C.greenSoft, padding: "9px 14px", background: live ? "rgba(52,211,153,.14)" : "rgba(52,211,153,.1)", border: `1px solid rgba(52,211,153,.25)`, borderRadius: 999 }}>
          {live ? <><span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, animation: "salLiveDot 1.8s ease-out infinite" }} />Đang diễn ra</> : <><Check size={13} strokeWidth={3} />Đã chốt</>}
        </span>
      </div>
    </div>
  );
}

function useReached(m: SalManager): number {
  const goal = m.incomeGoal || 0;
  const gross = m.calc!.gross;
  if (goal <= 0) return 0;
  const stops = [goal * 0.25, m.base, goal * 0.75, goal].sort((a, b) => a - b);
  return stops.filter((v) => gross >= v).length;
}

// ─────────────── QUEST LADDER (hero phải) ───────────────
function QuestLadder({ m }: { m: SalManager }) {
  const goal = m.incomeGoal || 0;
  const gross = m.calc!.gross;
  if (goal <= 0) {
    const net = m.calc!.takehome - m.paid;
    return (
      <div style={{ position: "relative", flex: 1, minWidth: 340, maxWidth: 420, borderRadius: 22, background: "rgba(23,19,42,.5)", border: "1px solid rgba(255,255,255,.1)", padding: "22px 24px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text, display: "inline-flex", alignItems: "center", gap: 7 }}><Wallet size={16} style={{ color: C.gold }} />Tổng quan kỳ này</span>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.soft }}><span>Còn nhận</span><b style={{ fontFamily: "'Space Mono',monospace", color: C.gold }}>{salFmt(net)}</b></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.soft }}><span>Đã trả</span><b style={{ fontFamily: "'Space Mono',monospace" }}>{salFmt(m.paid)}</b></div>
      </div>
    );
  }
  const stops = [
    { v: goal * 0.25, l: "Khởi động", Icon: Zap },
    { v: m.base, l: "Lương cứng", Icon: Briefcase },
    { v: goal * 0.75, l: "Bứt phá", Icon: Flame },
    { v: goal, l: "Vô địch", Icon: Trophy },
  ].sort((a, b) => a.v - b.v);
  const reached = stops.filter((s) => gross >= s.v).length;
  const nextRank = reached < 4 ? RANK_NAMES[reached + 1] : null;
  const pct = Math.round(Math.min(gross / goal, 1) * 100);
  const nextStop = stops.find((s) => s.v > gross);
  const tiers = stops.slice().reverse(); // cao nhất lên đầu

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 340, maxWidth: 420, borderRadius: 22, background: "rgba(23,19,42,.5)", border: "1px solid rgba(255,255,255,.1)", padding: "22px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 700, color: C.text }}>
          <Trophy size={16} style={{ color: C.gold }} />{nextRank ? `Lên hạng ${nextRank}` : "Đỉnh cao Vô địch"}
        </span>
        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 20, color: C.gold }}>{pct}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,.12)", overflow: "hidden", margin: "12px 0 20px" }}>
        <span style={{ display: "block", width: pct + "%", height: "100%", transformOrigin: "left", animation: "salBarGrow 1.2s cubic-bezier(.16,1,.3,1) both", background: "linear-gradient(90deg,#FFD23F,#F5A623)", boxShadow: "0 0 12px rgba(255,210,63,.5)", borderRadius: 999 }} />
      </div>

      {tiers.map((s, i) => {
        const on = gross >= s.v;
        const last = i === tiers.length - 1;
        const isNext = !on && nextStop && s.v === nextStop.v;
        return (
          <div key={i} style={{ position: "relative", display: "flex", alignItems: "center", gap: 13, paddingBottom: last ? 0 : 16 }}>
            {!last && <span style={{ position: "absolute", left: 15, top: 32, bottom: 0, width: 2, background: on ? C.gold : "repeating-linear-gradient(#FFD23F 0 4px, transparent 4px 8px)" }} />}
            <span style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              background: on ? C.gold : C.dot, color: on ? C.ink : C.gold,
              border: on ? "none" : `2px dashed rgba(255,210,63,.5)` }}>
              {on ? <Check size={15} strokeWidth={3} /> : <s.Icon size={16} />}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: on ? C.text : C.gold }}>{s.l}</div>
              <div style={{ fontSize: 11, color: on ? C.greenMint : C.sub }}>{on ? "Đã đạt" : isNext ? "Mốc kế tiếp" : "Chưa đạt"}</div>
            </div>
            <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 13, color: on ? C.sub : C.gold }}>{salShort(s.v)}</span>
          </div>
        );
      })}

      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 18, padding: "11px 13px", borderRadius: 13, background: "rgba(255,210,63,.1)", fontSize: 12, color: C.goldSoft }}>
        <Target size={14} style={{ color: C.gold, flexShrink: 0 }} />
        {nextStop
          ? <span>Còn <b style={{ fontFamily: "'Space Mono',monospace", color: C.gold }}>{salFmt(nextStop.v - gross)}</b> để chinh phục hạng {nextRank} 🏆</span>
          : <span>Đã chinh phục mọi mốc tháng này! 🏆</span>}
      </div>
    </div>
  );
}

// ─────────────── HERO ───────────────
function Hero({ m, onOpenBreak, onOpenDetail }: { m: SalManager; onOpenBreak: () => void; onOpenDetail: (cat: CatKey) => void }) {
  const c = m.calc!;
  const earned = useCountUp(c.gross, [c.gross]);
  const net = c.takehome - m.paid;
  // Mỗi chip mở CHI TIẾT RIÊNG của khoản đó (cat); nút "Bóc tách lương" mới mở
  // bảng tổng hợp đầy đủ (onOpenBreak).
  const allChips: { cat: CatKey; label: string; v: number; minus: boolean; color: string; bg: string }[] = [
    { cat: "luong", label: "Lương cứng", v: m.base, minus: false, color: C.text, bg: "rgba(255,255,255,.12)" },
    { cat: "thuong", label: "Thưởng việc", v: c.bonus, minus: false, color: C.gold, bg: "rgba(255,210,63,.16)" },
    { cat: "dautu", label: "Đầu tư", v: m.investment, minus: false, color: C.greenMint, bg: "rgba(52,211,153,.18)" },
    { cat: "hh", label: "HH Sale", v: m.commission, minus: false, color: C.purpleSoft, bg: "rgba(139,92,246,.22)" },
    { cat: "ung", label: "Đã ứng", v: m.advance, minus: true, color: C.pinkSoft, bg: "rgba(255,122,160,.2)" },
  ];
  const chips = allChips.filter((x) => x.v > 0);

  return (
    <div style={{ position: "relative", borderRadius: 28, overflow: "hidden", padding: 32, background: "radial-gradient(80% 130% at 92% -10%, #5B3AA8 0%, transparent 52%), radial-gradient(70% 130% at -2% 115%, #7A4F12 0%, transparent 55%), #251C46", display: "flex", gap: 32, alignItems: "stretch" }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(rgba(255,210,63,.09) 1px, transparent 1px)", backgroundSize: "18px 18px", opacity: .6, pointerEvents: "none" }} />

      {/* left */}
      <div style={{ position: "relative", flex: 1.5, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "rgba(237,234,247,.85)" }}>
          <Trophy size={16} style={{ color: C.gold }} />
          Chào {m.short} — tổng thu nhập tích luỹ tháng này
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", padding: "2px 8px", background: "rgba(255,210,63,.16)", color: C.gold, borderRadius: 999 }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.gold, animation: "salLiveDot 1.8s ease-out infinite" }} />Realtime
          </span>
        </div>
        <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 76, lineHeight: 1, letterSpacing: "-.03em", color: C.gold, marginTop: 8, textShadow: "0 4px 30px rgba(255,210,63,.28)" }}>
          {bigNum(earned)}<span style={{ fontSize: 34, opacity: .7, marginLeft: 4 }}>₫</span>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
          {chips.map((x) => (
            <button key={x.cat} onClick={() => onOpenDetail(x.cat)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: x.color, padding: "8px 13px", borderRadius: 999, background: x.bg, border: "none", fontFamily: "inherit", cursor: "pointer" }}>
              {x.label} <b style={{ fontFamily: "'Space Mono',monospace" }}>{x.minus ? "−" : "+"}{plus(x.v)}</b>
            </button>
          ))}
        </div>

        <div style={{ marginTop: "auto", display: "flex", alignItems: "flex-end", gap: 28, paddingTop: 24, borderTop: "1px solid rgba(255,255,255,.16)" }}>
          <div>
            <div style={{ fontSize: 12.5, color: "rgba(237,234,247,.8)" }}>Còn nhận kỳ này</div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 32, letterSpacing: "-.02em", color: "#fff", marginTop: 2 }}>{bigNum(net)}<span style={{ fontSize: 18, opacity: .7 }}>₫</span></div>
          </div>
          <div style={{ display: "flex", gap: 18, paddingBottom: 4 }}>
            {m.roomRent > 0 && <div><div style={{ fontSize: 11, color: "rgba(237,234,247,.65)" }}>Tiền phòng</div><div style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14, color: "#FF9DB4", marginTop: 2 }}>−{plus(m.roomRent)}</div></div>}
            {m.paid > 0
              ? <div><div style={{ fontSize: 11, color: "rgba(237,234,247,.65)" }}>Đã trả</div><div style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14, color: C.greenSoft, marginTop: 2 }}>{plus(m.paid)}</div></div>
              : <div><div style={{ fontSize: 11, color: "rgba(237,234,247,.65)" }}>Chuỗi ngày</div><div style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14, color: C.gold, marginTop: 2 }}>🔥 {m.stats.streak}</div></div>}
          </div>
          <button onClick={onOpenBreak}
            style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: C.ink, background: C.gold, border: "none", padding: "11px 18px", borderRadius: 12, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 6px 18px rgba(255,210,63,.3)" }}>
            <BarChart3 size={16} />Bóc tách lương
          </button>
        </div>
      </div>

      <QuestLadder m={m} />
    </div>
  );
}

// ─────────────── ACHIEVEMENTS ───────────────
function Achievements({ m }: { m: SalManager }) {
  const s = m.stats;
  const cards = [
    { v: s.jobs, l: "Thợ sửa chữa", x: `${s.repairs} việc sửa chữa`, Icon: Wrench, color: C.green, pct: Math.min((s.jobs / 30) * 100, 100) },
    { v: s.afterHour, l: "Cú đêm", x: `HĐ ngoài giờ · +${salShort(s.afterHour * 50000)}`, Icon: Moon, color: C.purple, pct: Math.min((s.afterHour / 15) * 100, 100) },
    { v: s.streak, l: "Chuỗi lửa", x: `${s.streak} ngày liên tục 🔥`, Icon: Flame, color: C.pink, pct: Math.min((s.streak / 30) * 100, 100) },
    { v: s.workdays, l: "Chuyên cần", x: `${s.workdays} ngày công`, Icon: CalendarCheck, color: C.gold, pct: Math.min((s.workdays / 30) * 100, 100) },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginTop: 18 }}>
      {cards.map((t, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: 18, borderRadius: 20, background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${t.color}` }}>
          <div style={{ position: "relative", width: 56, height: 56, flexShrink: 0 }}>
            <Ring pct={t.pct} color={t.color} />
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: t.color }}><t.Icon size={20} /></span>
          </div>
          <div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 25, color: C.text, lineHeight: 1 }}>{t.v}</div>
            <div style={{ fontSize: 12.5, color: C.sub, marginTop: 5 }}>{t.l}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: t.color, marginTop: 3 }}>{t.x}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────── WORK LEDGER ───────────────
const TH: React.CSSProperties = { padding: "11px 14px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: C.sub };

function PhotoCell({ r }: { r: SalLedgerRow }) {
  if (r.has_photo === true) return <CheckCircle2 size={16} style={{ color: C.green }} />;
  if (r.has_photo === false && r.item_type === "JOB" && (r.bonus_amount ?? 0) === 0)
    return <AlertTriangle size={16} style={{ color: C.goldDim }} />;
  return <span style={{ color: C.muted }}>—</span>;
}

function BonusCell({ r }: { r: SalLedgerRow }) {
  if (r.bonus_amount == null) return <span style={{ color: C.muted }}>—</span>;
  if (r.bonus_amount === 0) {
    const thieuAnh = r.has_photo === false && r.item_type === "JOB";
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: C.soft }}>0₫</span>
        {thieuAnh && <span style={{ fontSize: 10, color: C.goldDim }}>Thiếu ảnh — chưa tính</span>}
      </div>
    );
  }
  return <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: C.green }}>+{plus(r.bonus_amount)}</span>;
}

function Ledger({ m }: { m: SalManager }) {
  const rows = m.ledger;
  return (
    <div style={{ borderRadius: 22, background: C.card, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 22px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(255,210,63,.14)", color: C.gold, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Zap size={18} /></span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Bảng kê công việc</div>
          <div style={{ fontSize: 11.5, color: C.sub }}>Minh bạch từng đồng · {rows.length} dòng</div>
        </div>
      </div>
      <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: "rgba(23,19,42,.5)" }}>
              <th style={{ ...TH, textAlign: "left", position: "sticky", top: 0 }}>Ngày</th>
              <th style={{ ...TH, textAlign: "left", position: "sticky", top: 0 }}>Loại</th>
              <th style={{ ...TH, textAlign: "left", position: "sticky", top: 0 }}>Nội dung</th>
              <th style={{ ...TH, textAlign: "left", position: "sticky", top: 0 }}>Toà / Phòng</th>
              <th style={{ ...TH, textAlign: "left", position: "sticky", top: 0 }}>Lý do</th>
              <th style={{ ...TH, textAlign: "center", position: "sticky", top: 0 }}>Ảnh</th>
              <th style={{ ...TH, textAlign: "right", position: "sticky", top: 0 }}>Thưởng</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 28, textAlign: "center", color: C.sub }}>Chưa có việc nào tháng này.</td></tr>
            )}
            {rows.map((r, i) => {
              const meta = TYPE_META[r.item_type] || TYPE_META.CASH;
              return (
                <tr key={i} style={{ borderTop: "1px solid rgba(50,42,85,.6)" }}>
                  <td style={{ padding: "12px 14px", color: C.soft, fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap" }}>
                    {fmtDM(r.occurred_date)}
                    {r.day_label && <span style={{ fontSize: 9, fontWeight: 800, color: C.pink, background: "rgba(255,122,160,.16)", padding: "1px 5px", borderRadius: 999, marginLeft: 4 }}>{r.day_label}</span>}
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontWeight: 600, color: r.item_type === "CASH" ? C.sub : C.soft }}>
                      <span style={{ width: 24, height: 24, borderRadius: 7, background: meta.bg, color: meta.fg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><meta.Icon size={13} /></span>
                      {meta.label}
                    </span>
                  </td>
                  <td style={{ padding: "12px 14px", color: r.item_type === "CASH" ? C.soft : C.text, fontWeight: 500 }}>{r.content || "—"}</td>
                  <td style={{ padding: "12px 14px", color: C.sub, fontFamily: "'Space Mono',monospace" }}>{r.place || "—"}</td>
                  <td style={{ padding: "12px 14px" }}>
                    {r.item_type === "CASH"
                      ? <span style={{ fontSize: 10.5, fontWeight: 600, color: C.sub, background: "rgba(154,143,196,.14)", padding: "2px 9px", borderRadius: 999 }}>Không tính thưởng</span>
                      : <span style={{ color: C.sub, fontSize: 11.5 }}>{r.reason || "—"}</span>}
                  </td>
                  <td style={{ padding: "12px 10px", textAlign: "center" }}><PhotoCell r={r} /></td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}><BonusCell r={r} /></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${C.border}`, background: "rgba(23,19,42,.5)" }}>
              <td colSpan={6} style={{ padding: 14, textAlign: "right", textTransform: "uppercase", fontSize: 11, letterSpacing: ".05em", color: C.sub, fontWeight: 700 }}>Tổng thưởng việc (kỳ này)</td>
              <td style={{ padding: "14px 16px", textAlign: "right", fontFamily: "'Space Mono',monospace", fontWeight: 800, fontSize: 14, color: C.gold }}>+{plus(m.calc!.bonus)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ─────────────── INVESTMENT CARD ───────────────
function InvestmentCard({ m }: { m: SalManager }) {
  const list = m.investmentBy.slice().sort((a, b) => b.amount - a.amount);
  if (!list.length) return null;
  const max = Math.max.apply(null, list.map((x) => x.amount).concat(1));
  return (
    <div style={{ borderRadius: 22, background: C.card, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: "rgba(52,211,153,.16)", color: C.green, display: "flex", alignItems: "center", justifyContent: "center" }}><TrendingUp size={17} /></span>
        <div><div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Lợi nhuận đầu tư</div><div style={{ fontSize: 11, color: C.sub }}>Chia LN cổ đông theo nhà</div></div>
      </div>
      <div style={{ padding: "14px 18px" }}>
        {list.map((x, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: i === list.length - 1 ? 0 : 12 }}>
            <span style={{ width: 62, fontFamily: "'Space Mono',monospace", fontSize: 11.5, fontWeight: 700, color: C.soft, flexShrink: 0 }}>{x.b}</span>
            <span style={{ flex: 1, height: 7, borderRadius: 4, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
              <span style={{ display: "block", width: (x.amount / max * 100) + "%", height: "100%", transformOrigin: "left", animation: "salBarGrow 1s ease both", background: "linear-gradient(90deg,#34D399,#16A34A)", borderRadius: 4 }} />
            </span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, fontWeight: 700, color: C.greenSoft, width: 76, textAlign: "right" }}>{plus(x.amount)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 18px", borderTop: `1px solid ${C.border}`, background: "rgba(52,211,153,.08)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: C.greenMint }}>Tổng lợi nhuận</span>
        <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 800, fontSize: 15, color: C.greenSoft }}>{salFmt(m.investment)}</span>
      </div>
    </div>
  );
}

// ─────────────── HISTORY CARD ───────────────
function HistoryCard({ m }: { m: SalManager }) {
  const rows = (m.trend || []).filter((d) => !d.current).slice().reverse();
  return (
    <div style={{ borderRadius: 22, background: C.card, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: "rgba(154,143,196,.16)", color: C.sub, display: "flex", alignItems: "center", justifyContent: "center" }}><Clock size={17} /></span>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Lịch sử nhận lương</div>
      </div>
      {rows.length === 0
        ? <div style={{ padding: 18, textAlign: "center", fontSize: 13, color: C.sub }}>Chưa có tháng nào đã chốt.</div>
        : rows.map((h, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderBottom: i === rows.length - 1 ? "none" : "1px solid rgba(50,42,85,.6)" }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: C.text, width: 42 }}>T{h.label.replace(/^0/, "")}</span>
            <span style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: C.sub }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: C.greenSoft, background: "rgba(52,211,153,.14)", padding: "2px 7px", borderRadius: 999 }}><Check size={10} strokeWidth={3} />Đã chốt</span>
              {h.paidOn || ""}
            </span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 13, color: C.text }}>{plus(h.takehome)}</span>
          </div>
        ))}
    </div>
  );
}

// ─────────────── CHART (Hành trình 6 tháng) ───────────────
function JourneyChart({ m }: { m: SalManager }) {
  const data = m.trend || [];
  if (data.length === 0) return null;
  const maxV = Math.max.apply(null, data.map((d) => d.gross).concat(1));
  const avg = Math.round(data.reduce((s, d) => s + d.gross, 0) / data.length);
  const best = data.reduce((a, b) => (b.gross > a.gross ? b : a), data[0]);
  const first = data[0].gross, lastV = data[data.length - 1].gross;
  const trendPct = first > 0 ? Math.round(((lastV - first) / first) * 100) : 0;
  const avgPct = maxV > 0 ? (avg / maxV) * 100 : 0;

  return (
    <div style={{ borderRadius: 22, background: C.card, border: `1px solid ${C.border}`, marginTop: 18, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 22px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(255,210,63,.14)", color: C.gold, display: "flex", alignItems: "center", justifyContent: "center" }}><BarChart3 size={18} /></span>
        <div><div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Hành trình lương 6 tháng</div><div style={{ fontSize: 11.5, color: C.sub }}>Tổng lương & thực nhận</div></div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 11.5, color: C.sub }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 11, height: 11, borderRadius: 3, background: "rgba(255,210,63,.28)" }} />Tổng lương</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 11, height: 11, borderRadius: 3, background: C.gold }} />Thực nhận</span>
        </div>
      </div>
      <div style={{ position: "relative", padding: "24px 22px 8px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 26, height: 230, position: "relative" }}>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: avgPct + "%", borderTop: "1.5px dashed rgba(255,210,63,.4)" }}>
            <span style={{ position: "absolute", right: 0, top: -9, fontSize: 10, fontWeight: 700, color: C.goldDim, background: "rgba(255,210,63,.12)", padding: "1px 7px", borderRadius: 999, fontFamily: "'Space Mono',monospace" }}>TB {salShort(avg)}</span>
          </div>
          {data.map((d, i) => {
            const h = Math.max((d.gross / maxV) * 100, 4);
            const inner = d.gross > 0 ? Math.max((d.takehome / d.gross) * 100, 0) : 0;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end", gap: 8 }}>
                <div style={{ width: 46, height: h + "%", borderRadius: "9px 9px 0 0", background: d.current ? "rgba(255,210,63,.3)" : "rgba(255,210,63,.22)", position: "relative", boxShadow: d.current ? "0 0 0 2px #FFD23F, 0 8px 22px rgba(255,210,63,.3)" : undefined }}>
                  <span style={{ position: "absolute", top: -20, left: 0, right: 0, textAlign: "center", fontFamily: "'Space Mono',monospace", fontSize: d.current ? 11.5 : 10.5, fontWeight: d.current ? 800 : 700, color: d.current ? C.gold : C.sub }}>{salShort(d.gross).replace("tr", "")}</span>
                  <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: inner + "%", borderRadius: "9px 9px 0 0", background: d.current ? "linear-gradient(180deg,#FFD23F,#F5A623)" : C.gold, opacity: d.current ? 1 : .85 }} />
                </div>
                <span style={{ fontSize: 11.5, fontWeight: d.current ? 800 : 400, color: d.current ? C.gold : C.sub }}>T{d.label.replace(/^0/, "")}{d.current ? " •" : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "14px 22px", borderTop: `1px solid ${C.border}`, background: "rgba(23,19,42,.4)", fontSize: 12.5, color: C.sub }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><TrendingUp size={15} style={{ color: C.green }} />Xu hướng <b style={{ color: trendPct >= 0 ? C.green : C.pink }}>{trendPct >= 0 ? "+" : ""}{trendPct}%</b> trong {data.length} tháng</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Trophy size={15} style={{ color: C.gold }} />Cao nhất <b style={{ color: C.text }}>{salFmt(best.gross)}</b> · T{best.label.replace(/^0/, "")} 🏆</span>
      </div>
    </div>
  );
}

// ─────────────── BREAKDOWN MODAL ───────────────
function BreakRow({ label, note, amount, color, neg }: { label: string; note?: string; amount: number; color?: string; neg?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid rgba(50,42,85,.7)" }}>
      <span style={{ fontSize: 13, color: neg ? C.pinkSoft : C.text }}>{label}{note && <span style={{ fontSize: 11, color: C.sub }}> · {note}</span>}</span>
      <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: color || C.text }}>{neg ? "−" : "+"}{plus(amount)}</span>
    </div>
  );
}

function BreakdownModal({ m, period, onClose }: { m: SalManager; period: PeriodLite; onClose: () => void }) {
  const c = m.calc!;
  const mm = period.label.replace(/\D/g, "");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(10,6,22,.66)", animation: "salFadeIn .2s ease" }} />
      <div style={{ position: "relative", width: 460, maxWidth: "100%", background: C.card, border: "1px solid #3A3163", borderRadius: 22, boxShadow: "0 30px 80px rgba(0,0,0,.5)", animation: "salPopIn .22s cubic-bezier(.16,1,.3,1)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 22px 16px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, background: "rgba(255,210,63,.14)", color: C.gold, display: "flex", alignItems: "center", justifyContent: "center" }}><BarChart3 size={20} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>Bóc tách thu nhập tháng {mm}</div>
            <div style={{ fontSize: 11.5, color: C.sub }}>{m.short} · T{mm}/{period.year}</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 10, background: C.ink, border: `1px solid ${C.border}`, color: C.sub, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={16} strokeWidth={2.5} /></button>
        </div>
        <div style={{ padding: "6px 22px 16px" }}>
          <BreakRow label="Lương cứng" amount={m.base} />
          <BreakRow label="Thưởng việc" note={`${m.stats.jobs} việc`} amount={c.bonus} color={C.gold} />
          {m.investment > 0 && <BreakRow label="Đầu tư" note="LN cổ đông" amount={m.investment} color={C.green} />}
          {m.commission > 0 && <BreakRow label="Hoa hồng Sale" amount={m.commission} color={C.purpleSoft} />}
          {m.advance > 0 && <BreakRow label="Đã ứng trước" amount={m.advance} color={C.pink} neg />}
          {m.roomRent > 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0" }}>
              <span style={{ fontSize: 13, color: C.pinkSoft }}>Tiền phòng</span>
              <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: C.pink }}>−{plus(m.roomRent)}</span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, padding: "15px 17px", borderRadius: 14, background: "rgba(255,210,63,.1)", border: "1px solid rgba(255,210,63,.25)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Thực nhận</span>
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 22, color: C.gold }}>{salFmt(c.takehome)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────── CATEGORY DETAIL MODAL ───────────────
// Mỗi chip thu nhập mở chi tiết RIÊNG của khoản đó (khác "Bóc tách lương" = tổng).
type CatKey = "luong" | "thuong" | "dautu" | "hh" | "ung";
interface DetailRow { label: string; note?: string; val: string; color: string; }
interface DetailDesc {
  title: string; sub: string; iconBg: string; iconColor: string; rows: DetailRow[];
  totalLabel: string; totalVal: string; totalColor: string; totalBg: string; totalBorder: string;
}

function buildDetail(m: SalManager, period: PeriodLite, cat: CatKey): DetailDesc {
  const c = m.calc!;
  const pt = `T${period.label.replace(/\D/g, "")}/${period.year}`;
  const GOLD = { color: C.gold, bg: "rgba(255,210,63,.1)", border: "rgba(255,210,63,.25)" };
  const GREEN = { color: C.greenSoft, bg: "rgba(52,211,153,.1)", border: "rgba(52,211,153,.25)" };
  const PURPLE = { color: C.purpleSoft, bg: "rgba(139,92,246,.12)", border: "rgba(139,92,246,.3)" };
  const PINK = { color: C.pink, bg: "rgba(255,122,160,.1)", border: "rgba(255,122,160,.25)" };

  if (cat === "luong") {
    // Dữ liệu thật chỉ có lương cứng gộp (m.base) — hiện 1 dòng "Lương cơ bản".
    return {
      title: "Lương cứng", sub: `Lương cơ bản cố định · ${pt}`,
      iconBg: "rgba(255,255,255,.1)", iconColor: C.text,
      rows: [{ label: "Lương cơ bản", note: "· " + m.role, val: "+" + plus(m.base), color: C.text }],
      totalLabel: "Tổng lương cứng", totalVal: "+" + plus(m.base), totalColor: GOLD.color, totalBg: GOLD.bg, totalBorder: GOLD.border,
    };
  }

  if (cat === "thuong") {
    const elig = m.ledger.filter((r) => (r.bonus_amount ?? 0) > 0).slice()
      .sort((a, b) => (a.occurred_date < b.occurred_date ? 1 : -1));
    const top = elig.slice(0, 4);
    const rest = elig.slice(4);
    const rows: DetailRow[] = top.map((r) => ({ label: r.content || "Việc", note: "· " + fmtDM(r.occurred_date), val: "+" + plus(r.bonus_amount as number), color: C.gold }));
    if (rest.length) {
      const sum = rest.reduce((s, r) => s + (r.bonus_amount || 0), 0);
      rows.push({ label: `+ ${rest.length} việc khác`, val: "+" + plus(sum), color: C.sub });
    }
    for (const a of m.adjustments) {
      rows.push({ label: a.label, note: a.note ? "· " + a.note : "", val: (a.amount < 0 ? "−" : "+") + plus(a.amount), color: a.amount < 0 ? C.pink : C.green });
    }
    if (!rows.length) rows.push({ label: "Chưa có thưởng việc tháng này", val: "—", color: C.sub });
    return {
      title: "Thưởng việc", sub: `${elig.length} việc đã duyệt · có ảnh nghiệm thu`,
      iconBg: "rgba(255,210,63,.16)", iconColor: C.gold, rows,
      totalLabel: "Tổng thưởng việc", totalVal: "+" + plus(c.bonus), totalColor: GOLD.color, totalBg: GOLD.bg, totalBorder: GOLD.border,
    };
  }

  if (cat === "dautu") {
    const list = m.investmentBy.slice().sort((a, b) => b.amount - a.amount);
    const rows: DetailRow[] = list.length
      ? list.map((x) => ({ label: x.b, val: "+" + plus(x.amount), color: C.greenSoft }))
      : [{ label: m.investmentLocked ? "Chưa có phần đầu tư tháng này" : "Chờ chốt Lợi nhuận cổ đông", val: "—", color: C.sub }];
    return {
      title: "Lợi nhuận đầu tư", sub: `Chia LN cổ đông theo nhà · ${pt}`,
      iconBg: "rgba(52,211,153,.18)", iconColor: C.green, rows,
      totalLabel: "Tổng lợi nhuận", totalVal: "+" + plus(m.investment), totalColor: GREEN.color, totalBg: GREEN.bg, totalBorder: GREEN.border,
    };
  }

  if (cat === "hh") {
    const rows: DetailRow[] = m.commissionItems.map((x) => ({ label: x.label, val: "+" + plus(x.amount), color: C.purpleSoft }));
    for (const x of m.commissionFlagged || []) rows.push({ label: x.label, note: "· đã thanh toán riêng", val: "+" + plus(x.amount), color: C.pink });
    if (!rows.length) rows.push({ label: "Chưa có hoa hồng tháng này", val: "—", color: C.sub });
    return {
      title: "Hoa hồng Sale", sub: `Hợp đồng đã chốt · ${pt}`,
      iconBg: "rgba(139,92,246,.22)", iconColor: C.purpleSoft, rows,
      totalLabel: "Tổng hoa hồng", totalVal: "+" + plus(m.commission), totalColor: PURPLE.color, totalBg: PURPLE.bg, totalBorder: PURPLE.border,
    };
  }

  // ung
  const rows: DetailRow[] = m.advanceItems.length
    ? m.advanceItems.map((x) => ({ label: x.label, note: "· " + x.date, val: "−" + plus(x.amount), color: C.pink }))
    : [{ label: "Chưa có khoản ứng nào", val: "—", color: C.sub }];
  return {
    title: "Đã ứng trước", sub: `Khoản trừ vào lương kỳ này · ${pt}`,
    iconBg: "rgba(255,122,160,.2)", iconColor: C.pinkSoft, rows,
    totalLabel: "Tổng đã ứng", totalVal: "−" + plus(m.advance), totalColor: PINK.color, totalBg: PINK.bg, totalBorder: PINK.border,
  };
}

function CategoryDetailModal({ m, period, cat, onClose }: { m: SalManager; period: PeriodLite; cat: CatKey; onClose: () => void }) {
  const d = buildDetail(m, period, cat);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(10,6,22,.66)", animation: "salFadeIn .2s ease" }} />
      <div style={{ position: "relative", width: 460, maxWidth: "100%", background: C.card, border: "1px solid #3A3163", borderRadius: 22, boxShadow: "0 30px 80px rgba(0,0,0,.5)", animation: "salPopIn .22s cubic-bezier(.16,1,.3,1)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 22px 16px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, background: d.iconBg, color: d.iconColor, display: "flex", alignItems: "center", justifyContent: "center" }}><BarChart3 size={20} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{d.title}</div>
            <div style={{ fontSize: 11.5, color: C.sub }}>{d.sub}</div>
          </div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 10, background: C.ink, border: `1px solid ${C.border}`, color: C.sub, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={16} strokeWidth={2.5} /></button>
        </div>
        <div style={{ padding: "6px 22px 18px", maxHeight: "60vh", overflowY: "auto" }}>
          {d.rows.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 0", borderBottom: "1px solid rgba(50,42,85,.7)" }}>
              <span style={{ fontSize: 13, color: C.text, minWidth: 0 }}>{r.label}{r.note ? <span style={{ fontSize: 11, color: C.sub }}> {r.note}</span> : null}</span>
              <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, color: r.color, flexShrink: 0 }}>{r.val}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, padding: "15px 17px", borderRadius: 14, background: d.totalBg, border: `1px solid ${d.totalBorder}` }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{d.totalLabel}</span>
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 22, color: d.totalColor }}>{d.totalVal}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────── ROOT ───────────────
export default function SalarySelfDesktop(props: DeskProps) {
  const { m, period } = props;
  const [modal, setModal] = useState<{ kind: "break" } | { kind: "detail"; cat: CatKey } | null>(null);

  // Khoá cuộn nền + nạp font QUEST (Be Vietnam Pro / Space Grotesk / Space Mono).
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "auto";
    const linkId = "sal-quest-fonts";
    if (!document.getElementById(linkId)) {
      const l = document.createElement("link");
      l.id = linkId;
      l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap";
      document.head.appendChild(l);
    }
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, overflowY: "auto", background: "radial-gradient(70% 50% at 50% -5%, #2a1f54 0%, transparent 55%), #15112A", fontFamily: "'Be Vietnam Pro',sans-serif", color: C.text, paddingBottom: 48 }}>
      <style>{`
        @keyframes salBarGrow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        @keyframes salLiveDot { 0% { box-shadow: 0 0 0 0 currentColor; } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
        @keyframes salFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes salPopIn { from { opacity:0; transform: translateY(10px) scale(.97);} to {opacity:1; transform:none;} }
      `}</style>

      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "26px 28px 0" }}>
        <Header {...props} />
        <Hero m={m} onOpenBreak={() => setModal({ kind: "break" })} onOpenDetail={(cat) => setModal({ kind: "detail", cat })} />
        <Achievements m={m} />
        <div style={{ display: "grid", gridTemplateColumns: "1.9fr 1fr", gap: 18, marginTop: 18, alignItems: "start" }}>
          <Ledger m={m} />
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <InvestmentCard m={m} />
            <HistoryCard m={m} />
          </div>
        </div>
        <JourneyChart m={m} />
      </div>

      {modal?.kind === "break" && <BreakdownModal m={m} period={period} onClose={() => setModal(null)} />}
      {modal?.kind === "detail" && <CategoryDetailModal m={m} period={period} cat={modal.cat} onClose={() => setModal(null)} />}
    </div>
  );
}
