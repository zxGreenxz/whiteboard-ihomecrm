import { manualSendGate, sendLifecycle } from "@/lib/openclaw-zalo/inboxView";
import type { ManualSendGateInput } from "@/lib/openclaw-zalo/inboxView";
import type { OpenClawConversation, OpenClawMessage, OpenClawOutboxState } from "@/lib/openclaw-zalo/types";
import AiDraftPanel, { type OpenClawAiDraftView } from "./AiDraftPanel";
import ConversationList from "./ConversationList";
import ConversationThread from "./ConversationThread";

export interface OpenClawTakeoverView {
  ownerMembershipId: string;
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
  /** Null until the operator picks a DLP-passed draft; sending needs one. */
  selectedDraftId: string | null;
  sending: boolean;
  canManageHandoff: boolean;
  /** True when this member is the conversation's assignee. */
  isAssignedToViewer: boolean;
  takeover: OpenClawTakeoverView | null;
  /** The last observed state of a message this operator sent, if any. */
  lastSendState: OpenClawOutboxState | null;
  onSelectConversation: (conversationId: string) => void;
  onLoadMoreConversations: () => void;
  onSelectDraft: (draftId: string) => void;
  onConfirmSend: () => void;
  onStartTakeover: () => void;
  onReleaseTakeover: () => void;
}

const SEND_BLOCK_COPY = {
  PERMISSION: "Bạn không có quyền gửi tin.",
  NOT_CONNECTED: "Tài khoản chưa kết nối, không thể gửi.",
  DRAFT_ONLY_MODE: "Tài khoản đang ở chế độ chỉ soạn nháp, không gửi được.",
  TAKEOVER_HELD: "Thành viên khác đang giữ quyền tiếp quản hội thoại này.",
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
                    /* A member cannot read the organization roster, so the name is
                       genuinely unavailable to the browser. "Another member" is the
                       honest rendering, not a placeholder for a lookup that failed. */
                    : "Thành viên khác đang tiếp quản hội thoại này"}
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

            <AiDraftPanel
              drafts={props.drafts}
              loading={props.draftsLoading}
              selectedDraftId={props.selectedDraftId}
              onSelectDraft={props.onSelectDraft}
            />

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
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={props.onConfirmSend}
                    disabled={props.sending || props.selectedDraftId === null}
                    data-openclaw-action="confirm-send"
                    className="min-h-11 w-full border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {props.selectedDraftId === null
                      ? "Chọn một bản nháp đã qua DLP để gửi"
                      : "Xác nhận gửi bản nháp này"}
                  </button>
                  {/* The browser cannot see quiet hours, consent, suppression, rate
                      limits or group staleness, and all of them are timed on the
                      server clock. Saying so beats a preview that reports ALLOWED
                      at 02:00 inside a quiet-hours window. */}
                  <p className="mt-2 text-xs leading-5 text-[#607585]">
                    Chính sách gửi (giờ im lặng, đồng ý nhận tin, chặn, giới hạn tần suất) do máy chủ
                    quyết định khi phát tin, không phải ở đây. Bấm gửi là đưa vào hàng đợi, chưa phải
                    đã tới khách.
                  </p>
                </>
              )}

              {/* The takeover writer lets the ASSIGNED active member take over their
                  own conversation without manage_handoff, so gating the button purely
                  on the elevated action hid a control that member is allowed to use. */}
              {(props.canManageHandoff || props.isAssignedToViewer) && (
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
