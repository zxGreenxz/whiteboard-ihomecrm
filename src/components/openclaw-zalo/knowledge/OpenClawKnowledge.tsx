import {
  knowledgeActions,
  previewEmptyReason,
  type KnowledgeAction,
  type KnowledgeSourceView,
} from "@/lib/openclaw-zalo/knowledge";

interface OpenClawKnowledgeProps {
  sources: readonly KnowledgeSourceView[];
  loading: boolean;
  canManage: boolean;
  selectedSourceId: string | null;
  /** Chunks the preview returned; see the empty-state note below. */
  previewMatches: readonly { chunkIndex: number; text: string }[];
  previewQuery: string;
  busy: boolean;
  /** What the last action was refused with, already mapped to operator copy. */
  failureMessage: string | null;
  onSelectSource: (sourceId: string) => void;
  onAct: (action: KnowledgeAction, source: KnowledgeSourceView) => void;
  onPreviewQueryChange: (query: string) => void;
}

const SENSITIVITY_COPY = {
  CUSTOMER_SAFE: "Khách xem được",
  INTERNAL_REVIEW_ONLY: "Chỉ nội bộ xem lại",
  RESTRICTED: "Hạn chế",
} as const;

const LIFECYCLE_COPY = {
  DRAFT: "Bản nháp",
  PUBLISHED: "Đã xuất bản",
  ARCHIVED: "Đã lưu trữ",
} as const;

const ACTION_COPY: Record<KnowledgeAction, string> = {
  edit: "Sửa bản nháp",
  validate: "Kiểm tra",
  publish: "Xuất bản",
  archive: "Lưu trữ",
};

const BLOCKED_COPY = {
  PERMISSION: "Cần quyền quản lý tri thức.",
  LIFECYCLE: "Không hợp lệ ở trạng thái hiện tại.",
  NOT_VALIDATED: "Phải kiểm tra bản nháp trước khi xuất bản.",
} as const;

const PREVIEW_EMPTY_COPY = {
  NO_CHUNKS_INGESTED:
    "Chưa có đoạn tri thức nào được nạp vào chỉ mục tìm kiếm. Đây là hạn chế của hệ "
    + "thống hiện tại, không phải do từ khoá bạn nhập.",
  NOT_PUBLISHED: "Nguồn này chưa có bản xuất bản nào để tìm trong đó.",
} as const;

