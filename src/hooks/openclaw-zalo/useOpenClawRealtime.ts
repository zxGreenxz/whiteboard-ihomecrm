import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
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
            timers.set(table, setTimeout(() => {
              timers.delete(table);
              void queryClient.invalidateQueries({ queryKey: openClawQueryKeys.scope(organizationId, accountId) });
            }, 100));
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
