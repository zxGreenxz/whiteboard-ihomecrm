import { useMemo, type ReactNode } from "react";
import { ChevronDown, DoorOpen, History, KeyRound, RefreshCw } from "lucide-react";

import { useDoorKeyLinks, useDoorRecords, useDoorTempPasswordLogs } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { DEVICE_KIND_LABEL, vnDate } from "@/lib/door-access/format";
import { historyRow } from "@/lib/door-access/mobile";
import { indexLinks, indexTempPasswordNames, mergeRecordPages } from "@/lib/door-access/records";
import { indexTempPasswordLogs } from "@/lib/door-access/tempPassword";
import { historyRange } from "@/lib/door-access/view";

import { HoldDial } from "./HoldDial";
import { HistoryRows } from "./MobileHistory";
import { MobileSheet } from "./MobileSheet";
import type { DoorDialState } from "./useDoorDial";

export function OnlineMark({ online }: { online: boolean | null }) {
  if (online === true)
    return (
      <span className="online">
        <i aria-hidden="true" />
        Trực tuyến
      </span>
    );
  if (online === false)
    return (
      <span className="offline">
        <i aria-hidden="true" />
        Mất kết nối
      </span>
    );
  return null;
}

/** Thẻ "đang chọn cửa nào" — bấm để đổi cửa. */
export function DoorPickCard({
  device,
  online,
  locked,
  onOpen,
}: {
  device: DoorDevice;
  online: boolean | null;
  /** Đang gửi lệnh / chưa rõ kết quả: chưa đổi cửa được. */
  locked: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="card door-pick"
      aria-label={`Đang chọn ${device.display_name}${device.building_name ? `, toà ${device.building_name}` : ""}. Đổi cửa`}
      aria-disabled={locked ? "true" : undefined}
      title={locked ? "Đang chờ kết quả mở cửa — xem kết quả (bấm Đã hiểu) rồi mới đổi cửa" : undefined}
      onClick={() => !locked && onOpen()}
    >
      <span className={online === false ? "door-mark off" : "door-mark"}>
        <DoorOpen className="h-[22px] w-[22px]" aria-hidden="true" />
      </span>
      <span className="row-main">
        <span className="row-t" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="truncate">{device.display_name}</span>
          {device.building_name && <span className="pill-mono">{device.building_name}</span>}
        </span>
        <span className="row-s">{DEVICE_KIND_LABEL[device.device_kind]}</span>
      </span>
      <OnlineMark online={online} />
      <ChevronDown className="row-chev h-5 w-5" aria-hidden="true" />
    </button>
  );
}

