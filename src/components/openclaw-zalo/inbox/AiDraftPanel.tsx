export interface OpenClawAiDraftView {
  draftId: string;
  draftVersion: number;
  humanEditVersion: number;
  dlpDecision: "PASS" | "BLOCK" | "REVIEW";
  publicationState: "REVIEW_ONLY" | "APPROVED" | "REJECTED" | "PUBLISHED";
  citationCount: number;
  /** Null unless DLP passed - free-form jsonb follows the same rule as the text. */
  citations: unknown[] | null;
  knowledgeVersionIds: string[];
  createdAt: string;
  /** Null unless DLP passed. The SERVER withholds it; this is not a UI redaction. */
  draftText: string | null;
}

interface AiDraftPanelProps {
  drafts: readonly OpenClawAiDraftView[];
  loading: boolean;
  selectedDraftId: string | null;
  onSelectDraft: (draftId: string) => void;
}

const DLP_COPY = {
  PASS: "DLP cho phép",
  REVIEW: "DLP yêu cầu người xem lại",
  BLOCK: "DLP chặn",
} as const;

/**
 * The panel never writes. It can mark a draft as the one a later, explicit send
 * action would use, and nothing more - the send itself lives outside this component
 * so that "I looked at a draft" can never be one click away from "a customer got a
 * message".
 */
export default function AiDraftPanel({
  drafts,
  loading,
  selectedDraftId,
  onSelectDraft,
}: AiDraftPanelProps) {
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

          {/* Selecting is not sending: openclaw_create_send_intent_v1 refuses any
              draft whose dlp_decision is not PASS, so offering the choice on a
              blocked draft would only produce an indistinguishable P0002. */}
          {draft.dlpDecision === "PASS" && (
            <button
              type="button"
              onClick={() => onSelectDraft(draft.draftId)}
              aria-pressed={selectedDraftId === draft.draftId}
              data-openclaw-action="select-draft"
              data-openclaw-draft-selected={selectedDraftId === draft.draftId ? "true" : "false"}
              className={`mt-2 min-h-11 w-full border px-3 text-sm font-bold ${
                selectedDraftId === draft.draftId
                  ? "border-[#0f766e] bg-[#dfeee9] text-[#0b5d51]"
                  : "border-[#9fb0bf] bg-white text-[#102a43]"
              }`}
            >
              {selectedDraftId === draft.draftId ? "Đã chọn bản nháp này" : "Chọn bản nháp này"}
            </button>
          )}

          <footer className="mt-2 text-xs leading-5 text-[#607585]">
            <span data-openclaw-draft-citations={draft.draftId}>
              {draft.citationCount} trích dẫn
              {draft.citations === null && " (nội dung được giữ lại)"}
            </span>
            {" · "}
            <span>{draft.knowledgeVersionIds.length} phiên bản tri thức</span>
            {draft.humanEditVersion > 0 && <> · đã chỉnh tay lần {draft.humanEditVersion}</>}
          </footer>
        </article>
      ))}
      <p className="text-xs leading-5 text-[#607585]">
        Chọn bản nháp không gửi nó đi. Việc gửi là một hành động riêng, có xác nhận, và chỉ nhận
        bản nháp đã qua DLP.
      </p>
    </div>
  );
}
