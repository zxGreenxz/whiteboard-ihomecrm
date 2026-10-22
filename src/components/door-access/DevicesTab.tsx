import { useMemo, useState } from "react";
import { Pencil, Power, PowerOff, RefreshCw, Search } from "lucide-react";

import { LoadingState, RefreshBar } from "@/components/loading/LoadingState";
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useDisableDevice } from "@/hooks/door-access/useDoorAccessMutations";
import { useDoorCanManageOrg, useDoorDevices, useDoorDiscover } from "@/hooks/door-access/useDoorAccessQueries";
import { useBuildings } from "@/hooks/useBuildings";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { suggestBuilding } from "@/lib/door-access/buildingMatch";
import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { DEVICE_KIND_LABEL } from "@/lib/door-access/format";
import { manageableBuildings, organizationBuildings } from "@/lib/door-access/view";
import { cn } from "@/lib/utils";

import { DeviceEditorDialog, type DeviceEditorTarget } from "./DeviceEditorDialog";
import { ErrorPanel, Notice, Pill, SectionTitle, type NoticeTone } from "./parts";

export function DevicesTab({ caller }: { caller: DoorAccessCaller }) {
  const registered = useDoorDevices(caller, { includeInactive: true });
  const [discoverOn, setDiscoverOn] = useState(false);
  const discover = useDoorDiscover(caller, discoverOn);
  const [showOthers, setShowOthers] = useState(false);
  const buildingsQuery = useBuildings();
  const buildings = useMemo(() => organizationBuildings(buildingsQuery.data, caller.organizationId), [buildingsQuery.data, caller.organizationId]);
  const buildingName = useMemo(() => new Map(buildings.map((b) => [b.id, b.name])), [buildings]);
  const permissions = useMyPermissions();
  // Gắn máy MỚI (và tìm máy trên SmartLife) đòi quyền Quản lý máy ở MỌI tòa; sửa/tắt máy thì theo tòa của máy.
  // Hỏi chính hàm máy chủ dùng để chặn: get_my_permissions_v2 trả org_wide=false cho mọi khoá có chiều BUILDING,
  // kể cả chủ công ty, nên không suy được "mọi tòa" từ đó.
  const canManageOrg = useDoorCanManageOrg(caller);
  const canRegister = canManageOrg.data === true;
  const manageable = useMemo(() => manageableBuildings(buildings, permissions.data), [buildings, permissions.data]);
  const disable = useDisableDevice(caller);

  const [editor, setEditor] = useState<DeviceEditorTarget | null>(null);
  const [toDisable, setToDisable] = useState<DoorDevice | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const candidates = useMemo(() => {
    const devices = discover.data?.devices ?? [];
    return devices
      .filter((device) => device.registered === null && (showOthers || device.kind !== null))
      .map((device) => ({ device, suggestion: suggestBuilding(device.name, manageable) }));
  }, [discover.data, showOthers, manageable]);
  const hiddenOthers = (discover.data?.devices ?? []).filter((d) => d.registered === null && d.kind === null).length;

  const confirmDisable = () => {
    const target = toDisable;
    setToDisable(null);
    if (!target) return;
    setNotice(null);
    disable.mutate(target.id, {
      onSuccess: () => setNotice({ tone: "success", text: `Đã tắt ${target.display_name} khỏi CRM.` }),
      onError: (error) =>
        setNotice({
          tone: isDoorAccessError(error) && error.outcomeUnknown ? "warning" : "error",
          text:
            isDoorAccessError(error) && error.outcomeUnknown
              ? "Chưa rõ đã tắt chưa — tải lại danh sách máy trước khi thử lại."
              : doorErrorMessage(error, "Chưa tắt được máy."),
        }),
    });
  };

  const devices = registered.data ?? [];

  return (
    <div className="space-y-5">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {buildingsQuery.isError && (
        <Notice tone="warning">
          Chưa tải được danh sách tòa — chưa gợi ý và chưa chọn được tòa.{" "}
          <button type="button" className="font-medium underline" onClick={() => void buildingsQuery.refetch()}>
            Tải lại
          </button>
        </Notice>
      )}

      <section className="space-y-3" aria-labelledby="door-registered">
        <SectionTitle>
          <span id="door-registered">Máy đã gắn tòa</span>
        </SectionTitle>
        {registered.data === undefined && registered.isPending && <LoadingState label="máy đã gắn" variant="list" rows={2} />}
        {registered.data === undefined && registered.isError && (
          <ErrorPanel error={registered.error} title="Chưa tải được danh sách máy" onRetry={() => void registered.refetch()} />
        )}
        {registered.data !== undefined && devices.length === 0 && (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {canRegister ? "Chưa có máy nào. Bấm “Tìm máy trên SmartLife” để gắn máy đầu tiên." : "Chưa có máy nào ở các tòa bạn quản lý."}
          </p>
        )}
        {devices.length > 0 && (
          <div className="relative">
            <RefreshBar active={registered.isFetching} />
            <ul className="divide-y rounded-xl border bg-card" aria-label="Máy đã gắn tòa">
              {devices.map((device) => (
                <li key={device.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-3">
                  <div className="min-w-0">
                    <p className={cn("font-medium", !device.is_active && "text-muted-foreground")}>
                      {device.display_name} {!device.is_active && <Pill>Đã tắt</Pill>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {device.building_name ?? "Chưa rõ tòa"} · {DEVICE_KIND_LABEL[device.device_kind]} · kênh {device.channel_id} · mật khẩu tạm{" "}
                      {device.password_length} số
                    </p>
                  </div>
                  {device.can.manage_devices && (
                    <div className="flex flex-wrap gap-1.5">
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditor({ mode: "edit", device })}>
                        {device.is_active ? <Pencil className="mr-1 h-4 w-4" aria-hidden="true" /> : <Power className="mr-1 h-4 w-4" aria-hidden="true" />}
                        {device.is_active ? "Sửa" : "Bật lại"}
                      </Button>
                      {device.is_active && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          disabled={disable.isPending}
                          onClick={() => setToDisable(device)}
                        >
                          <PowerOff className="mr-1 h-4 w-4" aria-hidden="true" />
                          Tắt khỏi CRM
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {canManageOrg.data === false && (
        <Notice tone="info">Chỉ người có quyền Quản lý máy ở mọi tòa mới gắn được máy mới.</Notice>
      )}
      {canManageOrg.isError && (
        <Notice tone="warning">
          Chưa kiểm được quyền gắn máy mới. {doorErrorMessage(canManageOrg.error, "Thử lại sau.")}{" "}
          <button type="button" className="font-medium underline" onClick={() => void canManageOrg.refetch()}>
            Thử lại
          </button>
        </Notice>
      )}
      {canRegister && (
        <section className="space-y-3" aria-labelledby="door-discover">
          <SectionTitle
            action={
              <Button
                type="button"
                size="sm"
                variant={discoverOn ? "ghost" : "default"}
                disabled={discover.isFetching}
                onClick={() => (discoverOn ? void discover.refetch() : setDiscoverOn(true))}
              >
                {discoverOn ? (
                  <RefreshCw className={cn("mr-1.5 h-4 w-4", discover.isFetching && "animate-spin")} aria-hidden="true" />
                ) : (
                  <Search className="mr-1.5 h-4 w-4" aria-hidden="true" />
                )}
                {discoverOn ? "Tìm lại" : "Tìm máy trên SmartLife"}
              </Button>
            }
          >
            <span id="door-discover">Máy trên SmartLife chưa gắn</span>
          </SectionTitle>
          {discoverOn && (
            <div className="flex items-center gap-2">
              <Switch id="door-show-others" checked={showOthers} onCheckedChange={setShowOthers} />
              <Label htmlFor="door-show-others" className="text-sm">
                Hiện cả thiết bị khác{hiddenOthers > 0 && !showOthers ? ` (${hiddenOthers})` : ""}
              </Label>
            </div>
          )}
          {discoverOn && discover.data === undefined && discover.isPending && <LoadingState label="máy trên SmartLife" variant="list" rows={3} />}
          {discoverOn && discover.data === undefined && discover.isError && (
            <ErrorPanel error={discover.error} title="Chưa tìm được máy trên SmartLife" onRetry={() => void discover.refetch()} />
          )}
          {discover.data !== undefined && candidates.length === 0 && (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Không còn máy cửa nào chưa gắn tòa.
            </p>
          )}
          {discover.data !== undefined && candidates.length > 0 && (
            <div className="relative">
              <RefreshBar active={discover.isFetching} />
              <ul className="divide-y rounded-xl border bg-card" aria-label="Máy chưa gắn">
                {candidates.map(({ device, suggestion }) => (
                  <li key={device.tuyaDeviceId} className="flex flex-wrap items-start justify-between gap-2 px-3 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-medium">{device.name ?? device.tuyaDeviceId}</p>
                      <p className="text-xs text-muted-foreground">
                        {device.productName ?? device.category ?? "Không rõ loại"} ·{" "}
                        {device.kind ? DEVICE_KIND_LABEL[device.kind] : "Không phải máy cửa"}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {device.online === true && <Pill tone="green">Trực tuyến</Pill>}
                        {device.online === false && <Pill tone="red">Mất kết nối</Pill>}
                        {suggestion ? (
                          <span>
                            Gợi ý tòa: <span className="font-medium">{buildingName.get(suggestion.buildingId) ?? "?"}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Chưa đoán được tòa — chọn tay.</span>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setEditor({ mode: "new", discovered: device, suggestedBuildingId: suggestion?.buildingId ?? null })}
                    >
                      Gắn tòa
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {discover.data?.hasMore && <p className="text-xs text-muted-foreground">SmartLife còn thiết bị chưa liệt kê hết.</p>}
          {discover.data !== undefined && discover.isRefetchError && (
            <Notice tone="warning">Chưa tìm lại được — đang hiện kết quả lần trước.</Notice>
          )}
        </section>
      )}

      <DeviceEditorDialog caller={caller} target={editor} buildings={manageable} onClose={() => setEditor(null)} onSaved={setNotice} />

      <AlertDialog open={toDisable !== null} onOpenChange={(open) => !open && setToDisable(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Tắt {toDisable?.display_name ?? ""} khỏi CRM?</AlertDialogTitle>
            <AlertDialogDescription>
              Máy vẫn mở cửa bình thường tại chỗ. CRM ngừng đọc lịch sử và thao tác với máy này; nhật ký cũ được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmDisable}>
              Tắt khỏi CRM
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
