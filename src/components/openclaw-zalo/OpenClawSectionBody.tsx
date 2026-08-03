import type { ReactNode } from "react";
import type { OpenClawConnectionState } from "@/lib/openclaw-zalo/types";
import OpenClawBoundaryState from "./OpenClawBoundaryState";
import OpenClawInboxSection from "./inbox/OpenClawInboxSection";
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
  if (connectionState === "DISCONNECTED" || connectionState === "RECONNECT_REQUIRED") {
    return (
      <div className="p-4 sm:p-7">
        <OpenClawBoundaryState
          state="disconnected"
          message={connectionState === "RECONNECT_REQUIRED"
            ? "Phiên cần được xác minh và kết nối lại trước khi tiếp tục."
            : undefined}
          actionLabel={canManageConnections ? "Kết nối lại" : undefined}
          onAction={canManageConnections ? onReconnect : undefined}
          compact
        />
      </div>
    );
  }

  if (activeSection === "inbox") return <OpenClawInboxSection />;

  return <>{children}</>;
}
