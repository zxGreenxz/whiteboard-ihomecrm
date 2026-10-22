import { AlertTriangle, Camera, Clock3, HardDrive, Radio, RefreshCw, ShieldAlert } from "lucide-react";
import { LoadingState } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBuildingCameras } from "@/hooks/network-center/useBuildingCameras";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import { cameraRecorderStatus, type CameraEvent, type CameraRecorder } from "@/lib/network-center/cameraContracts";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { NetworkCenterRepositoryError } from "@/lib/network-center/supabaseRepository";

const stateLabels: Record<string, string> = {
  ONLINE: "Đầu ghi kết nối", OFFLINE: "Mất kết nối đến đầu ghi", UNKNOWN: "Chưa xác định",
  AUTH_DENIED: "Không đăng nhập được đầu ghi", STALE: "Dữ liệu đã cũ", DISABLED: "Tạm dừng theo dõi",
  CONNECTED: "Có kết nối", DISCONNECTED: "Mất kết nối", EMPTY: "Kênh chưa gắn camera",
  NORMAL: "Bình thường", ERROR: "Có lỗi", MISSING: "Không có ổ cứng",
};
const stateLabel = (value: string) => stateLabels[value] ?? value;
const timeLabel = (value: string) => new Date(value).toLocaleString("vi-VN");
const bytesLabel = (value?: number) => value === undefined ? "Chưa đo được" : `${(value / 1_000_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} GB`;

function StateBadge({ state, historical = false }: { state: string; historical?: boolean }) {
  const tone = historical || ["UNKNOWN", "EMPTY", "DISABLED"].includes(state) ? "neutral"
    : ["ONLINE", "CONNECTED", "NORMAL"].includes(state) ? "good"
      : state === "STALE" ? "warn" : "bad";
  return <span className={`nc-status nc-status-${tone}`}>{stateLabel(state)}</span>;
}

