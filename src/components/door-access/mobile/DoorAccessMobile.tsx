import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, Fingerprint, History, KeyRound, Plus, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { doorKeys, useDoorDevices, useDoorDiscover, useDoorScope, useDoorStatus } from "@/hooks/door-access/useDoorAccessQueries";
import { useSelectedDoorDevice } from "@/hooks/door-access/useSelectedDoorDevice";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import type { DoorAccessMode, DoorDevice, DoorTempPasswordsResult } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { isDoorAccessError } from "@/lib/door-access/errors";
import { MOBILE_TAB_LABEL, doorLabel, formatWeekdayDate, visibleMobileTabs, type MobileTab } from "@/lib/door-access/mobile";
import { canUse } from "@/lib/permissionCheck";

import { ModeOffState, NotConnectedState } from "../ConnectionStates";
import { DevicesTab } from "../DevicesTab";
import { DoorPickerSheet } from "./DoorPickerSheet";
import { MobileActionLog, MobileManageMenu, type ManageView } from "./MobileManage";
import { MobileDoorTab } from "./MobileDoorTab";
import { useDoorDial } from "./useDoorDial";
import { MobileHistory } from "./MobileHistory";
import { MobileReconcile } from "./MobileReconcile";
import { MobileTempPasswords } from "./MobileTempPasswords";
import { MobileError, MobileLoading, MobileNotice } from "./mobileParts";
import "./doorAccessMobile.css";

/**
 * /cua-van-tay trên điện thoại (< 768px) — Bản A (chủ duyệt 25/11): thanh dưới 4 mục Cửa · Mã tạm ·
 * Lịch sử · Quản lý; mở cửa từ xa bằng GIỮ 1 giây thay cho hộp xác nhận. Màn rộng giữ nguyên bố cục
 * tab (DoorAccessScreen). Cùng hook dữ liệu, cùng hàm Edge/RPC với máy tính.
 */

const TAB_ICON: Record<MobileTab, typeof Fingerprint> = {
  door: Fingerprint,
  temp: KeyRound,
  history: History,
  manage: SlidersHorizontal,
};

function Shell({
  title,
  subtitle,
  onBack,
  backLabel,
  action,
  tabbar,
  bodyKey,
  children,
}: {
  title: string;
  subtitle: string | null;
  onBack: () => void;
  backLabel: string;
  action?: ReactNode;
  tabbar?: ReactNode;
  bodyKey?: string;
  children: ReactNode;
}) {
  return (
    <div className="dam dam-stage">
      <div className="dam-app">
        <header className="mtop">
          <button type="button" className="mback" aria-label={backLabel} onClick={onBack}>
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="mtitle">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action && <div className="mtop-act">{action}</div>}
        </header>
        <main key={bodyKey} className="mbody">
          {children}
        </main>
        {tabbar}
      </div>
    </div>
  );
}

