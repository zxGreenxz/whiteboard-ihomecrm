// Màn 3 — Hành trình một ngày: bản đồ, dòng thời gian, tổng kết.
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle, StaffHeader, StaffShell } from "@/components/staff-day/StaffShell";
import { JourneyMap } from "@/components/staff-day/JourneyMap";
import { JourneyTimeline } from "@/components/staff-day/JourneyTimeline";
import { useStaffJourney } from "@/hooks/staff-day/useStaffDay";
import {
  addDays, dayTitle, gpsCountsText, gpsMockText, journeyStops, journeyTotals, outOfRangePoints, timelineRows, vnDateOf, vnTime,
} from "@/lib/staffDay";

const pagerButton = "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 disabled:opacity-50";

export default function StaffJourneyPage() {
  const { userId } = useParams<{ userId: string }>();
  const [params, setParams] = useSearchParams();
  const today = vnDateOf();
  const raw = params.get("ngay");
  const day = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && raw <= today ? raw : today;
  const isToday = day === today;
  const query = useStaffJourney(userId, day, isToday);
  const data = query.data;

  const events = useMemo(() => data?.events ?? [], [data]);
  const slots = useMemo(() => data?.gps?.slots ?? [], [data]);
  const stops = useMemo(() => journeyStops(events), [events]);
  const outOfRange = useMemo(() => outOfRangePoints(events), [events]);
  const rows = useMemo(() => timelineRows(events, slots, day), [events, slots, day]);
  const totals = useMemo(() => journeyTotals(events), [events]);
  const name = data?.user.name ?? "Quản lý";
  const go = (delta: number) => {
    const next = addDays(day, delta);
    setParams(next === today ? {} : { ngay: next }, { replace: true });
  };
  const gps = data?.gps;

  return (
    <StaffShell>
      <StaffHeader
        backTo={`/my-day/nguoi/${userId}`}
        backLabel="Quay lại"
        title={`Hành trình · ${name}`}
        sub="dấu chân theo giờ · ảnh · GPS"
        right={
          <Link to={`/my-day/nguoi/${userId}/lich?thang=${day.slice(0, 7)}`} aria-label="Mở lịch tháng" className="flex h-10 w-10 items-center justify-center rounded-full border bg-white text-primary">
            <CalendarDays className="h-5 w-5" aria-hidden="true" />
          </Link>
        }
      />

      <div className="flex items-center gap-2 rounded-xl border bg-white p-1.5">
        <button type="button" aria-label="Ngày trước" className={pagerButton} onClick={() => go(-1)}>
          <ChevronLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="font-bold">{dayTitle(day)}/{day.slice(0, 4)}</div>
          <div className="text-[11px] text-muted-foreground">{isToday ? "hôm nay · đang cập nhật" : "đã qua"}</div>
        </div>
        <button type="button" aria-label="Ngày sau" className={pagerButton} disabled={isToday} onClick={() => go(1)}>
          <ChevronRight className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>

      <QueryRegion label="hành trình trong ngày" skeleton="list" rows={5} queries={[query]}>
        <div className="space-y-3">
          <JourneyMap stops={stops} slots={slots} outOfRange={outOfRange} />

          <Card label="Dòng thời gian trong ngày" className="pb-1.5">
            <CardTitle
              icon={<Clock className="h-[18px] w-[18px] text-primary" aria-hidden="true" />}
              right={data ? `${rows.length} sự kiện${isToday ? ` · tới ${vnTime(data.as_of)}` : ""}` : undefined}
            >
              Theo giờ
            </CardTitle>
            <JourneyTimeline rows={rows} />
          </Card>

          {data ? (
            <section aria-label="Tổng kết ngày" className="space-y-2 rounded-2xl bg-emerald-100/70 p-3.5">
              <h2 className="font-bold text-emerald-900">{isToday ? `Tổng kết tới ${vnTime(data.as_of)}` : "Tổng kết ngày"}</h2>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
                <span>Kiểm tra nhà: <b>{totals.sessionsPassed} đạt{totals.sessionsOpen ? ` · ${totals.sessionsOpen} đang làm` : ""}</b></span>
                <span>Thu tiền: <b>{totals.payments} phiếu</b></span>
                <span>Việc hoàn thành: <b>{totals.jobs}</b></span>
                <span>Điểm danh: <b>{gps && gps.counts.ok + gps.counts.stationary + gps.counts.missing > 0 ? gpsCountsText(gps.counts) : "—"}</b>{gpsMockText(gps?.counts) ? <b className="text-red-700"> · {gpsMockText(gps?.counts)}</b> : null}</span>
                <span>Ảnh thiếu GPS: <b>{totals.photosNoGps}</b></span>
                <span>Thời gian ở toà: <b>{totals.dwellMinutes} phút</b></span>
              </div>
            </section>
          ) : null}
        </div>
      </QueryRegion>
    </StaffShell>
  );
}
