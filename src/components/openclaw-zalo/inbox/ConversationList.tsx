import type { OpenClawConversation } from "@/lib/openclaw-zalo/types";

interface ConversationListProps {
  conversations: readonly OpenClawConversation[];
  selectedConversationId: string | null;
  /** Null when the page just rendered was the last one. */
  hasMore: boolean;
  loading: boolean;
  onSelect: (conversationId: string) => void;
  onLoadMore: () => void;
}

export default function ConversationList({
  conversations,
  selectedConversationId,
  hasMore,
  loading,
  onSelect,
  onLoadMore,
}: ConversationListProps) {
  if (loading && conversations.length === 0) {
    return (
      <p data-openclaw-inbox="conversations-loading" className="p-4 text-sm text-[#607585]">
        Đang tải hội thoại…
      </p>
    );
  }

  if (conversations.length === 0) {
    return (
      <div data-openclaw-inbox="conversations-empty" className="p-4">
        <p className="text-sm font-bold">Chưa có hội thoại nào.</p>
        <p className="mt-1 text-xs leading-5 text-[#607585]">
          Hội thoại xuất hiện khi tài khoản nhận tin nhắn đầu tiên. Không có dữ liệu mẫu.
        </p>
      </div>
    );
  }

  return (
    <div data-openclaw-inbox="conversations">
      <ul>
        {conversations.map(conversation => {
          const selected = conversation.conversationId === selectedConversationId;
          return (
            <li key={conversation.conversationId}>
              <button
                type="button"
                onClick={() => onSelect(conversation.conversationId)}
                aria-current={selected ? "true" : undefined}
                data-openclaw-conversation={conversation.conversationId}
                className={`flex min-h-11 w-full items-start justify-between gap-2 border-b border-[#e2e8ee] px-4 py-3 text-left text-sm ${
                  selected ? "bg-[#dfeee9]" : "bg-white"
                }`}
              >
                <span className="flex min-w-0 flex-col">
                  <span
                    data-openclaw-conversation-name={conversation.conversationId}
                    className={`min-w-0 truncate ${selected ? "font-bold" : "font-semibold"}`}
                  >
                    {/* No invented titles: an unnamed group with no members seen yet keeps its id. */}
                    {conversation.displayName ?? conversation.targetId}
                  </span>
                  {conversation.targetKind === "SALES_GROUP" && (
                    <span className="text-[11px] font-bold uppercase tracking-wide text-[#8296a5]">
                      Nhóm
                    </span>
                  )}
                  {conversation.lastMessagePreview && (
                    <span className="mt-0.5 min-w-0 truncate text-xs text-[#607585]">
                      {conversation.lastMessagePreview}
                    </span>
                  )}
                </span>
                {conversation.unreadCount > 0 && (
                  <span
                    data-openclaw-unread={conversation.conversationId}
                    className="mt-0.5 shrink-0 rounded-full bg-[#0f766e] px-2 py-0.5 text-xs font-extrabold text-white"
                  >
                    {conversation.unreadCount}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          data-openclaw-action="load-more-conversations"
          className="min-h-11 w-full border-t border-[#cbd5df] bg-white px-4 text-sm font-bold text-[#0f766e] disabled:opacity-60"
        >
          {loading ? "Đang tải…" : "Tải thêm"}
        </button>
      )}
    </div>
  );
}
