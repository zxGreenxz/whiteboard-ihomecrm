import { useMemo, useState } from "react";
import { Check, ChevronRight, Cpu, Fingerprint, Loader2, ScrollText, Wifi, X } from "lucide-react";

import { useDoorActionLogs } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorAccessMode, DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage } from "@/lib/door-access/errors";
import { ACTION_LABEL, logDetailText, logStatus, type LogStatusTone } from "@/lib/door-access/format";
import { LOG_FILTERS, LOG_FILTER_ACTIONS, LOG_FILTER_LABEL, formatClock, groupByDay, permissionRows, type LogFilter } from "@/lib/door-access/mobile";
import { mergeLogPages } from "@/lib/door-access/view";

import { MobileError, MobileLoading, MobileNotice } from "./mobileParts";

export type ManageView = "menu" | "reconcile" | "devices" | "logs";

export function MobileManageMenu({
  device,
  mode,
  devices,
  canManageAnywhere,
  needsDelete,
  offlineCount,
  onOpen,
}: {
  device: DoorDevice | null;
  mode: Exclude<DoorAccessMode, "off">;
  devices: readonly DoorDevice[];
  canManageAnywhere: boolean;
  /** Số cần xoá ở máy đang chọn — chỉ khi đã đọc Đối chiếu (không gọi SmartLife chỉ để đếm). */
  needsDelete: number | null;
  offlineCount: number | null;
  onOpen: (view: Exclude<ManageView, "menu">) => void;
}) {
  const canView = Boolean(device?.can.view);
  const canDevices = canManageAnywhere || Boolean(device?.can.manage_devices);
  const buildings = new Set(devices.map((item) => item.building_id)).size;
  const deviceSub = `${devices.length} cửa ở ${buildings} toà${offlineCount ? `, ${offlineCount} cửa mất kết nối` : ""}`;

  return (
    <>
      {(canView || canDevices) && (
        <nav className="card rows" aria-label="Mục quản lý">
          {canView && (
            <button type="button" className="row" style={{ minHeight: 72 }} onClick={() => onOpen("reconcile")}>
              <span className="row-ic red">
                <Fingerprint className="h-[22px] w-[22px]" aria-hidden="true" />
              </span>
              <span className="row-main">
                <span className="row-t">Đối chiếu vân tay</span>
                <span className="row-s wrap">Khách đã trả phòng mà vân tay còn mở được cửa</span>
              </span>
              {needsDelete !== null && needsDelete > 0 && <span className="pill pill-alarm">{needsDelete} cần xoá</span>}
              <ChevronRight className="row-chev h-5 w-5" aria-hidden="true" />
            </button>
          )}
          {canDevices && (
            <button type="button" className="row" style={{ minHeight: 72 }} onClick={() => onOpen("devices")}>
              <span className="row-ic door">
                <Cpu className="h-[22px] w-[22px]" aria-hidden="true" />
              </span>
              <span className="row-main">
                <span className="row-t">Thiết bị</span>
                <span className="row-s">{deviceSub}</span>
              </span>
              <ChevronRight className="row-chev h-5 w-5" aria-hidden="true" />
            </button>
          )}
          {canView && (
            <button type="button" className="row" style={{ minHeight: 72 }} onClick={() => onOpen("logs")}>
              <span className="row-ic plain">
                <ScrollText className="h-[22px] w-[22px]" aria-hidden="true" />
              </span>
              <span className="row-main">
                <span className="row-t">Nhật ký thao tác</span>
                <span className="row-s">Ai mở cửa, tạo mã, xoá vân tay từ CRM</span>
              </span>
              <ChevronRight className="row-chev h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </nav>
      )}

      {device && (
        <section className="sec" aria-labelledby="dam-perm">
          <div className="sec-h">
            <h2 id="dam-perm">Quyền của bạn ở toà {device.building_name ?? "này"}</h2>
          </div>
          <ul className="card rows">
            {permissionRows(device.can).map((row) => (
              <li key={row.key} className="row" style={{ minHeight: 48 }}>
                {row.granted ? (
                  <Check className="perm-yes h-[18px] w-[18px]" aria-label="Có quyền" />
                ) : (
                  <X className="perm-no h-[18px] w-[18px]" aria-label="Chưa có quyền" />
                )}
                <span className={row.granted ? "row-main font-semibold" : "row-main font-semibold mute"}>{row.label}</span>
                {row.note && <span className="row-s" style={{ margin: 0 }}>{row.note}</span>}
              </li>
            ))}
          </ul>
          <p className="hint mx-0.5">Chủ công ty đổi quyền theo từng toà ở trang Phân quyền.</p>
        </section>
      )}

      <section className="sec" aria-labelledby="dam-conn">
        <div className="sec-h">
          <h2 id="dam-conn">Kết nối SmartLife</h2>
        </div>
        <div className="card flex items-center gap-3 px-3.5 py-3">
          <Wifi className="h-5 w-5 shrink-0 text-[var(--brand)]" aria-hidden="true" />
          <span className="row-main">
            <span className="row-t">{mode === "all" ? "Đang chạy đủ" : "Chỉ đọc"}</span>
            <span className="row-s wrap">
              {mode === "all"
                ? "Xem lịch sử và thao tác trên máy. Một tài khoản SmartLife cho cả công ty."
                : "Xem được lịch sử, mã, vân tay; chưa mở cửa, tạo hay xoá được trên máy."}
            </span>
          </span>
          <span className={mode === "all" ? "pill pill-ok" : "pill pill-temp"}>
            <span className="dot" aria-hidden="true" />
            {mode === "all" ? "Bật" : "Chỉ đọc"}
          </span>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Nhật ký thao tác

const STATUS_PILL: Record<LogStatusTone, string> = {
  ok: "pill pill-ok",
  failed: "pill pill-fail",
  unknown: "pill pill-unknown",
  pending: "pill pill-run",
};

export function MobileActionLog({ caller, device }: { caller: DoorAccessCaller; device: DoorDevice }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const logs = useDoorActionLogs(caller, device.id, LOG_FILTER_ACTIONS[filter]);
  const now = Date.now();
  const days = useMemo(() => {
    const rows = mergeLogPages(logs.data?.pages ?? []).map((log) => {
      const at = Date.parse(log.created_at);
      return { log, at: Number.isFinite(at) ? at : null };
    });
    return groupByDay(rows, Date.now());
  }, [logs.data]);

  return (
    <>
      <div className="hscroll" role="group" aria-label="Lọc theo thao tác">
        {LOG_FILTERS.map((item) => (
          <button key={item} type="button" className="chip" aria-pressed={filter === item} onClick={() => setFilter(item)}>
            {LOG_FILTER_LABEL[item]}
          </button>
        ))}
      </div>
      {logs.data === undefined && logs.isPending && <MobileLoading text="Đang tải nhật ký…" />}
      {logs.data === undefined && logs.isError && <MobileError error={logs.error} title="Chưa tải được nhật ký thao tác" onRetry={() => void logs.refetch()} />}
      {logs.data !== undefined && days.length === 0 && <div className="card empty">Chưa có thao tác nào từ CRM khớp bộ lọc trên cửa này.</div>}
      {days.map((day) => (
        <section key={day.key} className="sec" aria-label={day.title}>
          <div className="sec-h">
            <h2>{day.title}</h2>
          </div>
          <ul className="card rows">
            {day.rows.map(({ log, at }) => {
              const status = logStatus(log, now);
              const detail = logDetailText(log);
              return (
                <li key={log.id} className="row" style={{ alignItems: "flex-start", paddingTop: 12, paddingBottom: 12 }}>
                  <span className="row-time" style={{ paddingTop: 1 }}>
                    {at === null ? "—" : formatClock(at)}
                  </span>
                  <span className="row-main">
                    <span className="row-t">{ACTION_LABEL[log.action]}</span>
                    {detail && <span className="row-s wrap">{detail}</span>}
                    {log.status !== "OK" && log.error_message && (
                      <span className="row-s wrap" style={{ color: "var(--red)" }}>
                        {log.error_code ? `${log.error_code}: ` : ""}
                        {log.error_message}
                      </span>
                    )}
                    <span className="row-s">{log.actor_name ?? "Không rõ người làm"}</span>
                  </span>
                  <span className={STATUS_PILL[status.tone]}>{status.label}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {logs.hasNextPage && (
        <button type="button" className="btn btn-ghost btn-block" disabled={logs.isFetchingNextPage} onClick={() => void logs.fetchNextPage()}>
          {logs.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
          Tải thêm
        </button>
      )}
      {logs.data !== undefined && logs.isFetchNextPageError && (
        <MobileNotice tone="danger">Chưa tải thêm được: {doorErrorMessage(logs.error)} Bấm Tải thêm để thử lại.</MobileNotice>
      )}
      {logs.data !== undefined && logs.isRefetchError && <MobileNotice tone="warn">Chưa làm mới được — đang hiện nhật ký lần trước.</MobileNotice>}
      <p className="hint mx-0.5">Chỉ ghi thao tác làm từ CRM. Thao tác trong app SmartLife không có ở đây. Nhật ký không lưu mã.</p>
    </>
  );
}
