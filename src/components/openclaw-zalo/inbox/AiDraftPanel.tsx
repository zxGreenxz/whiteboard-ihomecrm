export interface OpenClawAiDraftView {
  draftId: string;
  draftVersion: number;
  humanEditVersion: number;
  dlpDecision: "PASS" | "BLOCK" | "REVIEW";
  publicationState: "REVIEW_ONLY" | "APPROVED" | "REJECTED" | "PUBLISHED";
  citations: unknown[];
  knowledgeVersionIds: string[];
  createdAt: string;
  /** Null unless DLP passed. The SERVER withholds it; this is not a UI redaction. */
  draftText: string | null;
}

interface AiDraftPanelProps {
  drafts: readonly OpenClawAiDraftView[];
  loading: boolean;
}

const DLP_COPY = {
  PASS: "DLP cho phép",
  REVIEW: "DLP yêu cầu người xem lại",
  BLOCK: "DLP chặn",
} as const;

/**
 * Review-only. This panel has no send button by design.
 *
 * A draft becomes an outgoing message only through a separately enabled automation
 * path that creates a send intent under the current policy; nothing here writes.
 */
export default function AiDraftPanel({ drafts, loading }: AiDraftPanelProps) {
  if (loading && drafts.length === 0) {
    return (
      <p data-openclaw-draft="loading" className="p-4 text-sm text-[#607585]">
        Đang tải bản nháp…
      </p>
    );
  }

  if (drafts.length === 0) {
    return (
      <p data-openclaw-draft="empty" className="p-4 text-sm text-[#607585]">
        Chưa có bản nháp AI cho hội thoại này.
      </p>
    );
  }

  return (
    <div data-openclaw-draft="list" className="grid gap-3 p-4">
      {drafts.map(draft => (
        <article
          key={draft.draftId}
          data-openclaw-draft-id={draft.draftId}
          className="border border-[#cbd5df] bg-white p-3"
        >
          <header className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">
              Bản {draft.draftVersion}
            </span>
            <span
              data-openclaw-draft-dlp={draft.dlpDecision}
              className={`border px-2 text-xs font-bold ${
                draft.dlpDecision === "PASS"
                  ? "border-[#0f766e] text-[#0f766e]"
                  : "border-[#b3541e] text-[#8a4b12]"
              }`}
            >
              {DLP_COPY[draft.dlpDecision]}
            </span>
            <span className="border border-[#9fb0bf] px-2 text-xs font-bold text-[#526777]">
              {draft.publicationState}
            </span>
          </header>

          {draft.draftText === null ? (
            <p
              data-openclaw-draft-withheld={draft.draftId}
              className="mt-2 border border-[#d99a6c] bg-[#fdf0e4] p-2 text-sm font-bold text-[#8a4b12]"
            >
              Nội dung được máy chủ giữ lại vì DLP chưa cho phép. Không có bản sao nào ở trình duyệt.
            </p>
          ) : (
            <p data-openclaw-draft-text={draft.draftId} className="mt-2 whitespace-pre-wrap text-sm leading-6">
              {draft.draftText}
            </p>
          )}

          <footer className="mt-2 text-xs leading-5 text-[#607585]">
            <span data-openclaw-draft-citations={draft.draftId}>
              {draft.citations.length} trích dẫn
            </span>
            {" · "}
            <span>{draft.knowledgeVersionIds.length} phiên bản tri thức</span>
            {draft.humanEditVersion > 0 && <> · đã chỉnh tay lần {draft.humanEditVersion}</>}
          </footer>
        </article>
      ))}
      <p className="text-xs leading-5 text-[#607585]">
        Bản nháp chỉ để xem lại. Việc gửi đi phải đi qua đường automation được bật riêng.
      </p>
    </div>
  );
}
