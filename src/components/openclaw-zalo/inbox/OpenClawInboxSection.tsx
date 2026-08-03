import { useCallback, useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import { useOpenClawInbox, useOpenClawMessages } from "@/hooks/openclaw-zalo/useOpenClawInbox";
import type { OpenClawConversationCursor } from "@/hooks/openclaw-zalo/useOpenClawInbox";
import {
  useOpenClawAiDrafts,
  useOpenClawTakeovers,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import {
  useOpenClawCreateSendIntent,
  useOpenClawHandoffMutations,
} from "@/hooks/openclaw-zalo/useOpenClawMutations";
import { conversationCursorAfter } from "@/lib/openclaw-zalo/inboxView";
import OpenClawBoundaryState from "../OpenClawBoundaryState";
import OpenClawInbox from "./OpenClawInbox";

const PAGE_SIZE = 50;
/** How long a takeover is requested for; the server owns the real expiry. */
const TAKEOVER_MINUTES = 30;

/**
 * Wires the inbox to real data. Kept separate from `OpenClawInbox` so every state
 * that component can be in stays renderable from plain props in a test - the shell
 * has no DOM test environment, so an untestable container around a testable view is
 * the only shape that gets coverage at all.
 */
export default function OpenClawInboxSection() {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const account = bootstrap.account;
  const accountId = account?.accountId ?? null;
  const [cursor, setCursor] = useState<OpenClawConversationCursor | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [sendState, setSendState] = useState<
    { conversationId: string; state: "QUEUED" } | null
  >(null);

  const conversationsQuery = useOpenClawInbox(
    selectedOrganizationId, accountId, cursor, PAGE_SIZE,
  );
  const messagesQuery = useOpenClawMessages(
    selectedOrganizationId, accountId, selectedConversationId, null, PAGE_SIZE,
  );
  const draftsQuery = useOpenClawAiDrafts(
    selectedOrganizationId, accountId, selectedConversationId,
  );
  const takeoversQuery = useOpenClawTakeovers(selectedOrganizationId, accountId);
  const handoff = useOpenClawHandoffMutations(selectedOrganizationId ?? "", accountId ?? "");
  const createSendIntent = useOpenClawCreateSendIntent(
    selectedOrganizationId ?? "", accountId ?? "",
  );

  const conversations = conversationsQuery.data?.items ?? [];
  const messages = messagesQuery.data?.items ?? [];
  const drafts = draftsQuery.data?.items ?? [];
  const selectedConversation = conversations.find(
    item => item.conversationId === selectedConversationId,
  ) ?? null;
  // Read from the server on every poll rather than remembered from the mutation
  // response: an earlier version kept it in component state, which survived a
  // conversation switch (showing B as taken over because A was), vanished on reload
  // leaving a real takeover unreleasable, and could never see another member's.
  const takeover = (takeoversQuery.data?.items ?? []).find(
    item => item.conversationId === selectedConversationId,
  ) ?? null;

  // Switching conversation must not carry the previous one's draft choice: the send
  // RPC derives the TARGET from the draft, so a stale id would aim a real message at
  // the wrong customer.
  const selectConversation = useCallback((conversationId: string) => {
    setSelectedConversationId(conversationId);
    setSelectedDraftId(null);
    setSendState(null);
  }, []);

  if (!account) return <OpenClawBoundaryState state="no-account" compact />;

  if (conversationsQuery.error) {
    return (
      <OpenClawBoundaryState
        state="fatal-error"
        message="Không tải được danh sách hội thoại."
        actionLabel="Thử lại"
        onAction={() => void conversationsQuery.refetch()}
        compact
      />
    );
  }

  return (
    <OpenClawInbox
      conversations={conversations}
      selectedConversationId={selectedConversationId}
      conversationsLoading={conversationsQuery.isLoading}
      // The RPC caps the page, so a full page is the only evidence of more rows.
      conversationsHasMore={conversations.length === PAGE_SIZE}
      messages={messages}
      messagesLoading={messagesQuery.isLoading}
      mediaUnavailable={false}
      drafts={drafts.map(item => ({
        draftId: item.draftId,
        draftVersion: item.draftVersion,
        humanEditVersion: item.humanEditVersion,
        dlpDecision: item.dlpDecision,
        publicationState: item.publicationState,
        citationCount: item.citationCount,
        citations: item.citations,
        knowledgeVersionIds: item.knowledgeVersionIds,
        createdAt: item.createdAt,
        draftText: item.draftText,
      }))}
      draftsLoading={draftsQuery.isLoading}
      sendGate={{
        canSend: can("send"),
        connectionState: account.connectionState,
        effectiveMode: account.effectiveMode,
        takeoverByAnotherMember: takeover !== null && !takeover.heldByViewer,
      }}
      selectedDraftId={selectedDraftId}
      sending={createSendIntent.isPending}
      canManageHandoff={can("manage_handoff")}
      // Assignment is the server's own exemption from manage_handoff, but the
      // browser is never told its membership id, so the only assignment it can
      // prove is one it already holds a takeover for.
      isAssignedToViewer={takeover?.heldByViewer === true}
      takeover={takeover === null ? null : {
        ownerMembershipId: takeover.ownerMembershipId,
        expiresAt: takeover.expiresAt,
        heldByCurrentMember: takeover.heldByViewer,
      }}
      lastSendState={sendState?.conversationId === selectedConversationId
        ? sendState.state
        : null}
      onSelectConversation={selectConversation}
      onLoadMoreConversations={() => setCursor(conversationCursorAfter(conversations))}
      onSelectDraft={setSelectedDraftId}
      onConfirmSend={() => {
        const draft = drafts.find(item => item.draftId === selectedDraftId);
        if (!draft || selectedConversationId === null) return;
        createSendIntent.mutate({
          // One id per confirmation. A retry that reuses it is a replay; a fresh id
          // on retry sends a SECOND real message to a real person.
          clientOperationId: crypto.randomUUID(),
          request: {
            version: 1,
            organizationId: selectedOrganizationId,
            sourceDraftId: draft.draftId,
            // The conversation's target, not the conversation: the outbox addresses
            // a peer or group, and the server cross-checks it against the draft.
            targetId: selectedConversation!.targetId,
            expectedDraftVersion: draft.draftVersion,
            // Required as a KEY even when null; omitting it raises 22023.
            replyToMessageId: null,
          },
        }, {
          // QUEUED is all the server returns and all the browser can ever know:
          // openclaw_outbox has no browser read path, and the realtime allowlist
          // migration actively refuses to publish it. Anything further would be
          // invented, and "SENT" invented is a lie about a real customer.
          onSuccess: () => setSendState({
            conversationId: selectedConversationId,
            state: "QUEUED",
          }),
        });
      }}
      onStartTakeover={() => {
        if (!selectedConversation) return;
        handoff.takeoverConversation.mutate({
          clientOperationId: crypto.randomUUID(),
          request: {
            version: 1,
            organizationId: selectedOrganizationId,
            conversationId: selectedConversation.conversationId,
            // Compare-and-set against the version the operator is looking at: if the
            // conversation moved on, the server refuses rather than silently taking
            // over a state nobody reviewed.
            expectedConversationVersion: selectedConversation.version,
            expiresAt: new Date(Date.now() + TAKEOVER_MINUTES * 60_000).toISOString(),
          },
        }, { onSuccess: () => void takeoversQuery.refetch() });
      }}
      onReleaseTakeover={() => {
        if (takeover === null) return;
        handoff.releaseTakeover.mutate({
          clientOperationId: crypto.randomUUID(),
          request: {
            version: 1,
            organizationId: selectedOrganizationId,
            takeoverId: takeover.takeoverId,
            expectedTakeoverVersion: takeover.takeoverVersion,
          },
        }, { onSuccess: () => void takeoversQuery.refetch() });
      }}
    />
  );
}
