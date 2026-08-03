import type { ReactNode } from "react";
import type { OpenClawConnectionState } from "@/lib/openclaw-zalo/types";
import OpenClawBoundaryState from "./OpenClawBoundaryState";
import OpenClawInboxSection from "./inbox/OpenClawInboxSection";
import OpenClawOverviewSection from "./overview/OpenClawOverviewSection";
import OpenClawKnowledgeSection from "./knowledge/OpenClawKnowledgeSection";
import OpenClawAutomationSection from "./automation/OpenClawAutomationSection";
import OpenClawSchedulesSection from "./schedules/OpenClawSchedulesSection";
import type { OpenClawSection } from "./OpenClawSectionNav";

interface OpenClawSectionBodyProps {
  activeSection: OpenClawSection;
  connectionState: OpenClawConnectionState;
  canManageConnections: boolean;
  onReconnect: () => void;
  /** Placeholder cards for the sections later phases will fill in. */
  children: ReactNode;
}

/**
 * Decides WHICH section body renders.
 *
 * Split out of the cockpit so a test can render it for a given section directly.
 * The cockpit holds `activeSection` in internal state, and this repo has no DOM
 * test environment to click the nav with - so while the decision lived inline, the
 * only available check was grepping the source for `<OpenClawInboxSection`, which a
 * reviewer showed was satisfied by the string appearing in an unreachable branch.
 */
export default function OpenClawSectionBody({
  activeSection,
  connectionState,
  canManageConnections,
  onReconnect,
  children,
}: OpenClawSectionBodyProps) {
  // Disconnection outranks the section: nothing under it has meaningful data, and
  // showing an empty inbox would read as "no conversations" rather than "no session".
  //
  // QR_PENDING is included deliberately. openclaw_begin_qr_login_v1 moves the
  // account into it the moment a code is requested, and it was NOT in this list -
  // so the one control that opens the connection dialog vanished as soon as the
  // operator used it, stranding them with no way back until an unrelated refetch.
  if (
    connectionState === "DISCONNECTED"
    || connectionState === "RECONNECT_REQUIRED"
    || connectionState === "QR_PENDING"
  ) {
    return (
      <div className="p-4 sm:p-7">
        <OpenClawBoundaryState
          state="disconnected"
          message={connectionState === "RECONNECT_REQUIRED"
            ? "Phiên cần được xác minh và kết nối lại trước khi tiếp tục."
            : connectionState === "QR_PENDING"
              ? "Đang chờ quét mã QR. Mở lại hộp thoại nếu mã đã đóng hoặc hết hạn."
              : undefined}
          actionLabel={canManageConnections
            ? (connectionState === "QR_PENDING" ? "Mở lại mã QR" : "Kết nối lại")
            : undefined}
          onAction={canManageConnections ? onReconnect : undefined}
          compact
        />
      </div>
    );
  }

  switch (activeSection) {
    case "overview": return <OpenClawOverviewSection />;
    case "inbox": return <OpenClawInboxSection />;
    case "knowledge": return <OpenClawKnowledgeSection />;
    case "automation": return <OpenClawAutomationSection />;
    case "schedules": return <OpenClawSchedulesSection />;
    default: break;
  }

  return <>{children}</>;
}
