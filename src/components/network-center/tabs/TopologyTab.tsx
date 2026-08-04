import { Eye, Network } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { NetworkStatus } from "../NetworkStatus";

type TopologyController = Pick<
  NetworkCenterController,
  | "arubaNodes"
  | "hasNextArubaPage"
  | "isLoadingAruba"
  | "isLoadingMoreAruba"
  | "arubaPageError"
  | "loadMoreAruba"
  | "retryAruba"
>;

export function TopologyTab({
  site,
  controller,
  isDemo = true,
}: {
  site: NetworkBuilding;
  controller?: TopologyController;
  isDemo?: boolean;
}) {
  const uplink = site.interfaces.find((networkInterface) => networkInterface.role === "uplink");
  const arubaNodes = controller?.arubaNodes ?? site.arubaNodes;
  const total = Math.max(site.arubaTotal ?? 0, arubaNodes.length);
  return (
    <div className="nc-tab-stack">
      <div className="nc-locked-note nc-display-note"><Eye /><p><strong>Aruba chỉ dùng để theo dõi.</strong> Màn hình không có thao tác cấu hình, khởi động lại hoặc dữ liệu đăng nhập Aruba.</p></div>
      <section className="nc-topology nc-topology-full" aria-labelledby="topology-title">
        <div className="nc-panel-heading"><div><p className="nc-eyebrow">MikroTik → uplink → AP</p><h3 id="topology-title">Aruba & sơ đồ</h3></div><NetworkStatus kind={site.health} /></div>
        <div className="nc-router-node"><Network /><strong>{site.router.identity}</strong><span>{isDemo ? "Gateway mô phỏng" : "Gateway đang theo dõi"}</span></div>
        <div className="nc-node-connector" aria-hidden="true" />
        <div className="nc-switch-node" data-uplink-status={uplink?.status ?? "missing"}>
          <strong>Switch phân phối</strong>
          <span>Cổng uplink được bảo vệ</span>
          <span>{uplink?.name ?? "Chưa có cổng uplink"}</span>
          <NetworkStatus
            kind={uplink?.status === "up" ? "online" : "offline"}
            label={uplink?.status === "up" ? "UP" : "DOWN"}
          />
        </div>
        <div className="nc-branch-connector" aria-hidden="true" />
        <div className="nc-aruba-nodes nc-aruba-nodes-full">
          {arubaNodes.map((node) => (
            <article className={`nc-aruba-node nc-node-${node.status}`} key={node.id}>
              <strong>{node.name}</strong>
              <span>{node.address}</span>
              <span>Nhánh AP qua {node.uplink}</span>
              <NetworkStatus kind={node.status === "online" ? "online" : node.status === "offline" ? "offline" : "degraded"} label={node.status === "online" ? "Online" : node.status === "slow" ? "Chậm" : "Offline"} />
            </article>
          ))}
        </div>
        {controller?.isLoadingAruba && arubaNodes.length === 0
          ? <p className="nc-empty-copy">Đang tải danh sách Aruba…</p>
          : null}
        {!controller?.isLoadingAruba && !controller?.arubaPageError && arubaNodes.length === 0
          ? <p className="nc-empty-copy">Chưa phát hiện Aruba trong tòa nhà này.</p>
          : null}
        {controller?.arubaPageError
          ? <p className="nc-empty-copy" role="alert">{controller.arubaPageError}</p>
          : null}
        {controller ? (
          <div className="nc-heading-actions">
            <strong>Đang hiển thị {arubaNodes.length} · Tổng {total}</strong>
            {controller.arubaPageError ? (
              <Button type="button" variant="outline" onClick={() => void controller.retryAruba()}>
                Thử lại
              </Button>
            ) : controller.hasNextArubaPage ? (
              <Button
                type="button"
                variant="outline"
                disabled={controller.isLoadingMoreAruba}
                onClick={() => void controller.loadMoreAruba()}
              >
                {controller.isLoadingMoreAruba ? "Đang tải Aruba…" : "Xem trang Aruba tiếp theo"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
