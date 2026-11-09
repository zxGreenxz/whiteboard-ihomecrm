// Màn 2 — «Một quản lý · hiện tại». Chỉ xem.
import { Link, useParams } from "react-router-dom";
import { Building2, CheckCircle2, CircleDashed, ClipboardList, Clock, Flame, MapPin, Route } from "lucide-react";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle, PersonAvatar, StaffHeader, StaffShell, StatusPill } from "@/components/staff-day/StaffShell";
import { PersonPicker } from "@/components/staff-day/PersonPicker";
import { SlotLegend, SlotStrip } from "@/components/staff-day/SlotStrip";
import { StaffThumb } from "@/components/staff-day/StaffThumb";
import { useStaffDayRoute, useStaffDaySummary } from "@/hooks/staff-day/useStaffDay";
import {
  dayTitle, eventRow, formatDistance, gpsReasonLabel, minutesBetween, photoCounts, tickSourceLabel, vnDateOf, vnTime,
  type StaffRouteItem, type StaffSummary,
} from "@/lib/staffDay";

function DayCard({ summary }: { summary: StaffSummary }) {
  const { day, streak, attend } = summary;
  const ticked = day.status === "ticked";
  const leave = day.status === "leave_approved" || day.status === "pending_leave";
  const Icon = ticked ? CheckCircle2 : CircleDashed;
  const title = ticked
    ? `Đã có ngày công${day.ticked_at ? ` lúc ${vnTime(day.ticked_at)}` : ""}`
    : leave ? "Ngày nghỉ phép" : "Chưa có ngày công hôm nay";
  return (
    <section aria-label="Ngày công hôm nay" className={`flex items-center gap-3 rounded-2xl p-4 ${ticked ? "bg-primary text-primary-foreground" : leave ? "bg-sky-100 text-sky-900" : "bg-amber-100 text-amber-900"}`}>
      <Icon className="h-9 w-9 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold">{title}</div>
        {ticked ? <div className="truncate text-[13px] opacity-90">nguồn: {tickSourceLabel(day.tick_source)}{day.building_name ? ` · ${day.building_name}` : ""}</div> : null}
        <div className="mt-1.5 flex items-center gap-1.5 text-xs opacity-90">
          <Flame className="h-3.5 w-3.5" aria-hidden="true" />
          {streak ? `Chuỗi ${streak.current} ngày · ` : ""}tháng này {attend.ticked_days}{attend.n_chuan != null ? `/${attend.n_chuan}` : ""} ngày công
        </div>
      </div>
    </section>
  );
}

function NowCard({ now }: { now: NonNullable<StaffSummary["now"]> }) {
  const counts = photoCounts(now.photos);
  const shown = now.photos.slice(0, 4);
  const more = now.photos.length - shown.length;
  return (
    <Card label="Đang làm bây giờ" className="border-emerald-200">
      <CardTitle
        icon={<span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-600 ring-4 ring-emerald-500/20" />}
        right={`từ ${vnTime(now.started_at)} · ${minutesBetween(now.started_at)} phút`}
      >
        Đang làm bây giờ
      </CardTitle>
      <div className="flex items-center gap-2.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-emerald-50 text-emerald-800">
          <Building2 className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">Kiểm tra nhà {now.building_name} · {now.type === "FULL" ? "FULL" : "nhanh"}</div>
          <div className="text-xs text-muted-foreground">
            {now.items_done}/{now.items_total} mục đã chụp{now.items_missing.length ? ` · còn ${now.items_missing.slice(0, 3).join(", ")}` : ""}
          </div>
        </div>
      </div>
      {counts.total > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {counts.ok > 0 ? <StatusPill tone="success">{counts.ok} ảnh GPS khớp</StatusPill> : null}
          {counts.outOfRange > 0 ? <StatusPill tone="warning">{counts.outOfRange} ảnh ngoài vùng{counts.maxOutOfRange ? ` · ${formatDistance(counts.maxOutOfRange)}` : ""}</StatusPill> : null}
          {counts.denied > 0 ? <StatusPill tone="neutral">{counts.denied} ảnh thiếu GPS</StatusPill> : null}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <div className="flex gap-1" aria-label="Ảnh đã chụp trong phiên">
          {shown.map((photo) => (
            <StaffThumb key={photo.path} path={photo.path} label={photo.label ?? photo.slot} outOfRange={photo.geofence_status === "out_of_range"} />
          ))}
          {more > 0 ? <div className="flex h-14 min-w-0 flex-1 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-100 text-[11px] font-semibold text-muted-foreground">+{more}</div> : null}
        </div>
      ) : null}
    </Card>
  );
}

