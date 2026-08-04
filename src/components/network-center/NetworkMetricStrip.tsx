import { AlertTriangle, CheckCircle2, Clock3, DatabaseBackup, Radio, Wrench } from "lucide-react";

import type { FleetSummary } from "@/lib/network-center/contracts";

const metrics = [
  { key: "online", label: "Hoạt động tốt", icon: CheckCircle2, tone: "good" },
  { key: "degraded", label: "Suy giảm", icon: AlertTriangle, tone: "warn" },
  { key: "offline", label: "Mất kết nối", icon: Radio, tone: "bad" },
  { key: "openIncidents", label: "Sự cố đang mở", icon: AlertTriangle, tone: "bad" },
  { key: "staleBackups", label: "Backup quá hạn", icon: DatabaseBackup, tone: "warn" },
  { key: "activeMaintenance", label: "Đang bảo trì", icon: Wrench, tone: "info" },
] as const;

export function NetworkMetricStrip({ summary, isDemo = false }: { summary: FleetSummary; isDemo?: boolean }) {
  return (
    <section className="nc-kpis" aria-label="Chỉ số toàn hệ thống">
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <article className={`nc-kpi nc-tone-${metric.tone}`} key={metric.key}>
            <span className="nc-kpi-label"><Icon aria-hidden="true" /> {metric.label}</span>
            <strong>{summary[metric.key]}</strong>
            <small><Clock3 aria-hidden="true" /> {isDemo ? "Cập nhật mô phỏng ổn định" : "Cập nhật từ worker và Realtime"}</small>
          </article>
        );
      })}
    </section>
  );
}
