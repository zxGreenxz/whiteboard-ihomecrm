import { threadEvents } from "@/lib/openclaw-zalo/inboxView";
import type { OpenClawMessage } from "@/lib/openclaw-zalo/types";

interface ConversationThreadProps {
  messages: readonly OpenClawMessage[];
  loading: boolean;
  /** True when a media object could not be resolved for this thread. */
  mediaUnavailable: boolean;
}

/** Zalo sends photos as a bare CDN link in the message body. */
const MEDIA_LINK = /^https:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?$/iu;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const last = parts.at(-1) ?? "";
  return last.slice(0, 1).toUpperCase() || "?";
}

function clockTime(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * The thread reads like a chat: who spoke, what they said, when.
 *
 * Inbound sits left, outbound right, the way every messenger renders it. Photos
 * arrive as a bare CDN link in `textContent`, so a link that is only an image URL
 * is shown as a link rather than pasted as a wall of query string - the bytes
 * live behind the media gateway, which this screen does not fetch.
 */
export default function ConversationThread({
  messages,
  loading,
  mediaUnavailable,
}: ConversationThreadProps) {
  if (loading && messages.length === 0) {
    return (
      <p data-openclaw-thread="loading" className="p-4 text-sm text-[#607585]">
        Đang tải tin nhắn…
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
          Hội thoại này chưa có tin nhắn nào.
        </p>
      ) : (
        <ol className="grid gap-3">
          {ordered.map(event => {
            const outbound = event.direction === "OUTBOUND";
            const text = event.textContent?.trim() ?? "";
            const isMediaLink = MEDIA_LINK.test(text);
            const speaker = event.senderName ?? event.providerSenderId ?? "Không rõ";
            return (
              <li
                key={event.messageId}
                data-openclaw-message={event.messageId}
                className={`flex gap-2 ${outbound ? "flex-row-reverse" : "flex-row"}`}
              >
                {!outbound && (
                  <span
                    aria-hidden="true"
                    className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#dfeee9] text-xs font-extrabold text-[#0f766e]"
                  >
                    {initials(speaker)}
                  </span>
                )}
                <div className={`min-w-0 max-w-[min(42rem,80%)] ${outbound ? "text-right" : ""}`}>
                  {!outbound && (
                    <p
                      data-openclaw-sender={event.messageId}
                      className="mb-0.5 truncate text-xs font-bold text-[#526777]"
                    >
                      {speaker}
                    </p>
                  )}
                  <div
                    className={`inline-block rounded-2xl px-3 py-2 text-left text-sm leading-6 ${
                      outbound
                        ? "rounded-br-sm bg-[#0f766e] text-white"
                        : "rounded-bl-sm border border-[#e2e8ee] bg-white text-[#12222e]"
                    }`}
                  >
                    {text.length === 0 ? (
                      <span className="italic opacity-70">[{event.eventKind}]</span>
                    ) : isMediaLink ? (
                      <a
                        href={text}
                        target="_blank"
                        rel="noreferrer"
                        className={`underline ${outbound ? "text-white" : "text-[#0f766e]"}`}
                      >
                        Ảnh đính kèm
                      </a>
                    ) : (
                      <span className="whitespace-pre-wrap break-words">{text}</span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-[#8296a5]">
                    {clockTime(event.receivedAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
