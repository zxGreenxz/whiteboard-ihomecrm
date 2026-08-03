import type {
  OpenClawConnectionState,
  OpenClawConversation,
  OpenClawMessage,
  OpenClawMode,
  OpenClawOutboxState,
} from "./types";
// The cursor shape belongs to the hook that pages with it; re-declaring it here
// would let the two drift apart silently.
import type { OpenClawConversationCursor } from "@/hooks/openclaw-zalo/useOpenClawInbox";

/**
 * Puts a thread in reading order and collapses duplicates.
 *
 * `openclaw_list_messages_v1` returns newest-first for pagination, while a thread
 * reads oldest-first. Realtime and polling both deliver the same event, and pages
 * can arrive out of order, so the result must depend only on the SET of events -
 * otherwise two people reading the same thread would disagree about the sequence.
 * The (receivedAt, messageId) tie-break is what makes that total.
 */
export function threadEvents(events: readonly OpenClawMessage[]): OpenClawMessage[] {
  const byId = new Map<string, OpenClawMessage>();
  for (const event of events) byId.set(event.messageId, event);
  return [...byId.values()].sort((left, right) => {
    if (left.receivedAt !== right.receivedAt) {
      return left.receivedAt < right.receivedAt ? -1 : 1;
    }
    return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0;
  });
}

/**
 * The cursor for the NEXT page: the oldest row of the page just rendered.
 *
 * The list RPC orders newest-first and pages with `(last_received_at, id) < cursor`,
 * so taking the first row instead would re-request the page already on screen
 * forever.
 *
 * There is deliberately no message equivalent: threads are not paged yet, and the
 * only message array the app holds is `threadEvents()` output, which is OLDEST-first
 * - feeding that to a "take the last row" cursor would return the newest row and
 * re-request the same page forever. The helper existed with no caller, so it was a
 * footgun waiting for the first person to reach for it.
 */
export function conversationCursorAfter(
  page: readonly OpenClawConversation[],
): OpenClawConversationCursor | null {
  const last = page.at(-1);
  return last ? { lastReceivedAt: last.lastReceivedAt, id: last.conversationId } : null;
}

/** Outbox states a manually sent message can be observed in, in lifecycle order. */
export const MANUAL_SEND_STATES = [
  "QUEUED",
  "LEASED",
  "DISPATCHING",
  "SENT",
  "FAILED",
  "DEAD_LETTER",
  "UNKNOWN",
] as const satisfies readonly OpenClawOutboxState[];

export interface SendLifecycle {
  label: string;
  /** True ONLY for SENT. Nothing else may be presented as reaching the customer. */
  delivered: boolean;
  terminal: boolean;
  /** UNKNOWN needs an operator decision before anything is re-sent. */
  needsResolution: boolean;
}

const LIFECYCLE: Readonly<Record<OpenClawOutboxState, SendLifecycle>> = {
  QUEUED: { label: "Đang chờ gửi", delivered: false, terminal: false, needsResolution: false },
  LEASED: { label: "Đã nhận để gửi", delivered: false, terminal: false, needsResolution: false },
  DISPATCHING: { label: "Đang gửi", delivered: false, terminal: false, needsResolution: false },
  SENT: { label: "Đã gửi", delivered: true, terminal: true, needsResolution: false },
  FAILED: { label: "Gửi thất bại", delivered: false, terminal: true, needsResolution: false },
  DEAD_LETTER: { label: "Đã chuyển dead-letter", delivered: false, terminal: true, needsResolution: false },
  // Deliberately neither delivered nor failed: the message MAY have reached the
  // customer. Calling it a failure invites a duplicate send to a real person.
  UNKNOWN: { label: "Không xác định - cần đối chiếu", delivered: false, terminal: false, needsResolution: true },
};

export function sendLifecycle(state: OpenClawOutboxState): SendLifecycle {
  return LIFECYCLE[state];
}

export type ManualSendBlockedBy =
  | "PERMISSION"
  | "NOT_CONNECTED"
  | "DRAFT_ONLY_MODE"
  | "TAKEOVER_HELD";

export interface ManualSendGateInput {
  canSend: boolean;
  connectionState: OpenClawConnectionState;
  effectiveMode: OpenClawMode;
  takeoverByAnotherMember: boolean;
}

export interface ManualSendGate {
  canSend: boolean;
  blockedBy: ManualSendBlockedBy | null;
}

/**
 * The refusals the browser can PROVE, and only those.
 *
 * An earlier version fed `evaluateSendPolicy` here as a "policy preview". It was
 * dishonest twice over. First, it mapped the wrong columns: the server sets
 * MODE_PAUSED from `not control.feature_enabled` and ACCOUNT_PAUSED from
 * `account.paused_at`, while this mapped MODE_PAUSED from a mode mismatch and
 * ACCOUNT_PAUSED from the feature flag - so the operator was told the wrong reason.
 * Second, and worse, of the eleven policy reasons the server evaluates
 * (QUIET_HOURS, CONSENT_MISSING, SUPPRESSED, RATE_LIMITED, GROUP_NOT_ALLOWLISTED,
 * GROUP_DIRECTORY_STALE, …) the browser holds the data for none, and every one of
 * them is timed against `statement_timestamp()` rather than the client clock. A
 * preview that cannot see them reports ALLOWED at 02:00 inside a quiet-hours
 * window.
 *
 * These four are different: each is decided by a field the bootstrap already
 * carries, or by the takeover list, and each has a server counterpart that raises
 * rather than queueing. Everything else is left to the server, and the UI says so
 * instead of guessing.
 */
export function manualSendGate(input: ManualSendGateInput): ManualSendGate {
  const blockedBy: ManualSendBlockedBy | null = !input.canSend
    ? "PERMISSION"
    : input.connectionState !== "CONNECTED"
      ? "NOT_CONNECTED"
      // openclaw_create_send_intent_v1 raises 55000 'account is not eligible to
      // send' for DRAFT_ONLY, collapsed with two other causes; the browser can
      // separate this one out and say which it is.
      : input.effectiveMode === "DRAFT_ONLY"
        ? "DRAFT_ONLY_MODE"
        : input.takeoverByAnotherMember
          ? "TAKEOVER_HELD"
          : null;
  return { canSend: blockedBy === null, blockedBy };
}
