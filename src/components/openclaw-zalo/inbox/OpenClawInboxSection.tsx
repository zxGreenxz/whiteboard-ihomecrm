import { useMemo, useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import { useOpenClawInbox, useOpenClawMessages } from "@/hooks/openclaw-zalo/useOpenClawInbox";
import type { OpenClawConversationCursor } from "@/hooks/openclaw-zalo/useOpenClawInbox";
import { useOpenClawAiDrafts } from "@/hooks/openclaw-zalo/useOpenClawResources";
import { useOpenClawHandoffMutations } from "@/hooks/openclaw-zalo/useOpenClawMutations";
import { conversationCursorAfter } from "@/lib/openclaw-zalo/inboxView";
import { evaluateSendPolicy } from "@/lib/openclaw-zalo/policy";
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
  // The release RPC needs the takeover id and version, and there is no read RPC that
  // lists takeovers - the only place those values exist is the response to the
  // takeover that created it, so they are held here for exactly as long as it lasts.
  const [takeover, setTakeover] = useState<{
    takeoverId: string; takeoverVersion: number; ownerMembershipId: string; expiresAt: string;
  } | null>(null);

  const conversationsQuery = useOpenClawInbox(
    selectedOrganizationId, accountId, cursor, PAGE_SIZE,
  );
  const messagesQuery = useOpenClawMessages(
    selectedOrganizationId, accountId, selectedConversationId, null, PAGE_SIZE,
  );
  const draftsQuery = useOpenClawAiDrafts(
    selectedOrganizationId, accountId, selectedConversationId,
  );
  const handoff = useOpenClawHandoffMutations(selectedOrganizationId ?? "", accountId ?? "");

  const conversations = conversationsQuery.data?.items ?? [];
  const messages = messagesQuery.data?.items ?? [];

  // The policy the SERVER will apply, evaluated from state the browser already has,
  // so the operator sees the refusal before spending a round trip on it. It is a
  // preview: openclaw_create_send_intent_v1 re-decides authoritatively.
  const policy = useMemo(() => evaluateSendPolicy({
    GLOBAL_STOP: bootstrap.control?.globalStop === true,
    MODE_PAUSED: account !== null && account.configuredMode !== account.effectiveMode,
    ACCOUNT_PAUSED: bootstrap.control?.featureEnabled === false,
  }), [account, bootstrap.control]);

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
      drafts={(draftsQuery.data?.items ?? []).map(item => ({
        draftId: item.draftId,
        draftVersion: item.draftVersion,
        humanEditVersion: item.humanEditVersion,
        dlpDecision: item.dlpDecision,
        publicationState: item.publicationState,
        citations: item.citations,
        knowledgeVersionIds: item.knowledgeVersionIds,
        createdAt: item.createdAt,
        draftText: item.draftText,
      }))}
      draftsLoading={draftsQuery.isLoading}
      sendGate={{
        canSend: can("send"),
        connectionState: account.connectionState,
        policy,
        takeoverByAnotherMember: false,
      }}
      canManageHandoff={can("manage_handoff")}
      takeover={takeover === null ? null : {
        ownerMembershipId: takeover.ownerMembershipId,
        ownerName: "Bạn",
        expiresAt: takeover.expiresAt,
        heldByCurrentMember: true,
      }}
      lastSendState={null}
      onSelectConversation={setSelectedConversationId}
      onLoadMoreConversations={() => setCursor(conversationCursorAfter(conversations))}
      onConfirmSend={() => undefined}
      onStartTakeover={() => {
        const selected = conversations.find(
          item => item.conversationId === selectedConversationId,
        );
        if (!selected) return;
        handoff.takeoverConversation.mutate({
          clientOperationId: crypto.randomUUID(),
          request: {
            version: 1,
            organizationId: selectedOrganizationId,
            conversationId: selected.conversationId,
            // Compare-and-set against the version the operator is looking at: if the
            // conversation moved on, the server refuses rather than silently taking
            // over a state nobody reviewed.
            expectedConversationVersion: selected.version,
            expiresAt: new Date(Date.now() + TAKEOVER_MINUTES * 60_000).toISOString(),
          },
        }, {
          onSuccess: result => setTakeover({
            takeoverId: result.takeoverId,
            takeoverVersion: result.takeoverVersion,
            ownerMembershipId: result.ownerMembershipId,
            expiresAt: result.expiresAt,
          }),
        });
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
        }, { onSuccess: () => setTakeover(null) });
      }}
    />
  );
}
