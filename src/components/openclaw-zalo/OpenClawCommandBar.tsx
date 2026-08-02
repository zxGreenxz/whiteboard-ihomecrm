import type {
  OpenClawMode,
  OpenClawOrganization,
  OpenClawSessionRiskState,
} from "@/lib/openclaw-zalo/types";
import {
  Activity,
  Ban,
  Building2,
  CirclePause,
  Radio,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";

const MODE_LABELS: Record<OpenClawMode, string> = {
  DRAFT_ONLY: "Chỉ bản nháp",
  MANUAL_SEND: "Gửi thủ công",
  LIMITED_AUTO_REPLY: "Tự động giới hạn",
  PROACTIVE: "Chủ động",
  SALES_GROUPS: "Nhóm sale",
};

type CommandHealth = OpenClawSessionRiskState | "NO_ACCOUNT";

const HEALTH_LABELS: Record<CommandHealth, string> = {
  HEALTHY: "Phiên khỏe",
  DEGRADED: "Phiên suy giảm",
  LIMITED: "Phiên giới hạn",
  SUSPECTED_THEFT: "Nghi ngờ mất phiên",
  INVALID: "Phiên không hợp lệ",
  NO_ACCOUNT: "Chưa có tài khoản",
};

interface OpenClawCommandBarProps {
  organizations?: readonly OpenClawOrganization[];
  selectedOrganizationId?: string;
  onOrganizationChange?: (organizationId: string) => void;
  organizationName: string;
  accountName: string | null;
  connectionHealth: CommandHealth;
  /**
   * Optional and UNSET by default. The bootstrap payload carries no heartbeat
   * timestamp, so the previous hardcoded "Chưa có heartbeat" rendered a permanent
   * false signal on a HEALTHY account. Until a real field exists the tile shows the
   * session risk state, which is real data.
   */
  lastHeartbeatLabel?: string;
  configuredMode: OpenClawMode | null;
  effectiveMode: OpenClawMode | null;
  paused: boolean;
  globalStop: boolean;
  canManageOperations: boolean;
  onGlobalStop: () => void;
}

interface StatusItemProps {
  icon: typeof Activity;
  label: string;
  value: string;
  tone?: "neutral" | "healthy" | "warning" | "danger";
}

function StatusItem({ icon: Icon, label, value, tone = "neutral" }: StatusItemProps) {
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-2 border-r border-[#d3dce2] px-3 last:border-r-0">
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 text-[#526777]",
          tone === "healthy" && "text-[#0f766e]",
          tone === "warning" && "text-[#9a6700]",
          tone === "danger" && "text-[#b42318]",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block text-[10px] font-bold uppercase tracking-[0.08em] text-[#718391]">{label}</span>
        <span className="block truncate text-xs font-semibold text-[#17324d]">{value}</span>
      </span>
    </div>
  );
}

export default function OpenClawCommandBar({
  organizations = [],
  selectedOrganizationId,
  onOrganizationChange,
  organizationName,
  accountName,
  connectionHealth,
  lastHeartbeatLabel,
  configuredMode,
  effectiveMode,
  paused,
  globalStop,
  canManageOperations,
  onGlobalStop,
}: OpenClawCommandBarProps) {
  const healthTone = connectionHealth === "HEALTHY"
    ? "healthy"
    : connectionHealth === "DEGRADED" || connectionHealth === "LIMITED"
      ? "warning"
      : "danger";

  return (
    <header className="sticky top-0 z-30 border-b border-[#aebdc8] bg-[#fffdf8] text-[#102a43]">
      <div className="grid min-w-0 grid-cols-2 border-b border-[#d3dce2] md:grid-cols-4 xl:grid-cols-6">
        <div className="flex min-h-11 min-w-0 items-center gap-2 border-r border-[#d3dce2] px-3">
          <Building2 className="h-4 w-4 shrink-0 text-[#0f766e]" aria-hidden="true" />
          {organizations.length > 1 && selectedOrganizationId && onOrganizationChange ? (
            <label className="min-w-0 flex-1">
              <span className="block text-[10px] font-bold uppercase tracking-[0.08em] text-[#718391]">Tổ chức</span>
              <select
                aria-label="Tổ chức OpenClaw Zalo"
                value={selectedOrganizationId}
                onChange={event => onOrganizationChange(event.target.value)}
                // 44px minimum touch target: only the select is hit-testable, so a
                // 28px control inside a 44px wrapper still fails the requirement.
                className="min-h-11 w-full min-w-0 bg-transparent text-xs font-semibold text-[#17324d] outline-none"
              >
                {organizations.map(organization => (
                  <option key={organization.organizationId} value={organization.organizationId}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="min-w-0">
              <span className="block text-[10px] font-bold uppercase tracking-[0.08em] text-[#718391]">Tổ chức</span>
              <span className="block truncate text-xs font-semibold text-[#17324d]">{organizationName}</span>
            </span>
          )}
        </div>
        <StatusItem icon={UserRound} label="Tài khoản" value={accountName ?? "Chưa kết nối"} />
        <StatusItem
          icon={Activity}
          label="Sức khỏe phiên"
          value={HEALTH_LABELS[connectionHealth]}
          tone={healthTone}
        />
        <StatusItem
          icon={Radio}
          label={lastHeartbeatLabel ? "Heartbeat" : "Rủi ro phiên"}
          value={lastHeartbeatLabel ?? connectionHealth}
          tone={connectionHealth === "HEALTHY" ? "healthy" : "warning"}
        />
        <StatusItem
          icon={CirclePause}
          label="Chế độ"
          value={configuredMode && effectiveMode
            ? `${MODE_LABELS[configuredMode]} → ${MODE_LABELS[effectiveMode]}`
            : "Chưa cấu hình"}
          tone={configuredMode === effectiveMode ? "neutral" : "warning"}
        />
        <StatusItem
          icon={paused ? Ban : Activity}
          label="Outbound"
          value={paused ? "Đang tạm dừng" : "Đang cho phép"}
          tone={paused ? "warning" : "healthy"}
        />
      </div>

      <div
        className={cn(
          "flex min-h-12 items-center justify-between gap-3 px-3 py-2",
          globalStop ? "bg-[#fff0ed] text-[#8f201a]" : "bg-[#edf4f2] text-[#0b5d51]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 text-xs font-bold sm:text-sm">
            GLOBAL_STOP: {globalStop ? "ĐANG BẬT — toàn bộ outbound của tổ chức đã dừng" : "đang tắt"}
          </p>
        </div>
        {/*
          This button NAVIGATES to the operations section; it does not stop anything.
          The GLOBAL_STOP mutation itself belongs to the operations task. Labelling a
          navigation control "DỪNG TOÀN BỘ GỬI" was actively dangerous: an operator in
          an incident would press it, watch the tab change, and believe outbound had
          stopped. The label now states exactly what happens.
        */}
        <button
          type="button"
          aria-label="Mở kiểm soát GLOBAL_STOP"
          onClick={onGlobalStop}
          disabled={!canManageOperations}
          title={canManageOperations
            ? "Mở mục Vận hành để bật GLOBAL_STOP"
            : "Cần quyền manage_operations"}
          className="min-h-11 shrink-0 border border-[#b42318] bg-[#b42318] px-3 text-xs font-extrabold text-white hover:bg-[#8f201a] disabled:cursor-not-allowed disabled:border-[#c8a6a2] disabled:bg-[#ead4d1] disabled:text-[#795e5b]"
        >
          MỞ KIỂM SOÁT GLOBAL_STOP
        </button>
      </div>

      {/*
        Residual risk disclosure required by the design spec. It must stay VISIBLE,
        not folded behind a dismiss button or a collapsed panel: an operator has to
        know at all times that this channel is unofficial and that recovery means
        re-scanning a QR, never restoring a saved cookie or session snapshot.
      */}
      <p
        data-openclaw-residual-risk="true"
        className="border-t border-[#d8c9a8] bg-[#fdf7ea] px-3 py-1.5 text-[11px] leading-snug text-[#6b5b3e]"
      >
        Zalo Personal là kênh <strong>không chính thức</strong>: Zalo có thể đổi giao thức
        hoặc khoá tài khoản bất kỳ lúc nào. Khi mất phiên, khôi phục <strong>chỉ</strong> bằng
        cách quét lại QR — hệ thống không lưu và không phục hồi cookie hay ảnh chụp phiên.
      </p>
    </header>
  );
}
