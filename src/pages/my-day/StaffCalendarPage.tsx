// Màn 4 — Lịch tháng theo người.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, PersonAvatar, StaffHeader, StaffShell, StatusPill } from "@/components/staff-day/StaffShell";
import { useStaffCalendar } from "@/hooks/staff-day/useStaffDay";
import { cn } from "@/lib/utils";
import {
  addMonths, dayTitle, gpsCountsText, gpsMockText, mondayIndex, tickSourceLabel, vnDateOf, type StaffCalendarDay, type StaffDayKind,
} from "@/lib/staffDay";

const pagerButton = "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 disabled:opacity-50";

const CELL: Record<StaffDayKind, { box: string; dot: string; label: string }> = {
  ticked: { box: "bg-emerald-50", dot: "bg-emerald-600", label: "có ngày công" },
  leave: { box: "bg-amber-50", dot: "bg-amber-500", label: "nghỉ phép" },
  pending_leave: { box: "bg-amber-50", dot: "bg-amber-300", label: "chờ duyệt phép" },
  flagged: { box: "bg-red-50", dot: "bg-red-600", label: "nghi án" },
  missed: { box: "bg-red-50", dot: "bg-red-600", label: "không có công" },
  sunday: { box: "bg-slate-100", dot: "bg-slate-300", label: "Chủ nhật" },
  holiday: { box: "bg-slate-100", dot: "bg-slate-300", label: "ngày lễ" },
  today_pending: { box: "bg-white", dot: "bg-transparent", label: "hôm nay, chưa có công" },
  future: { box: "bg-white border-slate-200", dot: "bg-transparent", label: "chưa tới" },
  before_start: { box: "bg-white border-slate-200", dot: "bg-transparent", label: "chưa áp dụng" },
};

const LEGEND = [
  { cls: "bg-emerald-600", text: "Có ngày công" },
  { cls: "bg-amber-500", text: "Phép" },
  { cls: "bg-red-600", text: "Không có công / nghi án" },
  { cls: "bg-slate-300", text: "Chủ nhật / lễ" },
];

function canOpen(day: StaffCalendarDay) {
  return day.kind !== "future" && day.kind !== "before_start";
}

