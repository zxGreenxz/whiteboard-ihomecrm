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
                className={`flex min-h-11 w-full items-center justify-between gap-2 border-b border-[#e2e8ee] px-4 py-3 text-left text-sm ${
                  selected ? "bg-[#dfeee9] font-bold" : "bg-white"
                }`}
              >
                <span className="min-w-0 truncate">{conversation.targetId}</span>
                {conversation.unreadCount > 0 && (
                  <span
                    data-openclaw-unread={conversation.conversationId}
                    className="shrink-0 border border-[#0f766e] px-2 text-xs font-extrabold text-[#0f766e]"
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
