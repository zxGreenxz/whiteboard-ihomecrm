import type {
  OpenClawConnectionState,
  OpenClawConversation,
  OpenClawMessage,
  OpenClawOutboxState,
  OpenClawSendDecision,
} from "./types";
// The cursor shapes belong to the hooks that page with them; re-declaring them here
// would let the two drift apart silently.
import type {
  OpenClawConversationCursor,
  OpenClawMessageCursor,
} from "@/hooks/openclaw-zalo/useOpenClawInbox";

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
 * Both list RPCs order newest-first and page with `(received_at, id) < cursor`, so
 * taking the first row instead would re-request the page already on screen forever.
 */
export function conversationCursorAfter(
  page: readonly OpenClawConversation[],
): OpenClawConversationCursor | null {
  const last = page.at(-1);
  return last ? { lastReceivedAt: last.lastReceivedAt, id: last.conversationId } : null;
}

export function messageCursorAfter(
  page: readonly OpenClawMessage[],
): OpenClawMessageCursor | null {
  const last = page.at(-1);
  return last ? { receivedAt: last.receivedAt, id: last.messageId } : null;
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

export type ManualSendBlockedBy = "PERMISSION" | "NOT_CONNECTED" | "TAKEOVER_HELD" | "POLICY";

export interface ManualSendGateInput {
  canSend: boolean;
  connectionState: OpenClawConnectionState;
  policy: OpenClawSendDecision;
  takeoverByAnotherMember: boolean;
}

export interface ManualSendGate {
  canSend: boolean;
  blockedBy: ManualSendBlockedBy | null;
  /** Carried verbatim so the operator sees "quiet hours", not "not allowed". */
  policyReason: OpenClawSendDecision["reason"] | null;
}

export function manualSendGate(input: ManualSendGateInput): ManualSendGate {
  const blockedBy: ManualSendBlockedBy | null = !input.canSend
    ? "PERMISSION"
    : input.connectionState !== "CONNECTED"
      ? "NOT_CONNECTED"
      : input.takeoverByAnotherMember
        ? "TAKEOVER_HELD"
        : input.policy.allowed
          ? null
          : "POLICY";
  return {
    canSend: blockedBy === null,
    blockedBy,
    policyReason: blockedBy === "POLICY" ? input.policy.reason : null,
  };
}