function RouteCard({ items }: { items: readonly StaffRouteItem[] }) {
  const visited = items.filter((item) => item.visited_today);
  const remaining = items.filter((item) => !item.visited_today && item.priority_bucket <= 1);
  if (visited.length + remaining.length === 0) return null;
  return (
    <Card label="Còn phải ghé hôm nay">
      <CardTitle icon={<Route className="h-[18px] w-[18px] text-blue-500" aria-hidden="true" />} right="tuyến gợi ý">
        Còn phải ghé hôm nay · {remaining.length}/{visited.length + remaining.length}
      </CardTitle>
      {remaining.map((item) => (
        <div key={item.building_id} className="flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2">
          <span className="min-w-0 flex-1 truncate font-semibold">{item.building_name}</span>
          <span className="text-xs text-muted-foreground">
            {item.priority_bucket === 0
              ? (item.days_since_full == null ? "chưa FULL lần nào" : `${item.days_since_full} ngày chưa FULL`)
              : (item.days_since_touch == null ? "chưa ghé lần nào" : `ghé ${item.days_since_touch} ngày trước`)}
          </span>
          <StatusPill tone={item.priority_bucket === 0 ? "warning" : "info"}>{item.priority_bucket === 0 ? "đến nhịp" : "nên ghé"}</StatusPill>
        </div>
      ))}
      {visited.length > 0 ? (
        <div className="flex items-center gap-2.5 rounded-[10px] bg-emerald-50 px-2.5 py-2">
          <span className="min-w-0 flex-1 truncate font-semibold text-emerald-800">{visited.map((item) => item.building_name).join(" · ")}</span>
          <StatusPill tone="success">đã ghé</StatusPill>
        </div>
      ) : null}
    </Card>
  );
}

function GpsCard({ gps }: { gps: NonNullable<StaffSummary["gps"]> }) {
  const windows = gps.windows.map((w) => `${w.from}–${w.to}`).join(" · ");
  const missing = gps.slots.filter((s) => s.status === "missing").slice(-1)[0];
  return (
    <Card label={`Điểm danh tự động ${gps.interval_min ?? ""} phút`}>
      <CardTitle icon={<Clock className="h-[18px] w-[18px] text-primary" aria-hidden="true" />}>
        Điểm danh tự động{gps.interval_min ? ` · mỗi ${gps.interval_min} phút` : ""}
      </CardTitle>
      <p className="-mt-1 text-xs text-muted-foreground">Khung giờ: {windows}</p>
      {gps.paired ? (
        <>
          <SlotStrip gps={gps} />
          <SlotLegend showMock={gps.counts.mock > 0} />
          <p className="text-xs text-muted-foreground">
            {missing ? `Mốc ${vnTime(missing.at)} mất tín hiệu: ${gpsReasonLabel(missing.reason)}. ` : ""}
            App trên máy tự ghi, kể cả khi khoá màn hình. Ngoài khung giờ điểm danh tính theo việc đã xong hoặc lượt check nhà.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Người này chưa cài app điểm danh nên chưa có dấu nào.</p>
      )}
    </Card>
  );
}