export default function OpenClawKnowledge(props: OpenClawKnowledgeProps) {
  if (!props.canManage) {
    return (
      <p data-openclaw-knowledge="no-permission" className="p-4 text-sm font-bold text-[#8a4b12]">
        Bạn không có quyền quản lý tri thức cho tổ chức này.
      </p>
    );
  }

  if (props.loading && props.sources.length === 0) {
    return (
      <p data-openclaw-knowledge="loading" className="p-4 text-sm text-[#607585]">
        Đang tải nguồn tri thức…
      </p>
    );
  }

  const selected = props.sources.find(item => item.sourceId === props.selectedSourceId) ?? null;

  return (
    <div className="grid gap-0 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <aside data-openclaw-knowledge="sources" className="border-b border-[#cbd5df] md:border-b-0 md:border-r">
        {props.sources.length === 0 ? (
          <p data-openclaw-knowledge="empty" className="p-4 text-sm text-[#607585]">
            Chưa có nguồn tri thức nào.
          </p>
        ) : (
          <ul>
            {props.sources.map(source => (
              <li key={source.sourceId}>
                <button
                  type="button"
                  onClick={() => props.onSelectSource(source.sourceId)}
                  aria-current={source.sourceId === props.selectedSourceId ? "true" : undefined}
                  data-openclaw-source={source.sourceId}
                  className={`w-full border-b border-[#e2e8ee] px-4 py-3 text-left text-sm ${
                    source.sourceId === props.selectedSourceId ? "bg-[#dfeee9] font-bold" : "bg-white"
                  }`}
                >
                  <span className="block truncate">{source.title}</span>
                  <span className="mt-1 flex flex-wrap gap-1 text-xs">
                    <span
                      data-openclaw-sensitivity={source.sensitivity}
                      className="border border-[#9fb0bf] px-1 text-[#526777]"
                    >
                      {SENSITIVITY_COPY[source.sensitivity]}
                    </span>
                    <span
                      data-openclaw-lifecycle={source.lifecycleState}
                      className="border border-[#9fb0bf] px-1 text-[#526777]"
                    >
                      {LIFECYCLE_COPY[source.lifecycleState]}
                    </span>
                    <span className="text-[#607585]">v{source.currentVersion}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="min-w-0 p-4">
        {selected === null ? (
          <p data-openclaw-knowledge="no-selection" className="text-sm text-[#607585]">
            Chọn một nguồn để xem trạng thái và thao tác.
          </p>
        ) : (
          <>
            <h2 className="text-lg font-black tracking-[-0.02em]">{selected.title}</h2>
            <p className="mt-1 text-xs leading-5 text-[#607585]">
              {selected.sourceKind} · {SENSITIVITY_COPY[selected.sensitivity]} ·{" "}
              {LIFECYCLE_COPY[selected.lifecycleState]} · phiên bản {selected.currentVersion}
            </p>

            {/* No RPC returns version CONTENT - only its hash - so an edit form has
                nothing to prefill. Saying so beats an empty textarea that looks like
                the source is empty. */}
            <p
              data-openclaw-knowledge="content-unavailable"
              className="mt-3 border border-[#cbd5df] bg-white p-3 text-sm leading-6 text-[#526777]"
            >
              Nội dung bản nháp không đọc lại được từ máy chủ; chỉ có mã băm{" "}
              <span className="font-mono text-xs">{selected.contentHash ?? "—"}</span>. Muốn sửa thì
              phải dán lại toàn bộ nội dung, và mã băm sẽ cho biết bản mới có khác bản cũ không.
            </p>

            <p className="mt-3 text-xs leading-5 text-[#607585]">
              Mức nhạy cảm được đặt một lần lúc tạo và không có thao tác nào đổi được. Muốn đưa một
              nội dung nội bộ thành nội dung khách xem được thì phải tạo nguồn mới.
            </p>

            {props.failureMessage !== null && (
              <p
                data-openclaw-knowledge="failure"
                className="mt-3 border border-[#c0563a] bg-[#fdeceb] p-3 text-sm font-bold text-[#8a2f1c]"
              >
                {props.failureMessage}
              </p>
            )}

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {(Object.keys(ACTION_COPY) as KnowledgeAction[]).map(action => {
                const state = knowledgeActions({
                  canManage: props.canManage,
                  lifecycleState: selected.lifecycleState,
                  hasValidationResult: selected.validationResult != null,
                })[action];
                return (
                  <div key={action}>
                    <button
                      type="button"
                      onClick={() => props.onAct(action, selected)}
                      // Edit has no compose flow yet, so it is disabled rather than
                      // wired to a handler that silently does nothing.
                      disabled={!state.enabled || props.busy || action === "edit"}
                      data-openclaw-action={`knowledge-${action}`}
                      className="min-h-11 w-full border border-[#0f766e] bg-white px-3 text-sm font-bold text-[#0b5d51] disabled:cursor-not-allowed disabled:border-[#9fb0bf] disabled:text-[#8695a2]"
                    >
                      {ACTION_COPY[action]}
                    </button>
                    {action === "edit" && state.blockedBy === null && (
                      <p
                        data-openclaw-knowledge-blocked="edit:NO_COMPOSE_FLOW"
                        className="mt-1 text-xs leading-5 text-[#8a4b12]"
                      >
                        Chưa sửa được từ đây: nội dung cũ không đọc lại được nên cần một màn
                        hình soạn thảo riêng.
                      </p>
                    )}
                    {state.blockedBy !== null && (
                      <p
                        data-openclaw-knowledge-blocked={`${action}:${state.blockedBy}`}
                        className="mt-1 text-xs leading-5 text-[#8a4b12]"
                      >
                        {BLOCKED_COPY[state.blockedBy]}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-6 border-t border-[#cbd5df] pt-4">
              <label className="block text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">
                Thử tìm trong tri thức
              </label>
              <input
                type="text"
                value={props.previewQuery}
                onChange={event => props.onPreviewQueryChange(event.target.value)}
                data-openclaw-knowledge="preview-query"
                className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm"
                placeholder="Nhập cụm từ có trong nội dung"
              />
              {/* "Contains", not "relevance": the server does an ILIKE substring match
                  ordered by chunk index. A relevance score column would be invented. */}
              <p className="mt-1 text-xs leading-5 text-[#607585]">
                Tìm theo cụm từ chứa trong nội dung, sắp theo thứ tự đoạn — không phải theo độ liên quan.
              </p>

              {props.previewMatches.length > 0 ? (
                <ol data-openclaw-knowledge="preview-matches" className="mt-3 grid gap-2">
                  {props.previewMatches.map(match => (
                    <li key={match.chunkIndex} className="border border-[#e2e8ee] bg-white p-2 text-sm">
                      <span className="text-xs font-bold text-[#607585]">Đoạn {match.chunkIndex}</span>
                      <p className="mt-1 leading-6">{match.text}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p
                  data-openclaw-knowledge-preview-empty={previewEmptyReason({
                    hasPublishedVersion: selected.lifecycleState === "PUBLISHED",
                    matchCount: 0,
                  }) ?? undefined}
                  className="mt-3 border border-[#cbd5df] bg-white p-3 text-sm leading-6 text-[#526777]"
                >
                  {PREVIEW_EMPTY_COPY[previewEmptyReason({
                    hasPublishedVersion: selected.lifecycleState === "PUBLISHED",
                    matchCount: 0,
                  }) ?? "NOT_PUBLISHED"]}
                </p>
              )}

              {/* The RPC hardcodes chunk.sensitivity = 'CUSTOMER_SAFE' and omits the
                  key from its payload, so the browser cannot badge results, offer an
                  "include internal" toggle, or count what was hidden. */}
              <p className="mt-2 text-xs leading-5 text-[#607585]">
                Kết quả chỉ gồm đoạn ở mức khách xem được. Máy chủ lọc sẵn và không trả về mức nhạy
                cảm của từng đoạn, nên ở đây không thể hiện được đã ẩn bao nhiêu đoạn nội bộ.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
