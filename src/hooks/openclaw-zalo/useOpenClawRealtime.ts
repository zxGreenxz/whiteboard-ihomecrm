import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { acceptRealtimeEvent, type RealtimeDedupeState } from "@/lib/openclaw-zalo/state-machine";
import type { OpenClawRealtimeEvent } from "@/lib/openclaw-zalo/types";
import { isOpenClawQueryKey, openClawQueryKeys } from "./queryKeys";

export const OPENCLAW_REALTIME_TABLES = [
  "openclaw_accounts",
  "openclaw_account_connections",
  "openclaw_runtime_cells",
  "openclaw_conversations",
  "openclaw_conversation_members",
  "openclaw_messages",
  "openclaw_message_media",
] as const;

interface RealtimePayload {
  commit_timestamp?: string;
  eventType?: string;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
}

export async function resetOpenClawCache(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ predicate: query => isOpenClawQueryKey(query.queryKey) });
  queryClient.removeQueries({ predicate: query => isOpenClawQueryKey(query.queryKey) });
}

export function createOpenClawRealtimeEvent(
  table: string,
  payload: RealtimePayload,
  organizationId: string,
  accountId: string,
): OpenClawRealtimeEvent | null {
  const record = payload.new && Object.keys(payload.new).length > 0 ? payload.new : payload.old;
  if (!record || record.organization_id !== organizationId) return null;
  if (typeof record.account_id === "string" && record.account_id !== accountId) return null;
  const rowId = typeof record.id === "string" ? record.id : "scope";
  const occurredAt = payload.commit_timestamp ?? "unknown-time";
  return {
    id: `${payload.eventType ?? "*"}:${rowId}:${occurredAt}`,
    organizationId,
    accountId,
    resource: table,
    occurredAt,
  };
}

/**
 * A row change refreshes the part of the cockpit it can actually affect.
 *
 * Invalidating the whole scope on every event made one inbound message reload
 * the bootstrap, the overview and the takeover list too - none of which a
 * message changes - so an account syncing its history turned every insert into
 * a full cockpit refetch.
 */
export const OPENCLAW_REALTIME_TABLE_SCOPES = {
  openclaw_accounts: "connection",
  openclaw_account_connections: "connection",
  openclaw_runtime_cells: "connection",
  openclaw_conversations: "inbox",
  openclaw_conversation_members: "inbox",
  openclaw_messages: "inbox",
  openclaw_message_media: "inbox",
} as const satisfies Record<(typeof OPENCLAW_REALTIME_TABLES)[number], "connection" | "inbox">;

export function openClawRealtimeInvalidationKeys(
  table: string,
  organizationId: string,
  accountId: string,
): QueryKey[] {
  const scope = OPENCLAW_REALTIME_TABLE_SCOPES[table as keyof typeof OPENCLAW_REALTIME_TABLE_SCOPES];
  if (scope === "connection") {
    return [
      openClawQueryKeys.bootstrap(organizationId, accountId),
      openClawQueryKeys.overview(organizationId, accountId),
    ];
  }
  if (scope === "inbox") {
    return [
      openClawQueryKeys.conversationsRoot(organizationId, accountId),
      openClawQueryKeys.messagesRoot(organizationId, accountId),
    ];
  }
  // An unmapped table is refreshed conservatively rather than ignored.
  return [openClawQueryKeys.scope(organizationId, accountId)];
}

/** Quiet-period wait before a burst of row changes is applied. */
export const OPENCLAW_REALTIME_DEBOUNCE_MS = 750;
/**
 * Ceiling on how long a *sustained* stream may keep postponing the refresh.
 *
 * A plain debounce never fires while events keep arriving. A Zalo account
 * syncing its history emits them continuously, so the conversation list was
 * cancelled and restarted about ten times a second and never finished loading -
 * the inbox sat on "Đang tải hội thoại…" indefinitely while every request
 * returned 200. The ceiling guarantees the data lands even under a firehose.
 */