function CameraError({ error, retry }: { error: unknown; retry: () => void }) {
  const denied = error instanceof NetworkCenterRepositoryError && error.code === "42501";
  return (
    <div className="nc-locked-note nc-display-note" role="alert">
      {denied ? <ShieldAlert aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
      <p className="flex-1">{error instanceof NetworkCenterRepositoryError ? error.message : "Không thể tải dữ liệu camera. Vui lòng thử lại."}</p>
      {!denied && <Button type="button" variant="outline" onClick={retry}>Thử lại</Button>}
    </div>
  );
}

function RecorderCard({ recorder, now }: { recorder: CameraRecorder; now: number }) {
  const snapshot = recorder.snapshot;
  const status = cameraRecorderStatus(recorder, now);
  const historical = status !== "ONLINE";
  const channels = new Map(snapshot?.channels.map((channel) => [channel.channel, channel]));
  return (
    <section className="nc-panel" aria-label={recorder.display_name}>
      <div className="nc-panel-heading">
        <div><p className="nc-eyebrow">{recorder.vendor} · {recorder.model ?? "Chưa xác định model"}</p><h3>{recorder.display_name}</h3></div>
        <StateBadge state={status} />
      </div>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <p><Clock3 className="mr-1 inline h-4 w-4" aria-hidden="true" />Lần kiểm tra: {snapshot ? timeLabel(snapshot.checked_at) : "Chưa có dữ liệu"}</p>
          <p><Radio className="mr-1 inline h-4 w-4" aria-hidden="true" />{snapshot?.event_coverage === "EVENT_STREAM" ? "Luồng sự kiện" : "Theo lần kiểm tra"}</p>
        </div>
        {historical && snapshot && <p className="border-l-4 border-amber-500 bg-amber-50 p-3 text-sm">Các kênh và ổ cứng bên dưới là lần ghi nhận gần nhất. Chưa thể kết luận trạng thái camera hiện tại.</p>}
        {snapshot?.issues.length ? <p className="text-sm" role="status">Một phần dữ liệu chưa thu thập được. Trạng thái chưa xác định cần được kiểm tra lại.</p> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Các kênh camera">
          {Array.from({ length: recorder.channel_count }, (_, index) => {
            const number = index + 1;
            const channel = channels.get(number);
            return (
              <article key={number} className="flex min-w-0 flex-col gap-3 border-2 border-black p-4">
                <div className="flex items-start gap-2"><Camera className="h-5 w-5 shrink-0" aria-hidden="true" /><strong className="break-words">{channel?.name || `Kênh ${number}`}</strong></div>
                {channel?.name && <span className="text-sm">Kênh {number}</span>}
                <StateBadge state={channel?.state ?? "UNKNOWN"} historical={historical} />
              </article>
            );
          })}
        </div>
        <div className="border-t-2 border-black pt-4">
          <h4 className="mb-3 flex items-center gap-2 font-bold"><HardDrive className="h-5 w-5" aria-hidden="true" />Lưu trữ tại đầu ghi</h4>
          {!snapshot?.storage.length ? <p>Chưa có dữ liệu ổ cứng.</p> : <ul className="space-y-3">
            {snapshot.storage.map((disk) => <li key={disk.slot} className="flex flex-wrap items-center gap-3"><strong>Ổ {disk.slot}</strong><StateBadge state={disk.state} historical={historical} /><span>Đã dùng {bytesLabel(disk.usedBytes)} / Tổng {bytesLabel(disk.totalBytes)}</span></li>)}
          </ul>}
        </div>
      </div>
    </section>
  );
}

function eventTarget(event: CameraEvent, recorders: CameraRecorder[]) {
  const name = recorders.find((recorder) => recorder.id === event.recorder_id)?.display_name ?? "Đầu ghi đã lưu trong lịch sử";
  return `${name}${event.channel !== null ? ` · Kênh ${event.channel}` : ""}${event.slot !== null ? ` · Ổ ${event.slot}` : ""}`;
}

export function CamerasTab({ site, controller }: {
  site: NetworkBuilding;
  controller: Pick<NetworkCenterController, "actor" | "physicalBuildings" | "canView" | "mode" | "isDemo">;
}) {
  const organizationId = controller.physicalBuildings.find((building) => building.id === site.buildingId)?.organizationId ?? "";
  const cameras = useBuildingCameras({
    actorId: controller.actor.id, organizationId, buildingId: site.buildingId,
    canView: controller.canView, mode: controller.mode,
  });
  const { snapshotQuery, eventsQuery } = cameras;
  if (!controller.canView) return <p role="alert" className="nc-empty-copy">Bạn không có quyền xem camera của tòa nhà này.</p>;
  if (!cameras.enabled) return <p role="alert" className="nc-empty-copy">Chưa xác định được phạm vi camera của tòa nhà.</p>;
  const deniedEvents = eventsQuery.error instanceof NetworkCenterRepositoryError && eventsQuery.error.code === "42501";
  if (snapshotQuery.isError || deniedEvents) return <CameraError error={deniedEvents ? eventsQuery.error : snapshotQuery.error} retry={() => void snapshotQuery.refetch()} />;
  if (snapshotQuery.isPending) return <LoadingState label="trạng thái camera" variant="cards" rows={4} />;

  return (
    <div className="nc-tab-stack">
      <div className="nc-panel-heading">
        <div><p className="nc-eyebrow">{controller.isDemo ? "Dữ liệu DEMO · mô phỏng" : "Theo dõi camera theo tòa nhà"}</p><h3>Camera · {site.buildingName}</h3></div>
        <Button variant="outline" disabled={snapshotQuery.isFetching || eventsQuery.isFetching} onClick={() => { void snapshotQuery.refetch(); void eventsQuery.refetch(); }}><RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Làm mới camera</Button>
      </div>
      <div className="nc-locked-note nc-display-note"><Camera aria-hidden="true" /><p><strong>Xem trực tiếp chưa được cấu hình.</strong> Mục này theo dõi kết nối, ổ cứng và lịch sử sự kiện.</p></div>
      {cameras.recorders.length === 0 ? <section className="nc-panel p-6"><h3>Chưa cấu hình đầu ghi</h3><p>Tòa nhà chưa có đầu ghi được đăng ký theo dõi.</p></section>
        : cameras.recorders.map((recorder) => <RecorderCard key={recorder.id} recorder={recorder} now={cameras.now} />)}
      <section className="nc-panel" aria-labelledby="camera-events-title">
        <div className="nc-panel-heading"><div><p className="nc-eyebrow">Lịch sử đã nhận</p><h3 id="camera-events-title">Sự kiện camera</h3></div></div>
        <p className="p-4 text-sm">Theo lần kiểm tra chỉ ghi nhận thay đổi đã quan sát. Luồng sự kiện ghi nhận thông báo đầu ghi gửi đến; không đảm bảo lấy lại mọi sự kiện trong thời gian mất kết nối.</p>
        {eventsQuery.isPending ? <LoadingState label="lịch sử camera" variant="table" rows={3} /> : null}
        {eventsQuery.isError ? <CameraError error={eventsQuery.error} retry={() => void eventsQuery.refetch()} /> : null}
        {cameras.events.length > 0 ? <Table>
          <TableCaption className="sr-only">Lịch sử sự kiện camera của tòa nhà</TableCaption>
          <TableHeader><TableRow><TableHead scope="col">Thời điểm ghi nhận</TableHead><TableHead scope="col">Thiết bị</TableHead><TableHead scope="col">Sự kiện</TableHead></TableRow></TableHeader>
          <TableBody>{cameras.events.map((event) => <TableRow key={event.id}>
            <TableHead scope="row">{timeLabel(event.observed_at)}</TableHead>
            <TableCell>{eventTarget(event, cameras.recorders)}</TableCell>
            <TableCell>{event.previous_state ? `${stateLabel(event.previous_state)} → ` : ""}{stateLabel(event.state)}{event.code ? <small className="block">{event.code}{event.action ? ` · ${event.action}` : ""}</small> : null}</TableCell>
          </TableRow>)}</TableBody>
        </Table> : !eventsQuery.isPending && !eventsQuery.isError ? <p className="nc-empty-copy">Chưa nhận được sự kiện camera.</p> : null}
        {eventsQuery.hasNextPage && !eventsQuery.isError ? <div className="p-4"><Button variant="outline" disabled={eventsQuery.isFetchingNextPage} onClick={() => void eventsQuery.fetchNextPage()}>Xem sự kiện cũ hơn</Button></div> : null}
      </section>
    </div>
  );
}
