import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { LoadingState } from "@/components/loading/LoadingState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { doorKeys, useDoorDevices, useDoorScope, useDoorStatus } from "@/hooks/door-access/useDoorAccessQueries";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import type { DiscoverResult, DoorAccessMode, DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { isDoorAccessError } from "@/lib/door-access/errors";
import { DOOR_TAB_LABEL, isDoorTab, visibleTabs, type DoorTab } from "@/lib/door-access/view";
import { canUse } from "@/lib/permissionCheck";

import { ActionLogTab } from "./ActionLogTab";
import { ModeOffState, NotConnectedState } from "./ConnectionStates";
import { DeviceHeader } from "./DeviceHeader";
import { DevicesTab } from "./DevicesTab";
import { HistoryTab } from "./HistoryTab";
import { ErrorPanel, Notice } from "./parts";
import { ReconcileTab } from "./ReconcileTab";
import { TempPasswordTab } from "./TempPasswordTab";

const STORAGE_PREFIX = "door-access.last-device.v1";

function readRemembered(key: string): string | null {
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(key);
  } catch {
    /* Trình duyệt chặn bộ nhớ (chế độ riêng tư…): coi như chưa nhớ máy nào — chọn máy đầu danh sách. */
  }
  return remembered;
}

function writeRemembered(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Trình duyệt chặn bộ nhớ (chế độ riêng tư…): chỉ mất phần ghi nhớ, không ảnh hưởng thao tác.
  }
}

/** Máy đang chọn: nhớ lần chọn trước theo công ty + người (chỉ là tiện ích trên máy người xem). */
function useSelectedDevice(caller: DoorAccessCaller, devices: readonly DoorDevice[]) {
  const storageKey = `${STORAGE_PREFIX}:${caller.organizationId}:${caller.actorId}`;
  const [selected, setSelected] = useState<{ key: string; id: string | null }>(() => ({ key: storageKey, id: readRemembered(storageKey) }));
  const wanted = selected.key === storageKey ? selected.id : readRemembered(storageKey);
  const device = devices.find((item) => item.id === wanted) ?? devices[0] ?? null;
  const select = (id: string) => {
    setSelected({ key: storageKey, id });
    writeRemembered(storageKey, id);
  };
  return { device, select };
}

function ConnectedDoorAccess({ caller, mode }: { caller: DoorAccessCaller; mode: Exclude<DoorAccessMode, "off"> }) {
  const devicesQuery = useDoorDevices(caller);
  const permissions = useMyPermissions();
  const canManageAnywhere = canUse(permissions.data, "door_access", "manage_devices");
  const devices = devicesQuery.data ?? [];
  const { device, select } = useSelectedDevice(caller, devices);
  const tabs = visibleTabs(device?.can ?? null, canManageAnywhere);
  const [tab, setTab] = useState<DoorTab>("history");
  const active = tabs.includes(tab) ? tab : tabs[0] ?? null;
  const writable = mode === "all";

  const client = useQueryClient();
  const discovered = client.getQueryData<DiscoverResult>(doorKeys.discover(caller));
  const online = device ? discovered?.devices.find((item) => item.tuyaDeviceId === device.tuya_device_id)?.online ?? null : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 pb-16">
      {devicesQuery.data === undefined && devicesQuery.isPending && <LoadingState label="danh sách máy cửa" variant="detail" rows={2} />}
      {devicesQuery.data === undefined && devicesQuery.isError && (
        <ErrorPanel error={devicesQuery.error} title="Chưa tải được danh sách máy cửa" onRetry={() => void devicesQuery.refetch()} />
      )}
      {devicesQuery.data !== undefined && (
        <DeviceHeader caller={caller} devices={devices} device={device} mode={mode} online={online} onSelect={select} />
      )}
      {devicesQuery.data !== undefined && devices.length === 0 && (
        <Notice tone="info">
          {canManageAnywhere
            ? "Chưa có máy cửa nào trong CRM — mở tab Thiết bị để tìm máy trên SmartLife và gắn tòa."
            : "Chưa có máy cửa nào bạn được xem. Nhờ người quản lý gắn máy vào tòa hoặc cấp quyền."}
        </Notice>
      )}
      {active && (
        <Tabs value={active} onValueChange={(value) => isDoorTab(value) && setTab(value)}>
          <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            <TabsList className="w-max">
              {tabs.map((item) => (
                <TabsTrigger key={item} value={item} className="px-3">
                  {DOOR_TAB_LABEL[item]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {device && tabs.includes("history") && (
            <TabsContent value="history">
              <HistoryTab key={device.id} caller={caller} device={device} />
            </TabsContent>
          )}
          {device && tabs.includes("temp") && (
            <TabsContent value="temp">
              <TempPasswordTab key={device.id} caller={caller} device={device} writable={writable} />
            </TabsContent>
          )}
          {device && tabs.includes("reconcile") && (
            <TabsContent value="reconcile">
              <ReconcileTab key={device.id} caller={caller} device={device} writable={writable} />
            </TabsContent>
          )}
          {tabs.includes("devices") && (
            <TabsContent value="devices">
              <DevicesTab caller={caller} />
            </TabsContent>
          )}
          {device && tabs.includes("logs") && (
            <TabsContent value="logs">
              <ActionLogTab key={device.id} caller={caller} device={device} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}

/**
 * Trang /cua-van-tay. Hỏi `status` của hàm Edge TRƯỚC: chưa kết nối SmartLife hoặc đang tắt thì
 * dừng ở đó, không gọi thêm gì.
 */
export function DoorAccessScreen() {
  const { caller } = useDoorScope();
  const status = useDoorStatus(caller);

  if (!caller) return <LoadingState label="trang Cửa vân tay" variant="detail" rows={3} />;
  if (status.data === undefined) {
    if (status.isError) {
      const error = status.error;
      if (isDoorAccessError(error) && error.kind === "not_connected") {
        return <NotConnectedState otherOrganization={error.code === "org_not_connected"} />;
      }
      if (isDoorAccessError(error) && error.kind === "mode_off") return <ModeOffState />;
      return <ErrorPanel error={error} title="Chưa kiểm tra được kết nối SmartLife" onRetry={() => void status.refetch()} />;
    }
    return <LoadingState label="trạng thái kết nối SmartLife" variant="detail" rows={3} />;
  }
  const { configured, connectedOrg, mode } = status.data;
  if (!configured || !connectedOrg) return <NotConnectedState otherOrganization={configured && !connectedOrg} />;
  if (mode === "off") return <ModeOffState />;
  return <ConnectedDoorAccess caller={caller} mode={mode} />;
}