export const OPENCLAW_REALTIME_MAX_WAIT_MS = 4_000;

export interface RealtimeFlushSchedule {
  /** Delay to arm the timer with, in milliseconds. */
  delayMs: number;
  /** When the current burst started waiting; carried to the next event. */
  queuedSince: number;
}

/**
 * Trailing debounce with a maximum wait. Pure so the ceiling is testable without
 * a browser, a socket, or real time passing.
 */
export function scheduleRealtimeFlush(
  now: number,
  queuedSince: number | null,
  debounceMs: number = OPENCLAW_REALTIME_DEBOUNCE_MS,
  maxWaitMs: number = OPENCLAW_REALTIME_MAX_WAIT_MS,
): RealtimeFlushSchedule {
  const since = queuedSince ?? now;
  const remainingBeforeCeiling = Math.max(0, maxWaitMs - (now - since));
  return { delayMs: Math.min(debounceMs, remainingBeforeCeiling), queuedSince: since };
}

export function shouldInvalidateOpenClawRealtime(
  state: RealtimeDedupeState,
  event: OpenClawRealtimeEvent,
): { accepted: boolean; state: RealtimeDedupeState } {
  return acceptRealtimeEvent(state, event);
}

export function useOpenClawRealtime(
  organizationId: string | null,
  accountId: string | null,
  sessionGeneration: number | null,
) {
  const queryClient = useQueryClient();
  const previousScope = useRef<string | null>(null);

  useEffect(() => {
    if (!organizationId || !accountId) return;
    const scopeId = `${organizationId}:${accountId}:${sessionGeneration ?? "none"}`;
    const scopeChanged = previousScope.current !== null && previousScope.current !== scopeId;
    previousScope.current = scopeId;
    let cancelled = false;
    let dedupeState: RealtimeDedupeState = { seen: new Set() };
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    // When the burst started, per table, so a sustained stream still flushes.
    const queuedSince = new Map<string, number>();

    let channel: ReturnType<typeof supabase.channel> | null = null;
    const start = async () => {
      if (scopeChanged) await resetOpenClawCache(queryClient);
      if (cancelled) return;
      let nextChannel = supabase.channel(`openclaw-zalo:${organizationId}:${accountId}:${sessionGeneration ?? "none"}`);
      for (const table of OPENCLAW_REALTIME_TABLES) {
        nextChannel = nextChannel.on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `organization_id=eq.${organizationId}` },
          payload => {
            const event = createOpenClawRealtimeEvent(table, payload as RealtimePayload, organizationId, accountId);
            if (!event) return;
            const decision = shouldInvalidateOpenClawRealtime(dedupeState, event);
            dedupeState = decision.state;
            if (!decision.accepted) return;
            const previousTimer = timers.get(table);
            if (previousTimer) clearTimeout(previousTimer);
            const schedule = scheduleRealtimeFlush(Date.now(), queuedSince.get(table) ?? null);
            queuedSince.set(table, schedule.queuedSince);
            timers.set(table, setTimeout(() => {
              timers.delete(table);
              queuedSince.delete(table);
              for (const queryKey of openClawRealtimeInvalidationKeys(table, organizationId, accountId)) {
                void queryClient.invalidateQueries({ queryKey });
              }
            }, schedule.delayMs));
          },
        );
      }
      channel = nextChannel;
      channel.subscribe(status => {
        if (status === "SUBSCRIBED") {
          void queryClient.refetchQueries({ queryKey: openClawQueryKeys.scope(organizationId, accountId) });
          void queryClient.refetchQueries({ queryKey: openClawQueryKeys.bootstrap(organizationId, accountId) });
        }
      });
    };
    void start();

    return () => {
      cancelled = true;
      timers.forEach(timer => clearTimeout(timer));
      previousScope.current = scopeId;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [organizationId, accountId, sessionGeneration, queryClient]);
}
