import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawSalesGroups,
  useOpenClawSchedules,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import type { OpenClawScheduleStatus, SalesGroupView } from "@/lib/openclaw-zalo/schedules";
import OpenClawSchedulesAndGroups, { type ScheduleView } from "./OpenClawSchedulesAndGroups";

/**
 * Wires the groups and schedules screen.
 *
 * Read-only for now on the write paths: the allowlist toggle needs an evidence hash
 * the browser cannot compute from what the list returns, and creating a schedule
 * needs a campaign run nothing in this codebase produces. Both are left as disabled
 * affordances with the reason on screen rather than buttons that fail.
 */
export default function OpenClawSchedulesSection() {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const accountId = bootstrap.account?.accountId ?? null;

  // Both list RPCs require manage_automation. Querying without it yields 42501 and
  // an undefined `data`, which the screen would then render as "no groups / no
  // schedules" - a permission problem told to the operator as an absence of data.
  const canManage = can("manage_automation");
  const groupsQuery = useOpenClawSalesGroups(
    canManage ? selectedOrganizationId : null, accountId,
  );
  const schedulesQuery = useOpenClawSchedules(
    canManage ? selectedOrganizationId : null, accountId,
  );

  const groups: SalesGroupView[] = (groupsQuery.data?.items ?? []).map(item => ({
    targetId: item.targetId,
    displayName: item.displayName,
    // Nullable in the contract because the column is; rendering `null` produced
    // " thành viên" with no number.
    memberCount: item.memberCount ?? 0,
    directoryVersion: item.directoryVersion,
    directoryRefreshedAt: item.directoryRefreshedAt,
    directoryExpiresAt: item.directoryExpiresAt ?? null,
    isAllowed: item.isAllowed ?? null,
    allowlistVersion: item.allowlistVersion ?? null,
  }));

  const schedules: ScheduleView[] = (schedulesQuery.data?.items ?? []).map(item => ({
    scheduleId: item.scheduleId,
    status: item.status as OpenClawScheduleStatus,
    timezone: item.timezone,
    localRecurrenceRule: item.localRecurrenceRule,
    nextRunAt: item.nextRunAt ?? null,
    missedOccurrencePolicy: item.missedOccurrencePolicy,
  }));

  if (!canManage) {
    return (
      <p data-openclaw-schedules="no-permission" className="p-4 text-sm font-bold text-[#8a4b12]">
        Bạn không có quyền quản lý tự động hoá cho tổ chức này.
      </p>
    );
  }

  return (
    <OpenClawSchedulesAndGroups
      groups={groups}
      schedules={schedules}
      loading={groupsQuery.isLoading || schedulesQuery.isLoading}
      // The write paths are not bound yet - pause and cancel need
      // `expectedScheduleVersion`, which the view type does not yet carry - so the
      // controls stay disabled AND the screen now renders the reason, which it did
      // not before.
      canManage={false}
      now={new Date().toISOString()}
      busy={false}
      onToggleAllowlist={() => undefined}
      onRequestDirectorySync={() => undefined}
      onScheduleAction={() => undefined}
    />
  );
}
