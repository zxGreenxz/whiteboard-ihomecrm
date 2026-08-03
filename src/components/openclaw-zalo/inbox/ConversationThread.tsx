import { threadEvents } from "@/lib/openclaw-zalo/inboxView";
import type { OpenClawMessage } from "@/lib/openclaw-zalo/types";

interface ConversationThreadProps {
  messages: readonly OpenClawMessage[];
  loading: boolean;
  /** True when a media object could not be resolved for this thread. */
  mediaUnavailable: boolean;
}

const DIRECTION_LABEL = { INBOUND: "Khách gửi", OUTBOUND: "Đã gửi đi" } as const;

/**
 * The thread shows EVENT METADATA, not message text.
 *
 * `openclaw_list_messages_v1` returns id/direction/eventKind/timestamps and nothing
 * else - message content never reaches the browser through this path. A component
 * that rendered a body would be rendering a field that does not exist.
 */
export default function ConversationThread({
  messages,
  loading,
  mediaUnavailable,
}: ConversationThreadProps) {
  if (loading && messages.length === 0) {
    return (
      <p data-openclaw-thread="loading" className="p-4 text-sm text-[#607585]">
        Đang tải sự kiện…
      </p>
    );
  }

  const ordered = threadEvents(messages);

  return (
    <div data-openclaw-thread="events" className="p-4">
      {mediaUnavailable && (
        <p
          data-openclaw-thread="media-unavailable"
          className="mb-3 border border-[#d99a6c] bg-[#fdf0e4] p-3 text-sm font-bold text-[#8a4b12]"
        >
          Không lấy được tệp đính kèm. Vé đọc chỉ dùng một lần và có thể đã hết hạn.
        </p>
      )}
      {ordered.length === 0 ? (
        <p data-openclaw-thread="empty" className="text-sm text-[#607585]">
          Hội thoại này chưa có sự kiện nào.
        </p>
      ) : (
        <ol className="grid gap-2">
          {ordered.map(event => (
            <li
              key={event.messageId}
              data-openclaw-message={event.messageId}
              className="border border-[#e2e8ee] bg-white p-3"
            >
              <p className="text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">
                {DIRECTION_LABEL[event.direction]} · {event.eventKind}
              </p>
              <p className="mt-1 font-mono text-xs text-[#526777]">{event.receivedAt}</p>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs leading-5 text-[#607585]">
        Chỉ hiển thị siêu dữ liệu sự kiện. Nội dung tin nhắn không rời khỏi máy chủ qua đường này.
      </p>
    </div>
  );
}
