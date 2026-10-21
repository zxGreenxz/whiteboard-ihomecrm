import { useMemo, useState } from "react";
import { DoorOpen, Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRemoteUnlock } from "@/hooks/door-access/useDoorAccessMutations";
import type { DoorAccessMode, DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { DEVICE_KIND_LABEL } from "@/lib/door-access/format";
import { READ_ONLY_REASON, groupDevicesByBuilding } from "@/lib/door-access/view";

import { GuardedButton, Notice, Pill, type NoticeTone } from "./parts";

export function DeviceHeader({
  caller,
  devices,
  device,
  mode,
  online,
  onSelect,
}: {
  caller: DoorAccessCaller;
  devices: readonly DoorDevice[];
  device: DoorDevice | null;
  mode: DoorAccessMode;
  online: boolean | null;
  onSelect: (deviceId: string) => void;
}) {
  const groups = useMemo(() => groupDevicesByBuilding(devices), [devices]);
  return (
    <div className="rounded-2xl border bg-card p-3 sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <p id="door-device-label" className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Máy cửa
          </p>
          <Select value={device?.id ?? ""} onValueChange={onSelect} disabled={devices.length === 0}>
            <SelectTrigger aria-labelledby="door-device-label" className="h-11 w-full text-base sm:text-sm">
              <SelectValue placeholder={devices.length === 0 ? "Chưa có máy nào" : "Chọn máy"} />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectGroup key={group.building}>
                  <SelectLabel>{group.building}</SelectLabel>
                  {group.devices.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.display_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {device && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <Pill>{device.building_name ?? "Chưa rõ tòa"}</Pill>
              <Pill>{DEVICE_KIND_LABEL[device.device_kind]}</Pill>
              {online === true && <Pill tone="green">Đang trực tuyến</Pill>}
              {online === false && <Pill tone="red">Mất kết nối</Pill>}
              {mode === "read" && <Pill tone="amber">Chỉ đọc</Pill>}
            </div>
          )}
          {!device && mode === "read" && (
            <div className="mt-2">
              <Pill tone="amber">Chỉ đọc</Pill>
            </div>
          )}
        </div>
        {device?.can.remote_unlock && <RemoteUnlock caller={caller} device={device} writable={mode === "all"} />}
      </div>
    </div>
  );
}

const UNKNOWN_UNLOCK = "Chưa rõ cửa đã mở chưa — xem Lịch sử ra vào trước khi bấm lại";

function RemoteUnlock({ caller, device, writable }: { caller: DoorAccessCaller; device: DoorDevice; writable: boolean }) {
  const unlock = useRemoteUnlock(caller);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{ deviceId: string; tone: NoticeTone; text: string } | null>(null);
  const shown = result && result.deviceId === device.id ? result : null;

  const run = () => {
    setConfirmOpen(false);
    if (unlock.isPending) return;
    setResult(null);
    const target = device;
    unlock.mutate(target.id, {
      onSuccess: (data) =>
        setResult(
          data.unlocked
            ? { deviceId: target.id, tone: "success", text: `Đã gửi lệnh mở cửa ${target.display_name}.` }
            : { deviceId: target.id, tone: "warning", text: "SmartLife chưa xác nhận đã mở cửa — xem Lịch sử ra vào trước khi bấm lại." },
        ),
      onError: (error) =>
        setResult(
          isDoorAccessError(error) && error.outcomeUnknown
            ? { deviceId: target.id, tone: "warning", text: UNKNOWN_UNLOCK }
            : { deviceId: target.id, tone: "error", text: doorErrorMessage(error, "Chưa mở được cửa. Thử lại sau.") },
        ),
    });
  };

  return (
    <div className="flex flex-col gap-2 sm:w-56">
      <GuardedButton
        type="button"
        size="lg"
        className="h-11 w-full"
        disabledReason={writable ? null : READ_ONLY_REASON}
        disabled={unlock.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        {unlock.isPending ? (
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <DoorOpen className="mr-2 h-5 w-5" aria-hidden="true" />
        )}
        {unlock.isPending ? "Đang mở cửa…" : "Mở cửa"}
      </GuardedButton>
      {shown && <Notice tone={shown.tone}>{shown.text}</Notice>}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Mở cửa {device.display_name} ngay bây giờ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cửa sẽ mở như khi bấm trên app SmartLife. Thao tác được ghi vào Nhật ký thao tác kèm tên bạn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction onClick={run}>Mở cửa ngay</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
