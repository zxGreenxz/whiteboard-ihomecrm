import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawInbox from "../inbox/OpenClawInbox";
import ConversationList from "../inbox/ConversationList";
import ConversationThread from "../inbox/ConversationThread";
import AiDraftPanel from "../inbox/AiDraftPanel";
import type { OpenClawConversation, OpenClawMessage } from "@/lib/openclaw-zalo/types";

const conversation = (id: string, unread = 0): OpenClawConversation => ({
  conversationId: id,
  targetId: `khach-${id}`,
  status: "OPEN",
  assignedMembershipId: null,
  unreadCount: unread,
  lastReceivedAt: "2026-08-03T10:00:00.000Z",
  lastMessageId: null,
  version: 1,
});

const message = (id: string, receivedAt: string): OpenClawMessage => ({
  messageId: id,
  direction: "INBOUND",
  eventKind: "TEXT",
  providerTimestamp: null,
  receivedAt,
  createdAt: receivedAt,
});

const noop = vi.fn();

const inboxProps = {
  conversations: [conversation("c1", 3)],
  selectedConversationId: "c1",
  conversationsLoading: false,
  conversationsHasMore: false,
  messages: [message("m1", "2026-08-03T10:00:01.000Z")],
  messagesLoading: false,
  mediaUnavailable: false,
  drafts: [],
  draftsLoading: false,
  sendGate: {
    canSend: true,
    connectionState: "CONNECTED" as const,
    policy: { allowed: true, reason: "ALLOWED" as const },
    takeoverByAnotherMember: false,
  },
  canManageHandoff: true,
  takeover: null,
  lastSendState: null,
  onSelectConversation: noop,
  onLoadMoreConversations: noop,
  onConfirmSend: noop,
  onStartTakeover: noop,
  onReleaseTakeover: noop,
};

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("conversation list", () => {
  it("says the inbox is empty instead of inventing sample rows", () => {
    const html = render(createElement(ConversationList, {
      conversations: [], selectedConversationId: null, hasMore: false,
      loading: false, onSelect: noop, onLoadMore: noop,
    }));
    expect(html).toContain('data-openclaw-inbox="conversations-empty"');
    expect(html).toContain("Chưa có hội thoại nào");
  });

  it("offers the next page only when there is one", () => {
    const withMore = render(createElement(ConversationList, {
      conversations: [conversation("c1")], selectedConversationId: null, hasMore: true,
      loading: false, onSelect: noop, onLoadMore: noop,
    }));
    expect(withMore).toContain('data-openclaw-action="load-more-conversations"');
    const withoutMore = render(createElement(ConversationList, {
      conversations: [conversation("c1")], selectedConversationId: null, hasMore: false,
      loading: false, onSelect: noop, onLoadMore: noop,
    }));
    expect(withoutMore).not.toContain('data-openclaw-action="load-more-conversations"');
  });

  it("shows an unread badge only where there is something unread", () => {
    const html = render(createElement(ConversationList, {
      conversations: [conversation("c1", 4), conversation("c2", 0)],
      selectedConversationId: "c1", hasMore: false, loading: false,
      onSelect: noop, onLoadMore: noop,
    }));
    expect(html).toContain('data-openclaw-unread="c1"');
    expect(html).not.toContain('data-openclaw-unread="c2"');
  });
});

describe("conversation thread", () => {
  it("renders events oldest-first whatever order they arrived in", () => {
    const html = render(createElement(ConversationThread, {
      messages: [
        message("m2", "2026-08-03T10:00:02.000Z"),
        message("m1", "2026-08-03T10:00:01.000Z"),
      ],
      loading: false, mediaUnavailable: false,
    }));
    expect(html.indexOf('data-openclaw-message="m1"'))
      .toBeLessThan(html.indexOf('data-openclaw-message="m2"'));
  });

  it("never renders message text, because the RPC never returns any", () => {
    // openclaw_list_messages_v1 returns id/direction/eventKind/timestamps only.
    // A body here would be a field that does not exist in the contract.
    const html = render(createElement(ConversationThread, {
      messages: [message("m1", "2026-08-03T10:00:01.000Z")],
      loading: false, mediaUnavailable: false,
    }));
    expect(html).toContain("Chỉ hiển thị siêu dữ liệu sự kiện");
  });

  it("says so when a media object could not be resolved", () => {
    const html = render(createElement(ConversationThread, {
      messages: [], loading: false, mediaUnavailable: true,
    }));
    expect(html).toContain('data-openclaw-thread="media-unavailable"');
  });
});

