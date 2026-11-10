// Màn 7 — Điểm danh tự động, phía quản lý: tình trạng máy, các mốc hôm nay, ghép máy.
import { useState } from "react";
import { CheckCircle2, Clock, Crosshair, Download, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Card, CardTitle, StaffHeader, StaffShell, StatusPill } from "@/components/staff-day/StaffShell";
import { useGpsMyStatus, useRevokeGpsDevice, useStartGpsPair } from "@/hooks/gps-checkin/useGpsCheckin";
import { actionErrorMessage } from "@/lib/actionFeedback";
import { GPS_CHECKIN_APK, deviceSilent, pairDeepLink, permissionLabel, type GpsDevice, type GpsMyStatus } from "@/lib/gpsCheckin";
import { formatDistance, gpsReasonLabel, vnTime, type GpsSlot } from "@/lib/staffDay";

function HealthRow({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-center gap-2.5 border-t py-2 first:border-t-0">
      <Icon className={ok ? "h-[18px] w-[18px] shrink-0 text-emerald-700" : "h-[18px] w-[18px] shrink-0 text-orange-700"} aria-hidden="true" />
      <span className="flex-1 text-[13px] font-semibold">{title}</span>
      <span className="text-right text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function slotLine(slot: GpsSlot): { text: string; where: string; warn: boolean } {
  if (slot.status === "ok" || slot.status === "ok_stationary") {
    const near = slot.nearest_building_name && slot.nearest_distance_m != null
      ? `gần ${slot.nearest_building_name} · ${formatDistance(slot.nearest_distance_m)}` : "đang di chuyển";
    return { text: slot.status === "ok" ? "Tự ghi" : "Tự ghi — máy đứng yên", where: near, warn: false };
  }
  if (slot.status === "paused") return { text: "Đã tạm dừng", where: "", warn: true };
  if (slot.status === "pending") return { text: "Chờ máy gửi", where: "", warn: false };
  return { text: `Mất tín hiệu — ${gpsReasonLabel(slot.reason)}`, where: "", warn: true };
}

function PairCard({ hasDevice }: { hasDevice: boolean }) {
  const start = useStartGpsPair();
  const code = start.data;
  const begin = async () => {
    try {
      await start.mutateAsync();
    } catch (error) {
      toast.error(actionErrorMessage(error, "Chưa tạo được mã ghép máy"));
    }
  };
  return (
    <Card label="Cài app và ghép máy">
      <CardTitle icon={<Download className="h-[18px] w-[18px] text-primary" aria-hidden="true" />}>{hasDevice ? "Ghép máy khác" : "Cài app và ghép máy"}</CardTitle>
      <ol className="ml-4 list-decimal space-y-1 text-[13px] text-slate-700">
        <li>Tải app <a className="font-semibold text-primary underline" href={GPS_CHECKIN_APK.url}>iHome Điểm danh {GPS_CHECKIN_APK.version}</a> về máy Android rồi cài.</li>
        <li>Bấm «Tạo mã ghép máy», rồi mở app bằng nút bên dưới. Nếu đang dùng máy khác, gõ mã vào app.</li>
        <li>Trong app, cho phép vị trí «Luôn cho phép» và tắt tiết kiệm pin cho app.</li>
      </ol>
      {code ? (
        <div className="space-y-2 rounded-xl bg-slate-100 p-3 text-center">
          <div className="font-mono text-2xl font-bold tracking-widest">{code.code}</div>
          <div className="text-xs text-muted-foreground">Dùng một lần, hết hạn lúc {vnTime(code.expires_at)}</div>
          <a href={pairDeepLink(code.code)} className="flex h-11 items-center justify-center rounded-[10px] bg-primary text-sm font-semibold text-primary-foreground">Mở app để ghép</a>
        </div>
      ) : (
        <Button type="button" className="h-11" disabled={start.isPending} onClick={() => { void begin(); }}>Tạo mã ghép máy</Button>
      )}
      {hasDevice ? <p className="text-xs text-muted-foreground">Ghép máy mới thì máy cũ tự ngừng gửi.</p> : null}
    </Card>
  );
}

function DeviceCards({ status, device }: { status: GpsMyStatus; device: GpsDevice }) {
  const slots = status.today?.slots ?? [];
  const past = slots.filter((s) => s.status !== "future").reverse();
  const last = past.find((s) => s.status === "ok" || s.status === "ok_stationary");
  const next = slots.find((s) => s.status === "future");
  const state = device.state;
  const silent = deviceSilent(device);
  const paused = state.paused === true;
  const windows = status.settings?.windows.map(([from, to]) => `${from}–${to}`).join(" và ") ?? "";
  const got = (status.today?.counts.ok ?? 0) + (status.today?.counts.stationary ?? 0);
  const lost = status.today?.counts.missing ?? 0;
  const revoke = useRevokeGpsDevice();
  const [confirming, setConfirming] = useState(false);
  const remove = async () => {
    try {
      await revoke.mutateAsync(device.id);
      toast.success("Đã gỡ máy này khỏi điểm danh");
    } catch (error) {
      toast.error(actionErrorMessage(error, "Chưa gỡ được máy"));
    }
  };

  return (
    <>
      <Card label="Trạng thái điểm danh tự động">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-800">
            <Crosshair className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold">{paused ? "Đang tạm dừng" : silent ? "Máy chưa báo về" : "Máy đang tự ghi vị trí"}</div>
            <div className="text-xs text-muted-foreground">{paused ? "bạn đã bấm tạm dừng trong app" : silent ? "mở app trên máy để kiểm tra" : "bạn không phải bấm gì"}</div>
          </div>
          <StatusPill tone={paused || silent ? "warning" : "success"}>{paused ? "tạm dừng" : silent ? "im lặng" : "đang chạy"}</StatusPill>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
            <div className="text-[11px] text-emerald-800">Dấu gần nhất</div>
            <div className="font-mono text-[22px] font-semibold tracking-tight">{last ? vnTime(last.at) : "—"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {last?.nearest_building_name && last.nearest_distance_m != null ? `gần ${last.nearest_building_name} · ${formatDistance(last.nearest_distance_m)}` : "chưa có hôm nay"}
            </div>
          </div>
          <div className="rounded-xl bg-slate-100 px-3 py-2.5">
            <div className="text-[11px] text-muted-foreground">Mốc kế tiếp</div>
            <div className="font-mono text-[22px] font-semibold tracking-tight">{next ? vnTime(next.at) : "—"}</div>
            <div className="text-xs text-muted-foreground">kể cả khi khoá màn hình</div>
          </div>
        </div>
        {windows ? (
          <p className="rounded-[10px] bg-slate-100 px-2.5 py-2 text-xs text-slate-700">
            Khung giờ hôm nay: <b>{windows}</b>. Ngoài khung giờ máy không ghi; điểm danh tính theo việc đã xong hoặc lượt check nhà.
          </p>
        ) : null}
      </Card>

      <Card label="Tình trạng máy của bạn" className="gap-1">
        <CardTitle>Máy của bạn</CardTitle>
        <HealthRow ok title="App điểm danh" detail={`đã ghép${state.model ? ` · ${state.model}` : ""}`} />
        <HealthRow ok={state.locationPermission === "always"} title="Quyền vị trí" detail={permissionLabel(state.locationPermission)} />
        <HealthRow ok={state.batteryOptimizationIgnored === true} title="Chạy nền" detail={state.batteryOptimizationIgnored ? "không bị tiết kiệm pin chặn" : "cần tắt tiết kiệm pin cho app"} />
        <HealthRow ok={(state.batteryPct ?? 100) > 15} title="Pin" detail={state.batteryPct != null ? `${state.batteryPct}%` : "chưa rõ"} />
      </Card>

      <Card label="Điểm danh hôm nay" className="gap-1">
        <CardTitle icon={<Clock className="h-[18px] w-[18px] text-primary" aria-hidden="true" />} right={`${got} có dấu · ${lost} mất tín hiệu`}>Hôm nay</CardTitle>
        {past.length === 0 ? <p className="py-2 text-sm text-muted-foreground">Chưa tới mốc nào hôm nay.</p> : null}
        {past.map((slot) => {
          const line = slotLine(slot);
          return (
            <div key={slot.at} className="flex items-center gap-2.5 border-t py-2 first:border-t-0">
              <span className="w-[42px] shrink-0 font-mono text-xs font-semibold">{vnTime(slot.at)}</span>
              <span aria-hidden="true" className={line.warn ? "h-2.5 w-2.5 shrink-0 rounded-full bg-orange-600" : "h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-600"} />
              <span className={line.warn ? "min-w-0 flex-1 text-[13px] text-orange-700" : "min-w-0 flex-1 text-[13px]"}>{line.text}</span>
              {line.where ? <span className="max-w-[45%] truncate text-[11px] text-muted-foreground">{line.where}</span> : null}
            </div>
          );
        })}
        <p className="mt-1.5 text-xs text-muted-foreground">Mốc mất tín hiệu không trừ gì vào lương; chủ chỉ thấy là thiếu một dấu, kèm lý do máy báo.</p>
      </Card>

      <div className="flex justify-end">
        {confirming ? (
          <div className="flex items-center gap-2 text-sm">
            <span>Gỡ máy này khỏi điểm danh?</span>
            <Button type="button" size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => { void remove(); }}>Gỡ máy</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>Thôi</Button>
          </div>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>Gỡ máy này</Button>
        )}
      </div>
    </>
  );
}

export default function GpsCheckinPage() {
  const query = useGpsMyStatus();
  const status = query.data;
  const interval = status?.settings?.intervalMin;
  const active = status?.eligible && status.settings?.enabled && status.settings.applies;

  return (
    <StaffShell>
      <StaffHeader
        backTo="/my-day"
        backLabel="Quay lại"
        title="Điểm danh tự động"
        sub={interval ? `GPS trên máy bạn · mỗi ${interval} phút trong khung giờ chủ đặt` : "GPS trên máy bạn"}
      />

      <QueryRegion label="điểm danh tự động" skeleton="list" rows={4} queries={[query]}>
        {status && !active ? (
          <Card label="Chưa áp dụng">
            <p className="text-sm text-muted-foreground">
              {status.eligible ? "Công ty chưa bật điểm danh tự động cho bạn." : "Tài khoản này không thuộc danh sách điểm danh tự động."}
            </p>
          </Card>
        ) : null}

        {status && active ? (
          <div className="space-y-3">
            {status.device ? <DeviceCards status={status} device={status.device} /> : null}
            <PairCard hasDevice={!!status.device} />

            <Card label="Máy ghi những gì">
              <CardTitle icon={<ShieldCheck className="h-[18px] w-[18px] text-primary" aria-hidden="true" />}>Máy ghi những gì</CardTitle>
              <ul className="ml-4 list-disc space-y-1 text-[13px] text-slate-700">
                <li>App tự ghi vị trí theo mốc trong khung giờ điểm danh do chủ đặt, kể cả khi khoá màn hình.</li>
                <li>Ngoài khung giờ app không lấy vị trí, chỉ báo tình trạng máy (pin, quyền) để biết app còn chạy; lúc đó điểm danh tính theo việc đã xong hoặc lượt check nhà.</li>
                <li>Chủ công ty xem được các dấu này cùng với ảnh kiểm tra nhà và phiếu thu tiền.</li>
                <li>Bạn tạm dừng được trong app; khi đó các mốc ghi là «đã tắt» và chủ nhìn thấy.</li>
              </ul>
            </Card>
          </div>
        ) : null}
      </QueryRegion>
    </StaffShell>
  );
}
