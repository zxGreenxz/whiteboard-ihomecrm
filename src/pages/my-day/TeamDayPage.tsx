// Màn 1 — «Ngày hôm nay» của cả đội, cho Chủ công ty/super admin.
import { Link } from "react-router-dom";
import { AlertTriangle, BarChart3, ChevronRight, Clock, MapPin, Settings2 } from "lucide-react";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle, PersonAvatar, StaffHeader, StaffShell, StatTile, StatusPill } from "@/components/staff-day/StaffShell";
import { PersonPicker } from "@/components/staff-day/PersonPicker";
import { useStaffDayTeam } from "@/hooks/staff-day/useStaffDay";
import {
  addDays, dayBadge, dayTitle, eventRow, gpsCountsText, gpsMockText, minutesBetween, shortDate, vnDateOf, vnTime, type StaffTeamMember,
} from "@/lib/staffDay";

const linkBase = "flex h-10 flex-1 items-center justify-center rounded-lg text-[13px] font-semibold";

function lastEventText(member: StaffTeamMember, todayKey: string) {
  const event = member.last_event;
  if (!event) return null;
  const eventDay = vnDateOf(event.at);
  const when = eventDay === todayKey ? vnTime(event.at)
    : eventDay === addDays(todayKey, -1) ? `hôm qua ${vnTime(event.at)}`
      : `${shortDate(eventDay)} ${vnTime(event.at)}`;
  return { when, title: eventRow(event, eventDay).title };
}

