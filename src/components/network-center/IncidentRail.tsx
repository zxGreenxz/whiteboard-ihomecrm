import { ArrowRight, Check } from "lucide-react";
import { Link } from "react-router-dom";

import type { NetworkIncident } from "@/lib/network-center/contracts";
import { ExecuteButton } from "./ExecuteGuard";
import { NetworkStatus } from "./NetworkStatus";

interface IncidentRailProps {
  incidents: NetworkIncident[];
  buildingNames: Map<string, string>;
  canExecute: boolean;
  disabledReason: string;
  onAcknowledge: (buildingId: string, incidentId: string) => void;
}

export function IncidentRail({ incidents, buildingNames, canExecute, disabledReason, onAcknowledge }: IncidentRailProps) {
  return (
    <aside className="nc-panel nc-incident-rail" aria-labelledby="incident-rail-title">
      <div className="nc-panel-heading">
        <div><p className="nc-eyebrow">Ưu tiên</p><h2 id="incident-rail-title">Cần xử lý</h2></div>
        <strong>{incidents.length}</strong>
      </div>
      <div className="nc-incident-list">
        {incidents.length ? incidents.map((incident) => (
          <article className="nc-incident-card" key={incident.id}>
            <div className="nc-incident-meta">
              <NetworkStatus kind={incident.severity} />
              <NetworkStatus kind={incident.status} />
            </div>
            <h3>{incident.title}</h3>
            <p><strong>{buildingNames.get(incident.buildingId)}</strong></p>
            <p>{incident.detail}</p>
            <div className="nc-incident-actions">
              <Link to={`/network-center/buildings/${incident.buildingId}?tab=incidents`}>
                Xem sự cố <ArrowRight aria-hidden="true" />
              </Link>
              {incident.status === "open" ? (
                <ExecuteButton
                  canExecute={canExecute}
                  disabledReason={disabledReason}
                  variant="outline"
                  size="sm"
                  onClick={() => onAcknowledge(incident.buildingId, incident.id)}
                >
                  <Check data-icon="inline-start" aria-hidden="true" /> Xác nhận
                </ExecuteButton>
              ) : null}
            </div>
          </article>
        )) : <p className="nc-empty-copy">Không có sự cố đang mở.</p>}
      </div>
    </aside>
  );
}