export default function StaffDayPage() {
  const { userId } = useParams<{ userId: string }>();
  const summaryQuery = useStaffDaySummary(userId);
  const routeQuery = useStaffDayRoute(userId);
  const summary = summaryQuery.data;
  const todayKey = summary?.date ?? vnDateOf();
  const name = summary?.user.name ?? "";
  const events = summary?.recent_events.slice(0, 3) ?? [];

  return (
    <StaffShell>
      <StaffHeader
        backTo="/my-day/team"
        backLabel="Về cả đội"
        title={`${name || "Quản lý"} · hôm nay`}
        sub={`${dayTitle(todayKey)}${summary ? ` · cập nhật ${vnTime(summary.as_of)}` : ""}`}
        right={name ? <PersonAvatar name={name} /> : undefined}
      />
      <PersonPicker active={userId ?? ""} />

      <QueryRegion label="việc của người này" skeleton="list" rows={4} queries={[summaryQuery, routeQuery]}>
        {summary ? (
          <div className="space-y-3">
            <DayCard summary={summary} />
            {summary.now ? <NowCard now={summary.now} /> : null}

            <Card label="Dấu chân gần nhất">
              <CardTitle
                icon={<MapPin className="h-[18px] w-[18px] text-blue-500" aria-hidden="true" />}
                right={<Link to={`/my-day/nguoi/${userId}/hanh-trinh`} className="text-xs font-semibold text-primary">Cả ngày →</Link>}
              >
                Dấu chân gần nhất
              </CardTitle>
              {events.length === 0 ? <p className="text-sm text-muted-foreground">Chưa có dấu chân nào hôm nay.</p> : null}
              {events.map((event) => {
                const row = eventRow(event, todayKey);
                return (
                  <div key={row.key} className="flex items-start gap-2.5 border-t py-2 first:border-t-0">
                    <span className="w-[42px] shrink-0 pt-0.5 font-mono text-xs font-semibold">{row.time}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px]">{row.title}</div>
                      {row.sub ? <div className="text-[11px] text-muted-foreground">{row.sub}</div> : null}
                    </div>
                  </div>
                );
              })}
            </Card>

            {summary.gps?.enabled ? <GpsCard gps={summary.gps} /> : null}
            {routeQuery.data ? <RouteCard items={routeQuery.data.items} /> : null}

            {summary.open_jobs.total > 0 ? (
              <Card label="Việc đang mở">
                <CardTitle
                  icon={<ClipboardList className="h-[18px] w-[18px] text-violet-600" aria-hidden="true" />}
                  right={<Link to="/tasks" className="text-xs font-semibold text-primary">Mở Công việc →</Link>}
                >
                  Việc đang mở · {summary.open_jobs.total}
                </CardTitle>
                {summary.open_jobs.items.map((job) => {
                  const late = job.deadline != null && vnDateOf(job.deadline) < todayKey;
                  const dueToday = job.deadline != null && vnDateOf(job.deadline) === todayKey;
                  return (
                    <div key={job.id} className="flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]"><b>{job.title}</b>{job.building_name ? <span className="text-muted-foreground"> · {job.building_name}</span> : null}</span>
                      {late ? <StatusPill tone="danger">trễ hạn</StatusPill> : dueToday ? <StatusPill tone="warning">hạn hôm nay</StatusPill> : null}
                    </div>
                  );
                })}
              </Card>
            ) : null}

            <div className="flex gap-2">
              <Link to={`/my-day/nguoi/${userId}/hanh-trinh`} className="flex h-11 flex-1 items-center justify-center rounded-[10px] bg-primary text-[13px] font-semibold text-primary-foreground">Hành trình hôm nay</Link>
              <Link to={`/my-day/nguoi/${userId}/lich`} className="flex h-11 flex-1 items-center justify-center rounded-[10px] border bg-white text-[13px] font-semibold">Lịch tháng</Link>
            </div>
          </div>
        ) : null}
      </QueryRegion>
    </StaffShell>
  );
}
