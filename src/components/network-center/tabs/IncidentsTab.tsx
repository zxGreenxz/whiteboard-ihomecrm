import { Check, X } from "lucide-react";
import { useState } from "react";

import { ExecuteButton } from "../ExecuteGuard";
import { MaintenanceDialog } from "../MaintenanceDialog";
import { NetworkStatus } from "../NetworkStatus";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";

export function IncidentsTab({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = async (key: string, operation: () => Promise<unknown>) => {
    setPendingKey(key);
    setError("");
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không thể cập nhật sự cố");
    } finally {
      setPendingKey(null);
    }
  };
  return (
    <div className="nc-tab-stack">
      <section className="nc-kpis nc-sla-kpis">
        <article className="nc-kpi nc-tone-good"><span className="nc-kpi-label">SLA 30 ngày</span><strong>{site.uptimePercent}%</strong><small>{controller.isDemo ? "Mức sẵn sàng mô phỏng" : "Mức sẵn sàng đo được"}</small></article>
        <article className="nc-kpi nc-tone-info"><span className="nc-kpi-label">MTTR</span><strong>{site.mttrMinutes}m</strong><small>Thời gian phục hồi</small></article>
        <article className="nc-kpi nc-tone-warn"><span className="nc-kpi-label">Bảo trì</span><strong>{site.maintenance ? "BẬT" : "TẮT"}</strong><small>{site.maintenance?.reason ?? "Không có cửa sổ"}</small></article>
      </section>
      <section className="nc-panel">
        <div className="nc-panel-heading">
          <div><p className="nc-eyebrow">Dòng thời gian sự cố</p><h3>Sự cố & SLA</h3></div>
          <div className="nc-heading-actions">
            <MaintenanceDialog buildingId={site.buildingId} buildingName={site.buildingName} canExecute={controller.canExecute} rolloutState={site.rolloutState} disabledReason={controller.executeDisabledMessage} isDemo={controller.isDemo} onCreate={(input) => controller.createMaintenance(site.buildingId, input)} />
            {site.maintenance ? (
              <ExecuteButton canExecute={controller.canExecute} rolloutState={site.rolloutState} disabledReason={controller.executeDisabledMessage} variant="outline" disabled={pendingKey === "maintenance"} onClick={() => void run("maintenance", () => controller.cancelMaintenance(site.buildingId, site.maintenance!.id))}>
                <X data-icon="inline-start" /> {pendingKey === "maintenance" ? "Đang huỷ…" : "Huỷ bảo trì"}
              </ExecuteButton>
            ) : null}
          </div>
        </div>
        <p className="nc-footnote">{controller.isDemo
          ? "Xác nhận và bảo trì chỉ cập nhật dữ liệu mô phỏng cục bộ, không tác động hệ thống cảnh báo thật."
          : "Xác nhận và bảo trì được ghi audit ngay; lịch sử sự cố vẫn được giữ nguyên để tính SLA."}</p>
        {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
        {site.maintenance ? <div className="nc-maintenance-banner"><NetworkStatus kind="maintenance" /><strong>{site.maintenance.reason}</strong><span>{site.maintenance.durationMinutes} phút · đến {new Date(site.maintenance.endsAt).toLocaleString("vi-VN")}</span></div> : null}
        <ol className="nc-incident-timeline">
          {site.incidents.map((incident) => (
            <li key={incident.id}>
              <div className="nc-incident-meta"><NetworkStatus kind={incident.severity} /><NetworkStatus kind={incident.status} /></div>
              <h4>{incident.title}</h4><p>{incident.detail}</p><time>{new Date(incident.openedAt).toLocaleString("vi-VN")}</time>
              {incident.status === "open" ? (
                <ExecuteButton canExecute={controller.canExecute} rolloutState={site.rolloutState} disabledReason={controller.executeDisabledMessage} variant="outline" size="sm" disabled={pendingKey === incident.id} onClick={() => void run(incident.id, () => controller.acknowledgeIncident(site.buildingId, incident.id))}>
                  <Check data-icon="inline-start" /> {pendingKey === incident.id ? "Đang xác nhận…" : "Xác nhận sự cố"}
                </ExecuteButton>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
