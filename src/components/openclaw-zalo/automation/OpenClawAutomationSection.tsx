import { useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawAutomation,
  useOpenClawAutomationList,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import { wizardStepFromConfiguration } from "@/lib/openclaw-zalo/automationWizard";
import type { OpenClawMode } from "@/lib/openclaw-zalo/types";
import OpenClawBoundaryState from "../OpenClawBoundaryState";
import OpenClawAutomation from "./OpenClawAutomation";

/**
 * Wires the wizard to the current automation version.
 *
 * Only ONE version is readable - `openclaw_get_automation_v1` joins on
 * `current_version` and `openclaw_automation_versions` has no authenticated select
 * policy - so there is no step history to page through. The current step is read
 * back out of `configuration`, which is where the wizard writes it.
 */
export default function OpenClawAutomationSection() {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const accountId = bootstrap.account?.accountId ?? null;
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);

  // Gated like the knowledge screen: every automation RPC requires
  // manage_automation, so a view-only member gets 42501, `data` stays undefined,
  // and an ungated screen would report a permission problem as "no automations".
  const canManageAutomation = can("manage_automation");
  const listQuery = useOpenClawAutomationList(
    canManageAutomation ? selectedOrganizationId : null, accountId,
  );
  const automations = listQuery.data?.items ?? [];
  const first = automations[0] ?? null;
  // Defaults to the first automation so the wizard has something to show without a
  // second click; the picker overrides it.
  const detailQuery = useOpenClawAutomation(
    canManageAutomation ? selectedOrganizationId : null,
    accountId,
    selectedAutomationId ?? first?.automationId ?? null,
  );
  const selected = detailQuery.data?.automation ?? null;

  if (!canManageAutomation) {
    return (
      <p data-openclaw-automation="no-permission" className="p-4 text-sm font-bold text-[#8a4b12]">
        Bạn không có quyền quản lý tự động hoá cho tổ chức này.
      </p>
    );
  }

  if (listQuery.isLoading) {
    return <OpenClawBoundaryState state="loading" compact />;
  }

  if (automations.length === 0) {
    return (
      <p data-openclaw-automation="empty" className="p-4 text-sm text-[#607585]">
        Chưa có tự động hoá nào. Việc tạo bản nháp mới sẽ được nối vào ở bước kế tiếp.
      </p>
    );
  }

  return (
    <div>
      <div className="border-b border-[#cbd5df] p-4">
        <label className="block text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Tự động hoá
        </label>
        <select
          value={selectedAutomationId ?? first?.automationId ?? ""}
          onChange={event => setSelectedAutomationId(event.target.value)}
          data-openclaw-automation="picker"
          className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm"
        >
          {automations.map(automation => (
            <option key={automation.automationId} value={automation.automationId}>
              {automation.name}
            </option>
          ))}
        </select>
      </div>

      <OpenClawAutomation
        automationName={selected?.name ?? first?.name ?? null}
        // The list exposes automationKind, the detail exposes mode; neither is
        // guaranteed present, and DRAFT_ONLY is the safe default because it is the
        // only mode that sends nothing.
        mode={(selected?.mode ?? "DRAFT_ONLY") as OpenClawMode}
        currentStep={wizardStepFromConfiguration(selected?.configuration ?? null)}
        control={bootstrap.control}
        canManageAutomation={canManageAutomation}
        dryRunHash={selected?.dryRunHash ?? null}
        dryRunResult={null}
        busy={detailQuery.isLoading}
        // The step markers and the publish/dry-run calls land with the compose flow;
        // a handler that silently does nothing reads as a broken button.
        onGoToStep={() => undefined}
        onRunDryRun={() => undefined}
        onPublish={() => undefined}
      />
    </div>
  );
}