describe("AI draft panel", () => {
  const draft = {
    draftId: "d1", draftVersion: 2, humanEditVersion: 0,
    dlpDecision: "PASS" as const, publicationState: "REVIEW_ONLY" as const,
    citationCount: 1, citations: [{ knowledgeId: "k1" }], knowledgeVersionIds: ["k1"],
    createdAt: "2026-08-03T10:00:00.000Z", draftText: "Chào anh chị",
  };

  it("shows the text and its citations when DLP passed", () => {
    const html = render(createElement(AiDraftPanel, { drafts: [draft], loading: false }));
    expect(html).toContain("Chào anh chị");
    expect(html).toContain("1 trích dẫn");
  });

  it("renders a blocked draft without any text at all", () => {
    // The server sends draftText: null for a non-PASS draft, so there is nothing to
    // redact client-side - and nothing that a DOM inspector could recover.
    const html = render(createElement(AiDraftPanel, {
      drafts: [{
        ...draft, dlpDecision: "BLOCK" as const, draftText: null, citations: null,
      }],
      loading: false,
    }));
    expect(html).toContain('data-openclaw-draft-withheld="d1"');
    expect(html).not.toContain("Chào anh chị");
    // The count still tells a reviewer the draft was grounded; the contents do not
    // ship, because citations is free-form jsonb that could carry source excerpts.
    expect(html).toContain("1 trích dẫn");
    expect(html).toContain("nội dung được giữ lại");
    expect(html).not.toContain("knowledgeId");
  });

  it("has no send control anywhere, because a draft is review-only", () => {
    const html = render(createElement(AiDraftPanel, { drafts: [draft], loading: false }));
    expect(html).not.toContain("<button");
  });
});

describe("manual send", () => {
  it("offers the confirmation only when every gate is open", () => {
    const html = render(createElement(OpenClawInbox, inboxProps));
    expect(html).toContain('data-openclaw-action="confirm-send"');
  });

  it("replaces the control with the reason the server would refuse", () => {
    const html = render(createElement(OpenClawInbox, {
      ...inboxProps,
      sendGate: { ...inboxProps.sendGate, policy: { allowed: false, reason: "QUIET_HOURS" } },
    }));
    expect(html).not.toContain('data-openclaw-action="confirm-send"');
    expect(html).toContain('data-openclaw-policy-reason="QUIET_HOURS"');
  });

  it("never presents an in-flight send as delivered", () => {
    for (const state of ["QUEUED", "LEASED", "DISPATCHING"] as const) {
      const html = render(createElement(OpenClawInbox, { ...inboxProps, lastSendState: state }));
      expect(html, state).toContain('data-openclaw-send-delivered="false"');
    }
    const sent = render(createElement(OpenClawInbox, { ...inboxProps, lastSendState: "SENT" }));
    expect(sent).toContain('data-openclaw-send-delivered="true"');
  });

  it("warns against re-sending an UNKNOWN rather than calling it a failure", () => {
    const html = render(createElement(OpenClawInbox, { ...inboxProps, lastSendState: "UNKNOWN" }));
    expect(html).toContain('data-openclaw-send-delivered="false"');
    expect(html).toContain("khách nhận hai lần");
  });
});

describe("permission and handoff states", () => {
  it("renders cleanly for a read-only member: no send, no handoff", () => {
    const html = render(createElement(OpenClawInbox, {
      ...inboxProps,
      sendGate: { ...inboxProps.sendGate, canSend: false },
      canManageHandoff: false,
    }));
    expect(html).toContain('data-openclaw-send-blocked="PERMISSION"');
    expect(html).not.toContain('data-openclaw-action="confirm-send"');
    expect(html).not.toContain('data-openclaw-action="start-takeover"');
    // Still a usable screen, not an error page.
    expect(html).toContain('data-openclaw-thread="events"');
  });

  it("shows who holds a takeover and blocks sending while they do", () => {
    const html = render(createElement(OpenClawInbox, {
      ...inboxProps,
      sendGate: { ...inboxProps.sendGate, takeoverByAnotherMember: true },
      takeover: {
        ownerMembershipId: "m2", ownerName: "Chị Lan",
        expiresAt: "2026-08-03T11:00:00.000Z", heldByCurrentMember: false,
      },
    }));
    expect(html).toContain('data-openclaw-takeover="other"');
    expect(html).toContain("Chị Lan");
    expect(html).toContain('data-openclaw-send-blocked="TAKEOVER_HELD"');
    expect(html).toContain("Trả lời tự động bị tạm dừng");
  });

  it("offers release rather than start once this member holds it", () => {
    const html = render(createElement(OpenClawInbox, {
      ...inboxProps,
      takeover: {
        ownerMembershipId: "m1", ownerName: "Tôi",
        expiresAt: "2026-08-03T11:00:00.000Z", heldByCurrentMember: true,
      },
    }));
    expect(html).toContain('data-openclaw-action="release-takeover"');
    expect(html).not.toContain('data-openclaw-action="start-takeover"');
  });
});
