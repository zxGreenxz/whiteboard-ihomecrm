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

  const groupsQuery = useOpenClawSalesGroups(selectedOrganizationId, accountId);
  const schedulesQuery = useOpenClawSchedules(selectedOrganizationId, accountId);

  const groups: SalesGroupView[] = (groupsQuery.data?.items ?? []).map(item => ({
    targetId: item.targetId,
    displayName: item.displayName,
    memberCount: item.memberCount,
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

  return (
    <OpenClawSchedulesAndGroups
      groups={groups}
      schedules={schedules}
      loading={groupsQuery.isLoading || schedulesQuery.isLoading}
      // The write paths are not bound yet, so the controls stay disabled with their
      // reason visible rather than pretending to work.
      canManage={false}
      now={new Date().toISOString()}
      busy={false}
      onToggleAllowlist={() => undefined}
      onRequestDirectorySync={() => undefined}
      onScheduleAction={() => undefined}
    />
  );
}
