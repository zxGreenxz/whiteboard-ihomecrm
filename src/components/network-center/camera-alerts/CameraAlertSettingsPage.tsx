import { AlertTriangle, ArrowLeft, BellRing, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LoadingState } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { useCameraAlertSettings, type CameraAlertScope } from "@/hooks/network-center/useCameraAlerts";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import { cameraAlertFailure, formatVnDateTime } from "@/lib/network-center/cameraAlertForm";
import type { CameraAlertRepository, CameraAlertSettingsView } from "@/lib/network-center/cameraContracts";
import { CameraAlertDeliveryLog } from "./CameraAlertDeliveryLog";
import { CameraAlertSettingsForm } from "./CameraAlertSettingsForm";

const NO_VIEW_PERMISSION = "Bạn chưa có quyền xem cài đặt cảnh báo camera của công ty này (cần quyền xem Trung tâm mạng ở ít nhất một toà).";

export type CameraAlertPageController = Pick<NetworkCenterController, "actor" | "canView" | "mode" | "isDemo" | "physicalBuildings">;

/**
 * Cài đặt cảnh báo camera — CẤP CÔNG TY (spec 2026-11-24 §6). Đặt ở
 * /network-center/camera-alerts chứ không ở tab "Cài đặt" của toà: tab đó là
 * chính sách router của MỘT toà, còn cài đặt này áp cho mọi toà của công ty.
 */
export function CameraAlertSettingsPage({ controller, organizationId, organizationName, repository }: {
  controller: CameraAlertPageController;
  organizationId: string | null;
  organizationName?: string | null;
  repository?: CameraAlertRepository;
}) {
  const scope: CameraAlertScope = {
    actorId: controller.actor.id, organizationId: organizationId ?? "", mode: controller.mode, canView: controller.canView,
  };
  const { settingsQuery, saveMutation, testMutation } = useCameraAlertSettings(scope, repository);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const buildingNames = useMemo(
    () => new Map(controller.physicalBuildings.map((building) => [building.id, building.name])),
    [controller.physicalBuildings],
  );
  const latest = settingsQuery.data;
  // Bản mà form đang sửa. Form sạch thì luôn theo bản mới nhất của máy chủ; form
  // đang có thay đổi chưa lưu thì GIỮ bản cũ và báo "có bản mới" thay vì dựng lại
  // form dưới tay người dùng (lần nạp nền do "Làm mới", realtime, tin thử…).
  const [pinned, setPinned] = useState<CameraAlertSettingsView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => { if (latest && !dirty) setPinned(latest); }, [latest, dirty]);
  const pinnedValid = pinned && latest && pinned.organizationId === latest.organizationId ? pinned : null;
  const base = dirty && pinnedValid ? pinnedValid : latest;
  const newerOnServer = Boolean(base && latest && latest.settings.version !== base.settings.version);
  const reload = () => {
    setSavedAt(null);
    setDirty(false);
    setGeneration((value) => value + 1);
    void settingsQuery.refetch();
  };

  const readFailure = cameraAlertFailure(settingsQuery.error, "tải cài đặt cảnh báo camera", NO_VIEW_PERMISSION);
  let body;
  if (!controller.canView) {
    body = <StateNote icon="denied" text="Bạn không có quyền xem Trung tâm mạng." />;
  } else if (!organizationId) {
    body = <StateNote icon="warn" text="Chưa xác định được công ty. Chọn công ty ở góc trên của iHomeCRM rồi mở lại trang này." />;
  } else if (settingsQuery.isPending) {
    body = <LoadingState label="cài đặt cảnh báo camera" variant="cards" rows={4} />;
  } else if (!base || !latest || (settingsQuery.isError && ["permission", "session"].includes(readFailure.kind))) {
    // Chưa có dữ liệu, hoặc máy chủ vừa từ chối quyền / phiên hết hạn: không để form cũ mở để sửa.
    body = readFailure.kind === "permission"
      ? <StateNote icon="denied" text={NO_VIEW_PERMISSION} />
      : <StateNote icon="warn" text={readFailure.text} retry={() => void settingsQuery.refetch()} />;
  } else {
    body = (
      <>
        {settingsQuery.isError ? (
          <StateNote icon="warn" text={`Chưa tải lại được cài đặt mới nhất — đang giữ bản trên màn hình. ${readFailure.text}`}
            retry={() => void settingsQuery.refetch()} />
        ) : null}
        {newerOnServer ? (
          <div className="nc-locked-note nc-display-note" role="alert">
            <AlertTriangle aria-hidden="true" />
            <p className="flex-1">Có người vừa sửa cài đặt này. Bấm “Tải lại” để xem bản mới nhất — thay đổi chưa lưu trên màn hình sẽ bỏ.</p>
            <Button type="button" variant="outline" onClick={reload}>Tải lại</Button>
          </div>
        ) : null}
        {savedAt ? <p className="nc-inline-feedback nc-tone-good" role="status">Đã lưu cài đặt lúc {formatVnDateTime(savedAt)}.</p> : null}
        <CameraAlertSettingsForm
          // Dựng lại form khi bản gốc đổi (lưu xong, Tải lại, hoặc form sạch nhận bản mới).
          key={`${base.organizationId}:${base.settings.version}:${generation}`}
          view={{ ...base, today: latest.today }}
          scope={scope}
          repository={repository}
          isDemo={controller.isDemo}
          reloading={settingsQuery.isFetching}
          onDirtyChange={setDirty}
          onReload={reload}
          onSave={async (expectedVersion, patch) => {
            const next = await saveMutation.mutateAsync({ expectedVersion, patch });
            setPinned(next);
            setDirty(false);
            setSavedAt(Date.now());
            return next;
          }}
          onTest={() => testMutation.mutateAsync()}
        />
        <CameraAlertDeliveryLog scope={scope} repository={repository} buildingNames={buildingNames} />
      </>
    );
  }

  return (
    <div className="nc-page-stack">
      <section className="nc-page-heading">
        <div>
          <Link to="/network-center" className="nc-inline-back"><ArrowLeft aria-hidden="true" /> Danh sách mạng</Link>
          <p className="nc-eyebrow">Toàn công ty{organizationName ? ` · ${organizationName}` : ""} / {controller.isDemo ? "dữ liệu mô phỏng" : "dữ liệu trực tiếp"}</p>
          <h2><BellRing className="mr-2 inline h-8 w-8" aria-hidden="true" />Cảnh báo camera</h2>
          <p>Chọn loại sự cố cần báo, cách báo và nhóm Zalo nhận tin. Cài đặt áp dụng cho mọi toà của công ty; từng kênh camera tắt báo ở tab Camera của toà.</p>
        </div>
      </section>
      {body}
    </div>
  );
}

function StateNote({ icon, text, retry }: { icon: "denied" | "warn"; text: string; retry?: () => void }) {
  return (
    <div className="nc-locked-note nc-display-note" role="alert">
      {icon === "denied" ? <ShieldAlert aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
      <p className="flex-1">{text}</p>
      {retry ? <Button type="button" variant="outline" onClick={retry}>Thử lại</Button> : null}
    </div>
  );
}
