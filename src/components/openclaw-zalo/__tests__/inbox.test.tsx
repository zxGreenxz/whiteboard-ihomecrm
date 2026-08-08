import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawInbox from "../inbox/OpenClawInbox";
import ConversationList from "../inbox/ConversationList";
import ConversationThread from "../inbox/ConversationThread";
import AiDraftPanel from "../inbox/AiDraftPanel";
import type { OpenClawConversation, OpenClawMessage } from "@/lib/openclaw-zalo/types";

const conversation = (
  id: string,
  unread = 0,
  overrides: Partial<OpenClawConversation> = {},
): OpenClawConversation => ({
  conversationId: id,
  targetId: `khach-${id}`,
  status: "OPEN",
  assignedMembershipId: null,
  unreadCount: unread,
  lastReceivedAt: "2026-08-03T10:00:00.000Z",
  lastMessageId: null,
  version: 1,
  targetKind: "PEER",
  displayName: null,
  lastMessagePreview: null,
  ...overrides,
});

const message = (
  id: string,
  receivedAt: string,
  overrides: Partial<OpenClawMessage> = {},
): OpenClawMessage => ({
  messageId: id,
  direction: "INBOUND",
  eventKind: "TEXT",
  providerTimestamp: null,
  receivedAt,
  createdAt: receivedAt,
  textContent: null,
  providerSenderId: null,
  senderName: null,
  providerEventType: null,
  media: [],
  ...overrides,
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
    effectiveMode: "MANUAL_SEND" as const,
    takeoverByAnotherMember: false,
  },
  selectedDraftId: "d1",
  sending: false,
  canManageHandoff: true,
  isAssignedToViewer: false,
  takeover: null,
  lastSendState: null,
  onSelectConversation: noop,
  onLoadMoreConversations: noop,
  onSelectDraft: noop,
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

  it("renders what was said and who said it", () => {
    // The inbox exists to be read. Both fields come from openclaw_list_messages_v1;
    // before it returned them this screen was a column of "KHÁCH GỬI · MESSAGE".
    const html = render(createElement(ConversationThread, {
      messages: [
        message("m1", "2026-08-03T10:00:01.000Z", {
          textContent: "Còn phòng trống không anh?",
          senderName: "Nguyễn Hữu Chinh",
        }),
      ],
      loading: false, mediaUnavailable: false,
    }));
    expect(html).toContain("Còn phòng trống không anh?");
    expect(html).toContain("Nguyễn Hữu Chinh");
  });

  it("puts outbound on the right without a sender name, inbound on the left with one", () => {
    const html = render(createElement(ConversationThread, {
      messages: [
        message("m1", "2026-08-03T10:00:01.000Z", { textContent: "Chào shop", senderName: "Hiển" }),
        message("m2", "2026-08-03T10:00:02.000Z", {
          direction: "OUTBOUND", textContent: "Dạ còn ạ", senderName: null,
        }),
      ],
      loading: false, mediaUnavailable: false,
    }));
    expect(html).toContain("flex-row-reverse");
    expect(html).toContain('data-openclaw-sender="m1"');
    expect(html).not.toContain('data-openclaw-sender="m2"');
  });

  it("shows a photo as a photo, and never leaks the CRM page to Zalo", () => {
    const url = "https://photo-stal-21.zdn.vn/gr/jpg/1d70/abc.jpg";
    const html = render(createElement(ConversationThread, {
      messages: [
        message("m1", "2026-08-03T10:00:01.000Z", {
          // Zalo puts the CDN link in the body of a photo message.
          textContent: url,
          senderName: "Huy",
          providerEventType: "chat.photo",
          media: [{ kind: "image", url, thumb: url, title: null }],
        }),
      ],
      loading: false, mediaUnavailable: false,
    }));
    expect(html).toContain('data-openclaw-media-kind="image"');
    // Without this Zalo learns which CRM page the viewer had open.
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    // The URL is already the picture; printing it as text too is noise.
    expect(html).not.toContain(`break-words">${url}`);
  });

  it("plays a video inline with a poster and fetches only metadata up front", () => {
    const html = render(createElement(ConversationThread, {
      messages: [
        message("m1", "2026-08-03T10:00:01.000Z", {
          senderName: "Nguyễn Trúc Ly",
          providerEventType: "chat.video.msg",
          media: [{
            kind: "video",
            url: "https://video.zdn.vn/v/clip.mp4",
            thumb: "https://photo.zdn.vn/poster.jpg",
            title: null,
          }],
        }),
      ],
      loading: false, mediaUnavailable: false,
    }));
    expect(html).toContain('data-openclaw-media-kind="video"');
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('poster="https://photo.zdn.vn/poster.jpg"');
  });

  it("renders a voice message as audio that does not preload", () => {
    const html = render(createElement(ConversationThread, {
      messages: [
        message("m1", "2026-08-03T10:00:01.000Z", {
          providerEventType: "chat.voice",
          media: [{ kind: "audio", url: "https://voice.zdn.vn/a.aac", thumb: null, title: null }],
        }),
      ],
      loading: false, mediaUnavailable: false,
    }));
    expect(html).toContain('data-openclaw-media-kind="audio"');
    expect(html).toContain('preload="none"');
  });

  it("falls back to the sender id when the name is not known yet", () => {
    const html = render(createElement(ConversationThread, {
      messages: [
        message("m1", "2026-08-03T10:00:01.000Z", {
          textContent: "xin chào", senderName: null, providerSenderId: "4707896128788663158",
        }),
      ],
      loading: false, mediaUnavailable: false,
    }));
    expect(html).toContain("4707896128788663158");
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
    const html = render(createElement(AiDraftPanel, {
      drafts: [draft], loading: false, selectedDraftId: null, onSelectDraft: noop,
    }));
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
      loading: false, selectedDraftId: null, onSelectDraft: noop,
    }));
    expect(html).toContain('data-openclaw-draft-withheld="d1"');
    expect(html).not.toContain("Chào anh chị");
    // The count still tells a reviewer the draft was grounded; the contents do not
    // ship, because citations is free-form jsonb that could carry source excerpts.
    expect(html).toContain("1 trích dẫn");
    expect(html).toContain("nội dung được giữ lại");
    expect(html).not.toContain("knowledgeId");
  });

  it("offers selection only on a draft the send RPC would accept", () => {
    // openclaw_create_send_intent_v1 refuses any draft whose dlp_decision is not
    // PASS with an indistinguishable P0002, so offering the choice on a blocked
    // draft would only produce a confusing failure.
    const passed = render(createElement(AiDraftPanel, {
      drafts: [draft], loading: false, selectedDraftId: null, onSelectDraft: noop,
    }));
    expect(passed).toContain('data-openclaw-action="select-draft"');

    const blocked = render(createElement(AiDraftPanel, {
      drafts: [{ ...draft, dlpDecision: "BLOCK" as const, draftText: null, citations: null }],
      loading: false, selectedDraftId: null, onSelectDraft: noop,
    }));
    expect(blocked).not.toContain('data-openclaw-action="select-draft"');
  });

  it("never sends from the panel itself", () => {
    // Selecting is not sending. The confirmation lives outside this component so
    // that "I looked at a draft" is never one click from "a customer got a message".
    const html = render(createElement(AiDraftPanel, {
      drafts: [draft], loading: false, selectedDraftId: "d1", onSelectDraft: noop,
    }));
    expect(html).not.toContain("confirm-send");
    expect(html).toContain("Chọn bản nháp không gửi nó đi");
  });
});

