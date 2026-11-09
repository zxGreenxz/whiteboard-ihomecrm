// Màn 5–6 — Báo cáo đánh giá theo kỳ. Một trang, co giãn điện thoại/máy tính.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle, PersonAvatar, StaffHeader, StaffShell, StatusPill } from "@/components/staff-day/StaffShell";
import { useSaveStaffReview, useStaffPeriodReport } from "@/hooks/staff-day/useStaffDay";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { cn } from "@/lib/utils";
import {
  addDays, addMonths, monthLastDay, shortDate, vnDateOf, type StaffDayKind, type StaffReportMember,
} from "@/lib/staffDay";
import { METRICS, metricBars, periodTotals, reportSheetRows, type BarTone } from "@/lib/staffReportMetrics";

type Mode = "month" | "week" | "custom";

const BAR: Record<BarTone, string> = {
  good: "bg-emerald-600", warn: "bg-orange-500", bad: "bg-red-600", neutral: "bg-slate-400",
};

const HEAT: Record<StaffDayKind, string> = {
  ticked: "bg-emerald-600",
  leave: "bg-amber-400",
  pending_leave: "bg-amber-300",
  flagged: "bg-red-600",
  missed: "bg-red-500",
  sunday: "bg-slate-200",
  holiday: "bg-slate-200",
  today_pending: "bg-white border border-slate-300",
  future: "bg-white border border-slate-200",
  before_start: "bg-white border border-slate-200",
};
const HEAT_LABEL: Record<StaffDayKind, string> = {
  ticked: "có công", leave: "phép", pending_leave: "chờ duyệt phép", flagged: "nghi án", missed: "không có công",
  sunday: "Chủ nhật", holiday: "ngày lễ", today_pending: "hôm nay", future: "chưa tới", before_start: "chưa áp dụng",
};

function mondayOf(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  return addDays(key, -((d.getUTCDay() + 6) % 7));
}

function Heatmap({ member }: { member: StaffReportMember }) {
  return (
    <div className="flex flex-wrap gap-[3px]" role="img" aria-label={`Ngày công từng ngày của ${member.user.name}`}>
      {member.days.map((day) => (
        <span key={day.date} title={`${shortDate(day.date)} ${HEAT_LABEL[day.kind]}`} className={cn("h-3.5 w-3.5 rounded-[3px]", HEAT[day.kind])} />
      ))}
    </div>
  );
}

function ReviewBox({ member, from, to }: { member: StaffReportMember; from: string; to: string }) {
  const save = useSaveStaffReview();
  const [rating, setRating] = useState<"A" | "B" | "C" | null>(member.review?.rating ?? null);
  const [note, setNote] = useState(member.review?.note ?? "");
  useEffect(() => {
    setRating(member.review?.rating ?? null);
    setNote(member.review?.note ?? "");
  }, [member.review?.rating, member.review?.note, from, to]);
  const noteId = `review-note-${member.user.id}`;
  const submit = async () => {
    try {
      await save.mutateAsync({ userId: member.user.id, from, to, rating, note });
      toast.success(`Đã lưu nhận xét cho ${member.user.name}`);
    } catch (error) {
      toast.error(actionErrorMessage(error, "Chưa lưu được nhận xét"));
    }
  };
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <PersonAvatar name={member.user.name} size="sm" />
        <span className="min-w-0 flex-1 truncate font-semibold">{member.user.name}</span>
        <div className="flex gap-1" role="group" aria-label={`Xếp loại ${member.user.name}`}>
          {(["A", "B", "C"] as const).map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={rating === level}
              onClick={() => setRating(rating === level ? null : level)}
              className={cn("h-11 w-11 rounded-lg border text-sm font-bold", rating === level ? "border-primary bg-primary text-primary-foreground" : "bg-white")}
            >{level}</button>
          ))}
        </div>
      </div>
      <label htmlFor={noteId} className="sr-only">Nhận xét cho {member.user.name}</label>
      <Textarea id={noteId} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi vài dòng nhận xét…" />
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={save.isPending} onClick={() => { void submit(); }}>Lưu nhận xét</Button>
      </div>
    </div>
  );
}