function MemberCard({ member, todayKey }: { member: StaffTeamMember; todayKey: string }) {
  const badge = dayBadge(member.day);
  const last = lastEventText(member, todayKey);
  const gpsOn = member.gps.enabled && member.gps.paired;
  const expected = member.gps.counts.ok + member.gps.counts.stationary + member.gps.counts.missing;
  const route = `/my-day/nguoi/${member.user.id}`;
  const quietToday = !member.now && member.visited_today === 0 && member.jobs_done === 0;
  const mock = gpsMockText(member.gps.counts);
  return (
    <Card label={`${member.user.name} hôm nay`}>
      <div className="flex items-center gap-2.5">
        <PersonAvatar name={member.user.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold">{member.user.name}</div>
          <div className="truncate text-xs text-muted-foreground">{member.user.role_title ?? "Quản lý"} · {member.buildings_assigned} toà phụ trách</div>
        </div>
        <StatusPill tone={badge.tone}>{badge.label}</StatusPill>
      </div>

      {member.now ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-600 ring-4 ring-emerald-500/20" />
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="truncate font-semibold text-emerald-800">Đang kiểm tra {member.now.building_name} · {member.now.type === "FULL" ? "FULL" : "nhanh"}</div>
            <div className="text-muted-foreground">bắt đầu {vnTime(member.now.started_at)} · đã {minutesBetween(member.now.started_at)} phút · {member.now.photos_count} ảnh</div>
          </div>
        </div>
      ) : quietToday ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-800">
          <Clock className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Chưa có dấu chân nào hôm nay</div>
            {gpsOn ? <div>{member.gps.last_ok ? `dấu GPS gần nhất ${vnTime(member.gps.last_ok.at)}` : "chưa có dấu GPS"} · mất tín hiệu {member.gps.counts.missing}/{expected} mốc</div> : null}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Toà đã ghé" value={member.visited_today} of={member.visited_today + member.due_remaining} />
        <StatTile label="Việc xong" value={member.jobs_done} />
        <StatTile
          label={member.gps.interval_min ? `Điểm danh ${member.gps.interval_min}′` : "Điểm danh"}
          value={gpsOn && expected > 0 ? gpsCountsText(member.gps.counts) : "—"}
          alert={gpsOn && expected > 0 && member.gps.counts.missing > expected / 2}
        />
      </div>

      {mock ? (
        <div className="flex items-center gap-2 text-[13px] font-medium text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Điểm danh hôm nay: {mock}</span>
        </div>
      ) : null}

      {last ? (
        <div className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Dấu chân gần nhất <b className="text-foreground">{last.when}</b> · {last.title}</span>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Link to={route} className={`${linkBase} bg-primary text-primary-foreground`}>Hiện tại</Link>
        <Link to={`${route}/hanh-trinh`} className={`${linkBase} border bg-white`}>Hành trình</Link>
        <Link to={`${route}/lich`} className={`${linkBase} border bg-white`}>Lịch</Link>
      </div>
    </Card>
  );
}

export default function TeamDayPage() {
  const query = useStaffDayTeam();
  const data = query.data;
  const todayKey = data?.date ?? vnDateOf();
  const overdue = data?.overdue_buildings ?? [];
  const month = Number(todayKey.slice(5, 7));

  return (
    <StaffShell>
      <StaffHeader
        backTo="/"
        backLabel="Về trang chủ"
        title="Ngày hôm nay"
        sub={`${dayTitle(todayKey)} · xem với quyền chủ`}
        right={
          <Link to="/my-day/bao-cao" aria-label="Báo cáo đánh giá" className="flex h-10 w-10 items-center justify-center rounded-full border bg-white text-primary">
            <BarChart3 className="h-5 w-5" aria-hidden="true" />
          </Link>
        }
      />
      <PersonPicker active="team" />

      <QueryRegion label="việc của cả đội" skeleton="list" rows={4} queries={[query]}>
        {data && data.members.length === 0 ? (
          <Card label="Chưa có quản lý"><p className="text-sm text-muted-foreground">Chưa có quản lý nào đang chấm công v5 trong công ty này.</p></Card>
        ) : null}
        <div className="space-y-3">
          {data?.members.map((member) => <MemberCard key={member.user.id} member={member} todayKey={todayKey} />)}

          {overdue.length > 0 ? (
            <Card label="Toà quá hạn ghé hôm nay">
              <CardTitle icon={<AlertTriangle className="h-[18px] w-[18px] text-red-700" aria-hidden="true" />} right="chỉ chủ thấy">
                Toà quá hạn ghé · {overdue.length}
              </CardTitle>
              <div className="flex flex-col gap-1.5">
                {overdue.slice(0, 8).map((item) => (
                  <div key={item.building_id} className="flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2">
                    <span className="min-w-0 flex-1 truncate font-semibold">{item.building_name}</span>
                    <span className="max-w-[35%] truncate text-xs text-muted-foreground">{item.managers.join(", ")}</span>
                    <StatusPill tone={item.kind === "touch" ? "danger" : "warning"}>
                      {item.days == null ? (item.kind === "touch" ? "chưa ghé lần nào" : "chưa FULL lần nào") : `${item.kind === "full" ? "FULL " : ""}${item.days} ngày`}
                    </StatusPill>
                  </div>
                ))}
                {overdue.length > 8 ? <p className="text-center text-xs text-muted-foreground">và {overdue.length - 8} toà khác — xem ở báo cáo</p> : null}
              </div>
            </Card>
          ) : null}

          <Link to="/my-day/bao-cao" className="flex items-center gap-2.5 rounded-xl bg-emerald-100/70 px-3.5 py-3 text-[13px] font-semibold text-emerald-900">
            <BarChart3 className="h-[18px] w-[18px]" aria-hidden="true" />
            Báo cáo đánh giá tháng {month}
            <ChevronRight className="ml-auto h-4 w-4" aria-hidden="true" />
          </Link>
          <Link to="/my-day/diem-danh/cai-dat" className="flex items-center gap-2.5 rounded-xl border bg-white px-3.5 py-3 text-[13px] font-semibold">
            <Settings2 className="h-[18px] w-[18px] text-primary" aria-hidden="true" />
            Cài đặt điểm danh tự động
            <ChevronRight className="ml-auto h-4 w-4" aria-hidden="true" />
          </Link>
          <p className="text-center text-[11px] text-muted-foreground">Tự làm mới 30 giây/lần</p>
        </div>
      </QueryRegion>
    </StaffShell>
  );
}
