import { Eye, Network } from "lucide-react";

import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { NetworkStatus } from "../NetworkStatus";

export function TopologyTab({ site, isDemo = true }: { site: NetworkBuilding; isDemo?: boolean }) {
  const uplink = site.interfaces.find((networkInterface) => networkInterface.role === "uplink");
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
          {site.arubaNodes.map((node) => (
            <article className={`nc-aruba-node nc-node-${node.status}`} key={node.id}>
              <strong>{node.name}</strong>
              <span>{node.address}</span>
              <span>Nhánh AP qua {node.uplink}</span>
              <NetworkStatus kind={node.status === "online" ? "online" : node.status === "offline" ? "offline" : "degraded"} label={node.status === "online" ? "Online" : node.status === "slow" ? "Chậm" : "Offline"} />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