export default function StaffCalendarPage() {
  const { userId } = useParams<{ userId: string }>();
  const [params, setParams] = useSearchParams();
  const today = vnDateOf();
  const currentMonth = today.slice(0, 7);
  const raw = params.get("thang");
  const month = raw && /^\d{4}-\d{2}$/.test(raw) && raw <= currentMonth ? raw : currentMonth;
  const query = useStaffCalendar(userId, `${month}-01`);
  const data = query.data;
  const firstMonth = data?.first_month.slice(0, 7) ?? "2026-07";
  const name = data?.user.name ?? "Quản lý";

  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(null); }, [month]);

  const days = useMemo(() => data?.days ?? [], [data]);
  const blanks = days[0] ? mondayIndex(days[0].date) : 0;
  const fallback = useMemo(
    () => [...days].reverse().find((d) => canOpen(d) && d.kind !== "sunday" && d.kind !== "holiday") ?? days[0],
    [days],
  );
  const picked = days.find((d) => d.date === selected) ?? fallback;
  const go = (delta: number) => {
    const next = addMonths(month, delta);
    setParams(next === currentMonth ? {} : { thang: next }, { replace: true });
  };
  const totals = data?.totals;

  return (
    <StaffShell>
      <StaffHeader
        backTo={`/my-day/nguoi/${userId}`}
        backLabel="Quay lại"
        title={`Lịch tháng · ${name}`}
        sub="mỗi ô là một ngày · bấm để xem ngày đó"
        right={data ? <PersonAvatar name={name} /> : undefined}
      />

      <div className="flex items-center gap-2 rounded-xl border bg-white p-1.5">
        <button type="button" aria-label="Tháng trước" className={pagerButton} disabled={month <= firstMonth} onClick={() => go(-1)}>
          <ChevronLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="font-bold">Tháng {month.slice(5, 7)}/{month.slice(0, 4)}</div>
          <div className="text-[11px] text-muted-foreground">xem được từ {firstMonth.slice(5, 7)}/{firstMonth.slice(0, 4)} (bắt đầu chấm v5)</div>
        </div>
        <button type="button" aria-label="Tháng sau" className={pagerButton} disabled={month >= currentMonth} onClick={() => go(1)}>
          <ChevronRight className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>

      <QueryRegion label="lịch tháng" skeleton="detail" rows={6} queries={[query]}>
        {data && totals ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              {[
                { v: <>{totals.ticked_days}{totals.n_chuan != null ? <span className="text-[11px] text-muted-foreground">/{totals.n_chuan}</span> : null}</>, l: "ngày công", c: "text-emerald-800" },
                { v: totals.best_streak ?? "—", l: "chuỗi tốt nhất", c: "" },
                { v: totals.leave_days, l: "phép", c: "" },
                { v: totals.visits, l: "lượt ghé toà", c: "" },
              ].map((tile) => (
                <div key={tile.l} className="rounded-xl border bg-white px-2 py-2.5 text-center">
                  <div className={cn("font-mono text-lg font-bold", tile.c)}>{tile.v}</div>
                  <div className="text-[10px] text-muted-foreground">{tile.l}</div>
                </div>
              ))}
            </div>

            <Card label={`Lịch ngày công tháng ${month.slice(5, 7)}`}>
              <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold text-muted-foreground">
                {["T2", "T3", "T4", "T5", "T6", "T7"].map((d) => <span key={d}>{d}</span>)}
                <span className="text-red-700">CN</span>
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {Array.from({ length: blanks }, (_, i) => <div key={`b-${i}`} />)}
                {days.map((day) => {
                  const style = CELL[day.kind];
                  const label = `${day.date.slice(8, 10)}/${month.slice(5, 7)} ${style.label}${day.buildings ? ` · ${day.buildings} toà` : ""}`;
                  const isSel = picked?.date === day.date;
                  return (
                    <button
                      key={day.date}
                      type="button"
                      title={label}
                      aria-label={label}
                      aria-pressed={isSel}
                      disabled={!canOpen(day)}
                      onClick={() => setSelected(day.date)}
                      className={cn(
                        "flex h-[54px] flex-col items-center justify-center gap-[3px] rounded-[10px] border-2 border-transparent",
                        style.box,
                        day.date === today && "border-primary/50",
                        isSel && "border-primary",
                      )}
                    >
                      <span className={cn("text-[13px] font-semibold", (day.kind === "sunday" || day.kind === "future") && "text-muted-foreground")}>{Number(day.date.slice(8, 10))}</span>
                      <span className="flex h-3 items-center gap-[3px]">
                        <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", style.dot)} />
                        {day.buildings > 0 ? <span className="text-[10px] font-semibold">{day.buildings}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-x-2.5 gap-y-1 border-t pt-1 text-[11px] text-slate-700">
                {LEGEND.map((item) => (
                  <span key={item.text} className="flex items-center gap-1.5">
                    <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", item.cls)} />{item.text}
                  </span>
                ))}
                <span><b>2</b> = số toà đã ghé</span>
              </div>
            </Card>

            {picked ? (
              <section aria-label="Ngày đang chọn" className="flex flex-col gap-2 rounded-2xl border-2 border-primary bg-white p-3.5">
                <div className="flex items-center gap-2">
                  <h2 className="font-bold">{dayTitle(picked.date)}{picked.date === today ? " · hôm nay" : ""}</h2>
                  <StatusPill tone={picked.kind === "ticked" ? "success" : picked.kind === "missed" || picked.kind === "flagged" ? "danger" : "neutral"} className="ml-auto">
                    {CELL[picked.kind].label}
                  </StatusPill>
                </div>
                <p className="text-[13px] text-slate-700">
                  {[
                    picked.tick_source ? `nguồn: ${tickSourceLabel(picked.tick_source)}` : null,
                    `${picked.sessions} lượt kiểm tra`,
                    `${picked.jobs} việc xong`,
                    `${picked.payments} lần thu tiền`,
                    picked.gps && picked.gps.ok + picked.gps.stationary + picked.gps.missing > 0 ? `điểm danh ${gpsCountsText(picked.gps)}` : null,
                    gpsMockText(picked.gps),
                  ].filter(Boolean).join(" · ")}
                </p>
                {canOpen(picked) ? (
                  <Link to={`/my-day/nguoi/${userId}/hanh-trinh${picked.date === today ? "" : `?ngay=${picked.date}`}`} className="flex h-11 items-center justify-center rounded-[10px] bg-primary text-[13px] font-semibold text-primary-foreground">
                    Mở hành trình {picked.date.slice(8, 10)}/{picked.date.slice(5, 7)}
                  </Link>
                ) : null}
              </section>
            ) : null}

            <p className="text-center text-[11px] text-muted-foreground">Ngày công chốt theo máy chủ</p>
          </div>
        ) : null}
      </QueryRegion>
    </StaffShell>
  );
}