function ConnectedMobile({ caller, mode, onHome }: { caller: DoorAccessCaller; mode: Exclude<DoorAccessMode, "off">; onHome: () => void }) {
  const devicesQuery = useDoorDevices(caller);
  const permissions = useMyPermissions();
  const canManageAnywhere = canUse(permissions.data, "door_access", "manage_devices");
  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);
  const { device, select } = useSelectedDoorDevice(caller, devices);
  const writable = mode === "all";
  const tabs = visibleMobileTabs(device?.can ?? null, canManageAnywhere);
  const [tab, setTab] = useState<MobileTab>("door");
  const active: MobileTab = tabs.includes(tab) ? tab : "door";
  const [manageView, setManageView] = useState<ManageView>("menu");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [needsDelete, setNeedsDelete] = useState<Record<string, number>>({});

  // Trạng thái trực tuyến chỉ có khi người có quyền đã "Tìm máy" ở Thiết bị (cùng nguồn với máy tính) —
  // observer không tự gọi SmartLife.
  const discover = useDoorDiscover(caller, false);
  const onlineOf = useCallback(
    (item: DoorDevice) => discover.data?.devices.find((found) => found.tuyaDeviceId === item.tuya_device_id)?.online ?? null,
    [discover.data],
  );
  const online = device ? onlineOf(device) : null;
  const offlineCount = discover.data ? devices.filter((item) => onlineOf(item) === false).length : null;
  const client = useQueryClient();
  const tempCount = device ? client.getQueryData<DoorTempPasswordsResult>(doorKeys.tempPasswords(caller, device.id))?.passwords.length ?? null : null;
  const deviceNeedsDelete = device ? needsDelete[device.id] ?? null : null;
  // Trạng thái nút giữ-để-mở sống ở vỏ trang: đổi mục giữa lúc gửi lệnh không làm mất kết quả.
  const dial = useDoorDial({ caller, device, writable, online });
  const reportNeedsDelete = useCallback((count: number) => {
    if (!device) return;
    setNeedsDelete((current) => (current[device.id] === count ? current : { ...current, [device.id]: count }));
  }, [device]);

  const goTab = (next: MobileTab) => {
    setTab(next);
    setCreateOpen(false);
    dial.setConfirmOpen(false);
    if (next === "manage") setManageView("menu");
  };
  const view = active === "manage" ? manageView : null;

  const tabbar =
    tabs.length > 1 ? (
      <nav className="tabbar" aria-label="Cửa vân tay">
        {tabs.map((item) => {
          const Icon = TAB_ICON[item];
          const badge = item === "manage" && deviceNeedsDelete ? deviceNeedsDelete : null;
          return (
            <button key={item} type="button" className="tab" aria-current={item === active ? "page" : undefined} onClick={() => goTab(item)}>
              <span className="tab-ic">
                <Icon aria-hidden="true" />
              </span>
              {MOBILE_TAB_LABEL[item]}
              {badge !== null && (
                <span className="tab-badge" aria-label={`${badge} số cần xoá`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    ) : null;

  const label = device ? doorLabel(device) : null;
  const header = (() => {
    if (active === "temp") return { title: "Mã tạm", subtitle: label };
    if (active === "history") return { title: "Lịch sử ra vào", subtitle: label };
    if (active === "manage") {
      if (view === "reconcile") return { title: "Đối chiếu vân tay", subtitle: label };
      if (view === "devices") {
        const buildings = new Set(devices.map((item) => item.building_id)).size;
        return { title: "Thiết bị", subtitle: `${devices.length} cửa ở ${buildings} toà` };
      }
      if (view === "logs") return { title: "Nhật ký thao tác", subtitle: label ? `${label} · thao tác từ CRM` : "Thao tác từ CRM" };
      return { title: "Quản lý cửa", subtitle: label };
    }
    return { title: "Cửa vân tay", subtitle: formatWeekdayDate(Date.now()) };
  })();
  const inSubView = active === "manage" && view !== "menu";
  const action =
    active === "temp" && device?.can.temp_password ? (
      <button
        type="button"
        className="btn btn-primary btn-sm"
        aria-disabled={writable ? undefined : "true"}
        title={writable ? undefined : "Đang ở chế độ chỉ đọc — chưa tạo mã được"}
        onClick={() => writable && setCreateOpen(true)}
      >
        <Plus aria-hidden="true" />
        Tạo mã
      </button>
    ) : undefined;

  let body: ReactNode;
  if (devicesQuery.data === undefined) {
    body = devicesQuery.isError ? (
      <MobileError error={devicesQuery.error} title="Chưa tải được danh sách máy cửa" onRetry={() => void devicesQuery.refetch()} />
    ) : (
      <MobileLoading text="Đang tải danh sách cửa…" />
    );
  } else if (active === "manage" && view === "devices") {
    body = (
      <div className="desktop-embed">
        <DevicesTab caller={caller} />
      </div>
    );
  } else if (!device) {
    body = (
      <>
        <MobileNotice tone="info">
          {canManageAnywhere
            ? "Chưa có máy cửa nào trong CRM. Mở Quản lý › Thiết bị để tìm máy trên SmartLife và gắn toà."
            : "Chưa có máy cửa nào bạn được xem. Nhờ người quản lý gắn máy vào toà hoặc cấp quyền."}
        </MobileNotice>
        {active === "manage" && (
          <MobileManageMenu device={null} mode={mode} devices={devices} canManageAnywhere={canManageAnywhere} needsDelete={null} offlineCount={offlineCount} onOpen={setManageView} />
        )}
      </>
    );
  } else if (active === "temp") {
    body = (
      <MobileTempPasswords
        key={device.id}
        caller={caller}
        device={device}
        writable={writable}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
        onOpenHistory={device.can.view ? () => goTab("history") : null}
      />
    );
  } else if (active === "history") {
    body = <MobileHistory key={device.id} caller={caller} device={device} />;
  } else if (active === "manage") {
    body =
      view === "reconcile" ? (
        <MobileReconcile key={device.id} caller={caller} device={device} writable={writable} onCountsChange={reportNeedsDelete} />
      ) : view === "logs" ? (
        <MobileActionLog key={device.id} caller={caller} device={device} />
      ) : (
        <MobileManageMenu
          device={device}
          mode={mode}
          devices={devices}
          canManageAnywhere={canManageAnywhere}
          needsDelete={deviceNeedsDelete}
          offlineCount={offlineCount}
          onOpen={setManageView}
        />
      );
  } else {
    body = (
      <MobileDoorTab
        caller={caller}
        device={device}
        writable={writable}
        online={online}
        dial={dial}
        tempCount={tempCount}
        onPick={() => !dial.locksDevice && setPickerOpen(true)}
        onRecheck={discover.data ? () => void discover.refetch() : null}
        onCreateTemp={() => {
          setTab("temp");
          setCreateOpen(true);
        }}
        onOpenTemp={() => goTab("temp")}
        onOpenHistory={() => goTab("history")}
      />
    );
  }

  return (
    <>
      <Shell
        title={header.title}
        subtitle={header.subtitle}
        onBack={inSubView ? () => setManageView("menu") : onHome}
        backLabel={inSubView ? "Về Quản lý" : "Về trang chủ"}
        action={action}
        tabbar={tabbar}
        bodyKey={`${active}:${view ?? ""}`}
      >
        {mode === "read" && active === "door" && device && !device.can.remote_unlock && device.can.temp_password && (
          <MobileNotice tone="warn">Đang ở chế độ chỉ đọc — chưa thao tác được trên máy.</MobileNotice>
        )}
        {body}
      </Shell>
      <DoorPickerSheet
        open={pickerOpen}
        devices={devices}
        selectedId={device?.id ?? null}
        onlineOf={onlineOf}
        onClose={() => setPickerOpen(false)}
        onSelect={(id) => {
          if (!dial.locksDevice) select(id);
          setPickerOpen(false);
        }}
      />
    </>
  );
}

/** Như DoorAccessScreen: hỏi `status` của hàm Edge TRƯỚC; chưa kết nối hoặc đang tắt thì dừng ở đó. */
export default function DoorAccessMobile() {
  const navigate = useNavigate();
  const { caller } = useDoorScope();
  const status = useDoorStatus(caller);
  const onHome = () => navigate("/");
  const plain = (children: ReactNode) => (
    <Shell title="Cửa vân tay" subtitle={formatWeekdayDate(Date.now())} onBack={onHome} backLabel="Về trang chủ">
      {children}
    </Shell>
  );

  if (!caller) return plain(<MobileLoading text="Đang mở trang Cửa vân tay…" />);
  if (status.data === undefined) {
    if (status.isError) {
      const error = status.error;
      if (isDoorAccessError(error) && error.kind === "not_connected") return plain(<NotConnectedState otherOrganization={error.code === "org_not_connected"} />);
      if (isDoorAccessError(error) && error.kind === "mode_off") return plain(<ModeOffState />);
      return plain(<MobileError error={error} title="Chưa kiểm tra được kết nối SmartLife" onRetry={() => void status.refetch()} />);
    }
    return plain(<MobileLoading text="Đang kiểm tra kết nối SmartLife…" />);
  }
  const { configured, connectedOrg, mode } = status.data;
  if (!configured || !connectedOrg) return plain(<NotConnectedState otherOrganization={configured && !connectedOrg} />);
  if (mode === "off") return plain(<ModeOffState />);
  return <ConnectedMobile caller={caller} mode={mode} onHome={onHome} />;
}