describe("manual send", () => {
  it("offers the confirmation only when every gate is open", () => {
    const html = render(createElement(OpenClawInbox, inboxProps));
    expect(html).toContain('data-openclaw-action="confirm-send"');
  });

  it("replaces the control with a refusal the browser can actually prove", () => {
    const html = render(createElement(OpenClawInbox, {
      ...inboxProps,
      sendGate: { ...inboxProps.sendGate, effectiveMode: "DRAFT_ONLY" as const },
    }));
    expect(html).not.toContain('data-openclaw-action="confirm-send"');
    expect(html).toContain('data-openclaw-send-blocked="DRAFT_ONLY_MODE"');
  });

  it("does not pretend to know the policy reasons it cannot see", () => {
    // Quiet hours, consent, suppression, rate limits and group staleness are all
    // decided server-side against statement_timestamp(). A preview claiming ALLOWED
    // at 02:00 inside a quiet-hours window is worse than saying nothing.
    const html = render(createElement(OpenClawInbox, inboxProps));
    expect(html).not.toContain("data-openclaw-policy-reason");
    expect(html).toContain("do máy chủ");
    expect(html).toContain("chưa phải");
  });

  it("will not send without a chosen draft", () => {
    // openclaw_create_send_intent_v1 derives the target FROM the draft, so there is
    // no such thing as sending without one.
    const html = render(createElement(OpenClawInbox, {
      ...inboxProps, selectedDraftId: null,
    }));
    const button = html.match(/<button[^>]*data-openclaw-action="confirm-send"[^>]*>/u);
    expect(button).not.toBeNull();
    expect(button![0]).toContain('disabled=""');
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
      isAssignedToViewer: false,
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
        ownerMembershipId: "m2",
        expiresAt: "2026-08-03T11:00:00.000Z", heldByCurrentMember: false,
      },
    }));
    expect(html).toContain('data-openclaw-takeover="other"');
    // A member cannot read the roster, so the name is genuinely unavailable rather
    // than a lookup this code skipped.
    expect(html).toContain("Thành viên khác đang tiếp quản");
    expect(html).toContain('data-openclaw-send-blocked="TAKEOVER_HELD"');
    expect(html).toContain("Trả lời tự động bị tạm dừng");
  });

  it("offers release rather than start once this member holds it", () => {
    const html = render(createElement(OpenClawInbox, {
      ...inboxProps,
      takeover: {
        ownerMembershipId: "m1",
        expiresAt: "2026-08-03T11:00:00.000Z", heldByCurrentMember: true,
      },
    }));
    expect(html).toContain('data-openclaw-action="release-takeover"');
    expect(html).not.toContain('data-openclaw-action="start-takeover"');
  });
});