function DoorDial({
  dial,
  device,
  onRecheck,
  onHistory,
  actions,
}: {
  dial: DoorDialState;
  device: DoorDevice;
  onRecheck: (() => void) | null;
  onHistory: (() => void) | null;
  actions: ReactNode;
}) {
  const { view } = dial;
  return (
    <>
      <HoldDial view={view} badge={dial.badge} label={dial.label} handlers={dial.handlers} />
      {view.needsAck ? (
        <div className="grid grid-cols-2 gap-2.5">
          {onHistory ? (
            <button type="button" className="btn btn-soft" onClick={onHistory}>
              <History aria-hidden="true" />
              Xem lịch sử
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="btn btn-ghost" onClick={dial.ack}>
            Đã hiểu
          </button>
        </div>
      ) : (
        <>
          {dial.block === "offline" && onRecheck && (
            <button type="button" className="btn btn-ghost btn-sm self-center" onClick={onRecheck}>
              <RefreshCw aria-hidden="true" />
              Kiểm tra lại kết nối
            </button>
          )}
          {actions}
        </>
      )}
      <MobileSheet
        open={dial.confirmOpen}
        onClose={() => dial.setConfirmOpen(false)}
        role="alertdialog"
        title={`Mở cửa ${device.display_name} ngay bây giờ?`}
        description="Cửa sẽ mở như khi bấm trên app SmartLife. Thao tác được ghi vào Nhật ký thao tác kèm tên bạn."
      >
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" className="btn btn-ghost" onClick={() => dial.setConfirmOpen(false)}>
            Huỷ
          </button>
          <button type="button" className="btn btn-primary" onClick={dial.confirm}>
            Mở cửa ngay
          </button>
        </div>
      </MobileSheet>
    </>
  );
}

function RecentEntries({ caller, device, onAll }: { caller: DoorAccessCaller; device: DoorDevice; onAll: () => void }) {
  // Cùng khoảng "hôm nay" với mục Lịch sử ⇒ dùng chung một lần đọc SmartLife.
  const today = vnDate(Date.now());
  const { range } = useMemo(() => historyRange(today, today), [today]);
  const records = useDoorRecords(caller, device.id, range);
  const links = useDoorKeyLinks(caller, device.id);
  const tempLogs = useDoorTempPasswordLogs(caller, device.id);
  const rows = useMemo(() => {
    const linkIndex = indexLinks(links.data ?? []);
    const logs = tempLogs.data?.logs ?? [];
    const names = indexTempPasswordNames(logs);
    const byId = indexTempPasswordLogs(logs);
    return mergeRecordPages(records.data?.pages ?? [])
      .slice(0, 3)
      .map((record) => historyRow(record, linkIndex, names, byId));
  }, [records.data, links.data, tempLogs.data]);

  return (
    <section className="sec" aria-labelledby="door-recent">
      <div className="sec-h">
        <h2 id="door-recent">Ra vào gần đây</h2>
        <button type="button" className="link" onClick={onAll}>
          Xem tất cả
        </button>
      </div>
      {records.data === undefined && records.isPending && <div className="card empty">Đang đọc lịch sử từ máy cửa…</div>}
      {records.data === undefined && records.isError && (
        <div className="card empty" role="alert">
          Chưa tải được lịch sử ra vào.{" "}
          <button type="button" className="font-semibold text-[var(--brand)] underline" onClick={() => void records.refetch()}>
            Thử lại
          </button>
        </div>
      )}
      {records.data !== undefined && rows.length === 0 && <div className="card empty">Hôm nay chưa có lượt ra vào nào.</div>}
      {rows.length > 0 && <HistoryRows rows={rows} label="Ra vào gần đây" />}
    </section>
  );
}

export function MobileDoorTab({
  caller,
  device,
  writable,
  online,
  dial,
  tempCount,
  onPick,
  onRecheck,
  onCreateTemp,
  onOpenTemp,
  onOpenHistory,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  writable: boolean;
  online: boolean | null;
  dial: DoorDialState;
  /** Số mã đang dùng (chỉ khi đã có trong bộ đệm — không gọi SmartLife chỉ để đếm). */
  tempCount: number | null;
  onPick: () => void;
  onRecheck: (() => void) | null;
  onCreateTemp: () => void;
  onOpenTemp: () => void;
  onOpenHistory: () => void;
}) {
  const canTemp = device.can.temp_password;
  const canView = device.can.view;
  const tempActions = canTemp ? (
    <div className="grid grid-cols-2 gap-2.5">
      <button
        type="button"
        className="btn btn-primary"
        aria-disabled={writable ? undefined : "true"}
        title={writable ? undefined : "Đang ở chế độ chỉ đọc — chưa tạo mã được"}
        onClick={() => writable && onCreateTemp()}
      >
        <KeyRound aria-hidden="true" />
        Tạo mã tạm
      </button>
      <button type="button" className="btn btn-ghost" onClick={onOpenTemp}>
        Mã đang dùng
        {tempCount !== null && <span className="count-badge">{tempCount}</span>}
      </button>
    </div>
  ) : null;

  return (
    <>
      <DoorPickCard device={device} online={online} locked={dial.locksDevice} onOpen={onPick} />
      <DoorDial
        dial={dial}
        device={device}
        onRecheck={onRecheck}
        onHistory={canView ? onOpenHistory : null}
        actions={tempActions}
      />
      {canView && <RecentEntries key={`recent-${device.id}`} caller={caller} device={device} onAll={onOpenHistory} />}
    </>
  );
}
