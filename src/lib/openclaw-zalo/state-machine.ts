import type {
  OpenClawCursor,
  OpenClawOutboxState,
  OpenClawRealtimeEvent,
  OpenClawUnknownItem,
  OpenClawUnknownResolutionSummary,
} from "./types";

export const OPENCLAW_OUTBOX_STATES = [
  "QUEUED",
  "LEASED",
  "DISPATCHING",
  "SENT",
  "FAILED",
  "UNKNOWN",
  "DEAD_LETTER",
] as const satisfies readonly OpenClawOutboxState[];

export const OUTBOX_TRANSITIONS: Readonly<Record<OpenClawOutboxState, readonly OpenClawOutboxState[]>> = {
  QUEUED: ["LEASED", "FAILED", "DEAD_LETTER"],
  LEASED: ["QUEUED", "DISPATCHING", "FAILED", "UNKNOWN", "DEAD_LETTER"],
  DISPATCHING: ["SENT", "FAILED", "UNKNOWN", "DEAD_LETTER"],
  SENT: [],
  FAILED: [],
  UNKNOWN: [],
  DEAD_LETTER: [],
};

export function canTransitionOutbox(from: OpenClawOutboxState, to: OpenClawOutboxState): boolean {
  return OUTBOX_TRANSITIONS[from].includes(to);
}

export function isTerminalOutboxState(state: OpenClawOutboxState): boolean {
  return OUTBOX_TRANSITIONS[state].length === 0;
}

/** Ascending canonical comparison. APIs use the reverse order for cursor pages. */
export function compareCursor(left: OpenClawCursor, right: OpenClawCursor): number {
  const timestampOrder = left.receivedAt.localeCompare(right.receivedAt);
  return timestampOrder || left.id.localeCompare(right.id);
}

export function isBeforeCursor(item: OpenClawCursor, cursor: OpenClawCursor): boolean {
  return compareCursor(item, cursor) < 0;
}

export function dedupeRealtimeEvents(events: readonly OpenClawRealtimeEvent[]): OpenClawRealtimeEvent[] {
  const seen = new Set<string>();
  const result: OpenClawRealtimeEvent[] = [];
  for (const event of events) {
    const key = `${event.organizationId}:${event.accountId}:${event.resource}:${event.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result;
}

export interface RealtimeDedupeState {
  seen: ReadonlySet<string>;
}

export function acceptRealtimeEvent(
  state: RealtimeDedupeState,
  event: OpenClawRealtimeEvent,
): { accepted: boolean; state: RealtimeDedupeState } {
  const key = `${event.organizationId}:${event.accountId}:${event.resource}:${event.id}`;
  if (state.seen.has(key)) return { accepted: false, state };
  const seen = new Set(state.seen);
  seen.add(key);
  if (seen.size > 2_048) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest) seen.delete(oldest);
  }
  return { accepted: true, state: { seen } };
}

export function attachUnknownResolution(
  item: OpenClawUnknownItem,
  resolution: OpenClawUnknownResolutionSummary,
): OpenClawUnknownItem {
  if (item.historicalState !== "UNKNOWN" || item.resolutionVersion !== 0 || item.resolution) {
    throw new Error("UNKNOWN resolution is immutable");
  }
  return {
    ...item,
    historicalState: "UNKNOWN",
    resolutionVersion: 1,
    resolution,
  };
}