export default function StaffReportPage() {
  const today = vnDateOf();
  const [mode, setMode] = useState<Mode>("month");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [weekStart, setWeekStart] = useState(mondayOf(today));
  const [customFrom, setCustomFrom] = useState(addDays(today, -13));
  const [customTo, setCustomTo] = useState(today);
  const [person, setPerson] = useState("all");

  const customValid = customFrom <= customTo && customTo <= today
    && (new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86_400_000 <= 92;
  const range = mode === "month" ? { from: `${month}-01`, to: monthLastDay(month) }
    : mode === "week" ? { from: weekStart, to: addDays(weekStart, 6) }
      : { from: customFrom, to: customTo };

  const query = useStaffPeriodReport(mode === "custom" && !customValid ? undefined : range.from, mode === "custom" && !customValid ? undefined : range.to);
  const allMembers = useMemo(() => query.data?.members ?? [], [query.data]);
  const members = useMemo(() => person === "all" ? allMembers : allMembers.filter((m) => m.user.id === person), [allMembers, person]);
  const totals = useMemo(() => periodTotals(members), [members]);

  const pagerPrev = () => {
    if (mode === "month") setMonth(addMonths(month, -1));
    else if (mode === "week") setWeekStart(addDays(weekStart, -7));
  };
  const pagerNext = () => {
    if (mode === "month") setMonth(addMonths(month, 1));
    else if (mode === "week") setWeekStart(addDays(weekStart, 7));
  };
  const nextDisabled = mode === "month" ? month >= today.slice(0, 7) : weekStart >= mondayOf(today);
  const periodLabel = mode === "month"
    ? `Tháng ${month.slice(5, 7)}/${month.slice(0, 4)}`
    : mode === "week" ? `Tuần ${shortDate(range.from)} – ${shortDate(range.to)}` : "";

  const exportXlsx = async () => {
    try {
      const XLSX = await import("xlsx");
      const sheet = XLSX.utils.aoa_to_sheet(reportSheetRows(members));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Bao cao");
      XLSX.writeFile(book, `bao-cao-quan-ly_${range.from}_${range.to}.xlsx`);
    } catch (error) {
      toast.error(actionErrorMessage(error, "Chưa xuất được file Excel"));
    }
  };

  const tabs: { key: Mode; label: string }[] = [
    { key: "month", label: "Tháng" }, { key: "week", label: "Tuần" }, { key: "custom", label: "Tuỳ chọn" },
  ];

  return (
    <StaffShell wide>
      <StaffHeader backTo="/my-day/team" backLabel="Về cả đội" title="Báo cáo đánh giá" sub="so sánh quản lý theo kỳ · chỉ chủ xem" />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-slate-100 p-[3px]" role="tablist" aria-label="Loại kỳ">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" role="tab" aria-selected={mode === tab.key} onClick={() => setMode(tab.key)}
              className={cn("h-9 rounded-md px-3.5 text-sm font-medium", mode === tab.key ? "bg-white text-primary shadow-sm" : "text-muted-foreground")}>
              {tab.label}
            </button>
          ))}
        </div>

        {mode === "custom" ? (
          <div className="flex items-center gap-2">
            <input type="date" aria-label="Từ ngày" className="h-10 rounded-md border bg-white px-2 text-base" max={today} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <span aria-hidden="true">–</span>
            <input type="date" aria-label="Đến ngày" className="h-10 rounded-md border bg-white px-2 text-base" max={today} value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Kỳ trước" onClick={pagerPrev} className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100"><ChevronLeft className="h-[18px] w-[18px]" aria-hidden="true" /></button>
            <span className="min-w-[132px] text-center text-sm font-bold">{periodLabel}</span>
            <button type="button" aria-label="Kỳ sau" disabled={nextDisabled} onClick={pagerNext} className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 disabled:opacity-50"><ChevronRight className="h-[18px] w-[18px]" aria-hidden="true" /></button>
          </div>
        )}

        <select aria-label="Chọn người" className="h-10 rounded-md border bg-white px-2 text-sm" value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="all">Tất cả quản lý</option>
          {allMembers.map((member) => <option key={member.user.id} value={member.user.id}>{member.user.name}</option>)}
        </select>

        <div className="flex gap-2 lg:ml-auto">
          <Link to="/my-day/team" className="flex h-10 items-center rounded-md border bg-white px-3 text-sm font-medium">Hôm nay của đội</Link>
          <Button type="button" variant="default" className="h-10" disabled={members.length === 0} onClick={() => { void exportXlsx(); }}>
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" /> Xuất Excel
          </Button>
        </div>
      </div>

      {mode === "custom" && !customValid ? <p role="alert" className="text-sm text-destructive">Chọn khoảng ngày hợp lệ, tối đa 93 ngày và không quá hôm nay.</p> : null}

      <QueryRegion label="báo cáo đánh giá" skeleton="table" rows={8} queries={mode === "custom" && !customValid ? [] : [query]}>
        {query.data ? (
          <div className="space-y-3">
            {query.data.measured_to !== query.data.to ? <p className="text-xs text-muted-foreground">Tính tới {shortDate(query.data.measured_to)} (kỳ chưa kết thúc).</p> : null}

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 lg:gap-3">
              {[
                { label: "Ngày công", value: totals.attendance == null ? "—" : `${Math.round(totals.attendance * 100)}%`, sub: "đã có / ngày chuẩn", color: "border-l-emerald-500" },
                { label: "Toà quá hạn ghé", value: totals.overdueBuildings, sub: `${totals.overdueTimes} lần trong kỳ`, color: "border-l-red-500" },
                { label: "Việc trễ hạn", value: totals.jobsLate, sub: "việc giao chưa đúng hạn", color: "border-l-orange-500" },
                { label: "Điểm danh tự động", value: totals.gps == null ? "—" : `${Math.round(totals.gps * 100)}%`, sub: "mốc có dấu GPS", color: "border-l-blue-500" },
              ].map((tile) => (
                <div key={tile.label} className={cn("rounded-lg border border-l-4 bg-white p-3.5 shadow-sm", tile.color)}>
                  <div className="text-xs font-medium text-muted-foreground">{tile.label}</div>
                  <div className="mt-1.5 text-2xl font-bold tracking-tight">{tile.value}</div>
                  <div className="text-[11px] text-muted-foreground">{tile.sub}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Card label="So sánh chỉ số">
                <CardTitle right="không tự chấm điểm, không quy ra tiền">So sánh chỉ số</CardTitle>

                {/* Điện thoại: mỗi chỉ số một khối */}
                <div className="space-y-3 lg:hidden">
                  {METRICS.map((def) => {
                    const bars = metricBars(def, members);
                    return (
                      <div key={def.key} className="border-t pt-2.5 first:border-t-0 first:pt-0">
                        <div className="text-[13px] font-semibold">{def.label} <span className="font-normal text-muted-foreground">· {def.sub}</span></div>
                        {members.map((member, index) => (
                          <div key={member.user.id} className="mt-1 flex items-center gap-2 text-xs">
                            <span className="w-16 shrink-0 truncate font-medium">{member.user.name}</span>
                            <div className="h-2 min-w-0 flex-1 rounded-full bg-slate-100">
                              <div className={cn("h-2 rounded-full", BAR[bars[index]?.tone ?? "neutral"])} style={{ width: `${bars[index]?.pct ?? 0}%` }} />
                            </div>
                            <span className="w-[72px] shrink-0 text-right font-mono font-semibold">{def.value(member)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>

                {/* Máy tính: bảng */}
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Chỉ số</th>
                        {members.map((member) => <th key={member.user.id} className="px-3 py-2 font-medium">{member.user.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {METRICS.map((def) => {
                        const bars = metricBars(def, members);
                        return (
                          <tr key={def.key} className="border-b last:border-b-0">
                            <td className="py-2 pr-3">
                              <div className="font-medium">{def.label}</div>
                              <div className="text-xs text-muted-foreground">{def.sub}</div>
                            </td>
                            {members.map((member, index) => (
                              <td key={member.user.id} className="px-3 py-2">
                                <div className="font-mono font-semibold">{def.value(member)}</div>
                                <div className="mt-1 h-1.5 w-full max-w-[160px] rounded-full bg-slate-100">
                                  <div className={cn("h-1.5 rounded-full", BAR[bars[index]?.tone ?? "neutral"])} style={{ width: `${bars[index]?.pct ?? 0}%` }} />
                                </div>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="space-y-3">
                <Card label="Nhật ký ngày công">
                  <CardTitle>Nhật ký ngày công</CardTitle>
                  {members.map((member) => (
                    <div key={member.user.id} className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-semibold">
                        <PersonAvatar name={member.user.name} size="sm" />{member.user.name}
                      </div>
                      <Heatmap member={member} />
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-slate-700">
                    {[["bg-emerald-600", "Có công"], ["bg-amber-400", "Phép"], ["bg-red-500", "Không có công"], ["bg-slate-200", "CN/lễ"]].map(([cls, text]) => (
                      <span key={text} className="flex items-center gap-1"><span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-sm", cls)} />{text}</span>
                    ))}
                  </div>
                </Card>

                <Card label="Toà quá hạn ghé trong kỳ">
                  <CardTitle>Toà quá hạn ghé trong kỳ</CardTitle>
                  {members.map((member) => (
                    <div key={member.user.id}>
                      <div className="mb-1 text-xs font-semibold">{member.user.name} · {member.overdue.buildings} toà · {member.overdue.times} lần</div>
                      {member.overdue.items.length === 0 ? <p className="text-xs text-muted-foreground">Không có toà nào quá hạn.</p> : null}
                      <ul className="list-none space-y-1">
                        {member.overdue.items.slice(0, 6).map((item) => (
                          <li key={item.building_id} className="flex items-center gap-2 text-[13px]">
                            <span className="min-w-0 flex-1 truncate">{item.building_name}</span>
                            <span className="text-xs text-muted-foreground">{item.times} lần</span>
                            <StatusPill tone="warning">{item.max_gap_days} ngày</StatusPill>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </Card>
              </div>
            </div>

            <Card label="Nhận xét và xếp loại tay">
              <CardTitle right="chỉ chủ thấy · không ảnh hưởng lương">Nhận xét & xếp loại</CardTitle>
              <div className="grid gap-2 lg:grid-cols-2">
                {members.map((member) => <ReviewBox key={member.user.id} member={member} from={query.data.from} to={query.data.to} />)}
              </div>
            </Card>

            <p className="text-center text-[11px] text-muted-foreground">Không tự chấm điểm tổng, không quy ra tiền.</p>
          </div>
        ) : null}
      </QueryRegion>
    </StaffShell>
  );
}
