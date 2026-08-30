import { ArrowLeft, Building2, Database, Network, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PhysicalBuildingRecord } from "@/lib/network-center/contracts";
import type { NetworkCenterMode } from "@/lib/network-center/runtime";
import { NetworkStatus } from "./NetworkStatus";

interface NetworkCenterShellProps {
  buildings: PhysicalBuildingRecord[];
  selectedBuildingId?: string;
  canExecute: boolean;
  mode: NetworkCenterMode;
  /** Nạp lại mọi truy vấn Network Center — xem `refreshAll` của controller. */
  onRefresh: () => void | Promise<void>;
  /** Có truy vấn nào đang chạy không (khoá nút + quay icon). */
  isRefreshing: boolean;
  children: ReactNode;
}

export function NetworkCenterShell({
  buildings,
  selectedBuildingId,
  canExecute,
  mode,
  onRefresh,
  isRefreshing,
  children,
}: NetworkCenterShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const selectedBuilding = buildings.find(
    (building) => building.id === selectedBuildingId,
  );
  const rolloutStatus = selectedBuilding?.rolloutState;
  const fleetFullyExecutable = buildings.every(
    (building) => building.rolloutState === "EXECUTE",
  );
  const statusLabel = rolloutStatus === "READ_ONLY"
    ? "Chỉ đọc"
    : rolloutStatus === "OFF"
      ? "Đã tắt"
      : !selectedBuildingId && !fleetFullyExecutable
        ? "Theo từng tòa"
        : undefined;

  const switchBuilding = (buildingId: string) => {
    const tab = searchParams.get("tab");
    const suffix = location.pathname.includes("/buildings/") && tab
      ? `?tab=${encodeURIComponent(tab)}`
      : "";
    navigate(`/network-center/buildings/${buildingId}${suffix}`);
  };

  return (
    <div className="network-center">
      <header className="nc-header">
        <div className="nc-header-brand">
          <Link to="/" className="nc-back-link">
            <ArrowLeft aria-hidden="true" />
            Về iHomeCRM
          </Link>
          <div className="nc-title-row">
            <span className="nc-brand-icon"><Network aria-hidden="true" /></span>
            <div>
              <p className="nc-eyebrow">iHomeCRM / vận hành</p>
              <h1>Trung tâm mạng</h1>
            </div>
          </div>
        </div>

        <div className="nc-header-tools">
          <div className="nc-demo-label"><Database aria-hidden="true" /> {mode === "demo" ? "Dữ liệu mô phỏng" : "Dữ liệu trực tiếp"}</div>
          {/* Router được hỏi thăm 30 phút một lần (migration 20260830165629) và
              sự kiện realtime còn bị gom 5 giây, nên đây là đường tắt cho người
              muốn số liệu ngay. */}
          <button
            type="button"
            className="nc-refresh-button"
            onClick={() => { void onRefresh(); }}
            disabled={isRefreshing}
            title="Nạp lại số liệu Trung tâm mạng"
          >
            <RefreshCw aria-hidden="true" className={isRefreshing ? "nc-refresh-spinning" : undefined} />
            {isRefreshing ? "Đang nạp…" : "Làm mới"}
          </button>
          <NetworkStatus
            kind={canExecute && (selectedBuildingId
              ? rolloutStatus === "EXECUTE"
              : fleetFullyExecutable)
              ? "execute"
              : "view-only"}
            label={statusLabel}
          />
          <div className="nc-building-picker">
            <span><Building2 aria-hidden="true" /> Chuyển toà nhà</span>
            <Select value={selectedBuildingId} onValueChange={switchBuilding}>
              <SelectTrigger aria-label="Chuyển toà nhà">
                <SelectValue placeholder="Chọn toà nhà" />
              </SelectTrigger>
              <SelectContent className="network-center nc-select-content">
                <SelectGroup>
                  {buildings.map((building) => (
                    <SelectItem key={building.id} value={building.id}>{building.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>
      <main className="nc-main">{children}</main>
    </div>
  );
}
