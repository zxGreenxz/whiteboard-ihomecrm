/**
 * The three CRM event types, and where each one canonically comes from.
 *
 * Hardcoded on purpose: the source of truth is a CHECK constraint
 * (`20260727070000_openclaw_crm_event_sources.sql`), not a table a browser can read,
 * so there is no RPC to enumerate them. Keeping the list here with its provenance
 * beats inventing a read path or leaving the screen blank.
 */
export const OPENCLAW_CRM_EVENT_TYPES = [
  {
    eventType: "lead_created_or_assigned",
    label: "Có khách hàng tiềm năng mới hoặc được giao",
    canonicalSource: "public.leads",
  },
  {
    eventType: "room_became_available",
    label: "Phòng trở nên còn trống",
    canonicalSource: "public.rooms",
  },
  {
    eventType: "sales_task_due",
    label: "Công việc bán hàng tới hạn",
    canonicalSource: "public.sales_tasks",
  },
] as const;

export type OpenClawScheduleStatus = "PAUSED" | "CANCELLED" | "RUNNING" | "COMPLETE";

export type ScheduleAction = "pause" | "cancel";

export interface ScheduleActionState {
  enabled: boolean;
  blockedBy: "PERMISSION" | "STATUS" | null;
}

/**
 * The only schedule affordances that are true.
 *
 * There is deliberately no Activate or Resume: no function in the migration set
 * performs that transition, so a button for it would be a control that cannot work.
 * Creating one lands PAUSED and stays there until something outside this UI moves
 * it.
 */
export function scheduleActions(input: {
  canManage: boolean;
  status: OpenClawScheduleStatus;
}): Record<ScheduleAction, ScheduleActionState> {
  if (!input.canManage) {
    return {
      pause: { enabled: false, blockedBy: "PERMISSION" },
      cancel: { enabled: false, blockedBy: "PERMISSION" },
    };
  }
  const terminal = input.status === "CANCELLED" || input.status === "COMPLETE";
  return {
    pause: terminal || input.status === "PAUSED"
      ? { enabled: false, blockedBy: "STATUS" }
      : { enabled: true, blockedBy: null },
    cancel: terminal
      ? { enabled: false, blockedBy: "STATUS" }
      : { enabled: true, blockedBy: null },
  };
}

export interface SalesGroupView {
  targetId: string;
  displayName: string;
  memberCount: number;
  directoryVersion: number;
  directoryRefreshedAt: string;
  directoryExpiresAt: string | null;
  isAllowed: boolean | null;
  allowlistVersion: number | null;
}

export type DirectoryFreshness = "FRESH" | "STALE" | "UNKNOWN";

/**
 * Whether a group's directory snapshot is inside the 24-hour window.
 *
 * ADVISORY ONLY, and the UI must say so. The timestamp the server enforces against
 * lives on `openclaw_targets` and is never returned; what the list RPC exposes is
 * the sales-group row's own copy. They usually agree, so this is worth showing - but
 * a write can still fail as stale while this reads fresh, and the failure is
 * indistinguishable from a version conflict.
 */
export function directoryFreshness(group: SalesGroupView, now: string): DirectoryFreshness {
  const expires = group.directoryExpiresAt === null ? null : Date.parse(group.directoryExpiresAt);
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return "UNKNOWN";
  if (expires !== null && Number.isFinite(expires)) return expires > current ? "FRESH" : "STALE";
  const refreshed = Date.parse(group.directoryRefreshedAt);
  if (!Number.isFinite(refreshed)) return "UNKNOWN";
  return current - refreshed < 24 * 60 * 60 * 1000 ? "FRESH" : "STALE";
}
