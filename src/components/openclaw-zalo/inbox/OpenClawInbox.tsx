import { manualSendGate, sendLifecycle } from "@/lib/openclaw-zalo/inboxView";
import type { ManualSendGateInput } from "@/lib/openclaw-zalo/inboxView";
import type { OpenClawConversation, OpenClawMessage, OpenClawOutboxState } from "@/lib/openclaw-zalo/types";
import AiDraftPanel, { type OpenClawAiDraftView } from "./AiDraftPanel";
import ConversationList from "./ConversationList";
import ConversationThread from "./ConversationThread";

export interface OpenClawTakeoverView {
  ownerMembershipId: string;
  ownerName: string;
  expiresAt: string;
  heldByCurrentMember: boolean;
}

interface OpenClawInboxProps {
  conversations: readonly OpenClawConversation[];
  selectedConversationId: string | null;
  conversationsLoading: boolean;
  conversationsHasMore: boolean;
  messages: readonly OpenClawMessage[];
  messagesLoading: boolean;
  mediaUnavailable: boolean;
  drafts: readonly OpenClawAiDraftView[];
  draftsLoading: boolean;
  sendGate: ManualSendGateInput;
  canManageHandoff: boolean;
  takeover: OpenClawTakeoverView | null;
  /** The last observed state of a message this operator sent, if any. */
  lastSendState: OpenClawOutboxState | null;
  onSelectConversation: (conversationId: string) => void;
  onLoadMoreConversations: () => void;
  onConfirmSend: () => void;
  onStartTakeover: () => void;
  onReleaseTakeover: () => void;
}

const SEND_BLOCK_COPY = {
  PERMISSION: "Bạn không có quyền gửi tin.",
  NOT_CONNECTED: "Tài khoản chưa kết nối, không thể gửi.",
  TAKEOVER_HELD: "Thành viên khác đang giữ quyền tiếp quản hội thoại này.",
  POLICY: "Chính sách hiện hành không cho gửi.",
} as const;

export default function OpenClawInbox(props: OpenClawInboxProps) {
  const gate = manualSendGate(props.sendGate);
  const lifecycle = props.lastSendState === null ? null : sendLifecycle(props.lastSendState);

  return (
    <div className="grid gap-0 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <aside className="border-b border-[#cbd5df] md:border-b-0 md:border-r">
        <ConversationList
          conversations={props.conversations}
          selectedConversationId={props.selectedConversationId}
          hasMore={props.conversationsHasMore}
          loading={props.conversationsLoading}
          onSelect={props.onSelectConversation}
          onLoadMore={props.onLoadMoreConversations}
        />
      </aside>

      <section className="min-w-0">
        {props.selectedConversationId === null ? (
          <p data-openclaw-inbox="no-selection" className="p-4 text-sm text-[#607585]">
            Chọn một hội thoại để xem sự kiện và bản nháp.
          </p>
        ) : (
          <>
            {props.takeover !== null && (
              <div
                data-openclaw-takeover={props.takeover.heldByCurrentMember ? "mine" : "other"}
                className="border-b border-[#cbd5df] bg-[#f4f8f7] p-3 text-sm"
              >
                <p className="font-bold">
                  {props.takeover.heldByCurrentMember
                    ? "Bạn đang tiếp quản hội thoại này"
                    : `${props.takeover.ownerName} đang tiếp quản hội thoại này`}
                </p>
                <p className="mt-1 text-xs leading-5 text-[#607585]">
                  Hết hạn: {props.takeover.expiresAt}. Trả lời tự động bị tạm dừng cho tới khi nhả quyền.
                </p>
              </div>
            )}

            <ConversationThread
              messages={props.messages}
              loading={props.messagesLoading}
              mediaUnavailable={props.mediaUnavailable}
            />

            <AiDraftPanel drafts={props.drafts} loading={props.draftsLoading} />

            <div className="border-t border-[#cbd5df] p-4">
              {lifecycle !== null && (
                <p
                  data-openclaw-send-state={props.lastSendState ?? undefined}
                  data-openclaw-send-delivered={String(lifecycle.delivered)}
                  className="mb-3 border border-[#cbd5df] bg-white p-3 text-sm font-bold"
                >
                  {lifecycle.label}
                  {lifecycle.needsResolution && (
                    <span className="mt-1 block text-xs font-normal leading-5 text-[#8a4b12]">
                      Chưa rõ tin đã tới khách hay chưa. Đối chiếu ở mục Vận hành trước khi gửi lại,
                      gửi lại ngay có thể làm khách nhận hai lần.
                    </span>
                  )}
                </p>
              )}

              {gate.blockedBy !== null ? (
                <p
                  data-openclaw-send-blocked={gate.blockedBy}
                  className="border border-[#d99a6c] bg-[#fdf0e4] p-3 text-sm font-bold text-[#8a4b12]"
                >
                  {SEND_BLOCK_COPY[gate.blockedBy]}
                  {gate.policyReason !== null && (
                    <span data-openclaw-policy-reason={gate.policyReason} className="mt-1 block text-xs font-normal">
                      Lý do chính sách: {gate.policyReason}
                    </span>
                  )}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={props.onConfirmSend}
                  data-openclaw-action="confirm-send"
                  className="min-h-11 w-full border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-bold text-white"
                >
                  Xác nhận gửi thủ công
                </button>
              )}

              {props.canManageHandoff && (
                <button
                  type="button"
                  onClick={props.takeover?.heldByCurrentMember ? props.onReleaseTakeover : props.onStartTakeover}
                  data-openclaw-action={props.takeover?.heldByCurrentMember ? "release-takeover" : "start-takeover"}
                  className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-4 text-sm font-bold text-[#102a43]"
                >
                  {props.takeover?.heldByCurrentMember ? "Nhả quyền tiếp quản" : "Tiếp quản hội thoại"}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
