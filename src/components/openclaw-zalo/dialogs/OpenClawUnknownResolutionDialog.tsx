import {
  MIN_OBSERVATION_LENGTH,
  UNAVAILABLE_UNKNOWN_OUTCOMES,
  UNKNOWN_OUTCOMES,
  unknownBadges,
  unknownResolutionGate,
} from "@/lib/openclaw-zalo/operations";
import type { OpenClawUnknownResolutionOutcome } from "@/lib/openclaw-zalo/types";

const BLOCK_COPY: Record<string, string> = {
  PERMISSION: "Bạn không có quyền vận hành để đối chiếu.",
  ALREADY_RESOLVED: "Tin này đã được đối chiếu rồi.",
  AUTHORITY_LOADING: "Đang đọc bằng chứng của tin này…",
  AUTHORITY_UNAVAILABLE:
    "Không còn bằng chứng để đối chiếu — tin này đã được xử lý, hoặc không còn ở trạng thái không xác định.",
  AUTHORITY_ERROR:
    "Chưa đọc được bằng chứng của tin này, nên chưa ghi nhận được. Thử mở lại sau.",
  OUTCOME: "Chọn một kết luận ở trên.",
  OUTCOME_UNAVAILABLE: "Kết luận này chưa dùng được ở đây.",
  OBSERVATION: `Ghi lại điều bạn thấy, ít nhất ${MIN_OBSERVATION_LENGTH} ký tự.`,
};

export interface UnknownResolutionWinner {
  resolutionId: string;
  outcome: OpenClawUnknownResolutionOutcome;
  resolvedAt: string;
  /** Present only when the winning outcome created a replacement send. */
  newOutboxId: string | null;
}

interface OpenClawUnknownResolutionDialogProps {
  open: boolean;
  outboxId: string;
  canManageOperations: boolean;
  selectedOutcome: OpenClawUnknownResolutionOutcome | null;
  /** What the operator says they checked; it is what the evidence hash stands for. */
  observation: string;
  /** Null when the server has no evidence left to offer for this outbox. */
  authorityHash: string | null;
  authorityLoading: boolean;
  authorityError: boolean;
  /** Set once the server reports someone else resolved this first. */
  winner: UnknownResolutionWinner | null;
  busy: boolean;
  /** What the last attempt failed with; silence would leave nothing to act on. */
  failureMessage: string | null;
  onSelectOutcome: (outcome: OpenClawUnknownResolutionOutcome) => void;
  onObservationChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export default function OpenClawUnknownResolutionDialog(
  props: OpenClawUnknownResolutionDialogProps,
) {
  if (!props.open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Đối chiếu tin không xác định"
      data-openclaw-dialog="unknown-resolution"
      className="fixed inset-0 z-50 grid place-items-center bg-[#102a43]/40 p-4"
    >
      <section className="w-full max-w-lg border border-[#aebdc8] bg-[#fffdf8] p-5 sm:p-6">
        <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0f766e]">
          Đối chiếu
        </p>
        <h2 className="mt-1 text-xl font-black tracking-[-0.03em]">Tin không xác định</h2>

        {/* The historical badge stays forever; a resolution ADDS one. Replacing it
            would erase the fact that the outcome was ever in doubt, which is the
            fact an audit needs. */}
        <p className="mt-2 flex flex-wrap gap-1">
          {unknownBadges({ resolutionOutcome: props.winner?.outcome ?? null }).map(badge => (
            <span
              key={badge}
              data-openclaw-unknown-badge={badge}
              className="border border-[#9fb0bf] px-2 text-xs font-bold text-[#526777]"
            >
              {badge}
            </span>
          ))}
        </p>

        <p className="mt-3 text-sm leading-6 text-[#526777]">
          Hệ thống không biết tin này đã tới khách hay chưa. Hãy tự kiểm tra trên điện thoại
          rồi ghi lại điều bạn THẤY — đây là ghi nhận quan sát, không phải lệnh cho hệ thống
          coi như đã gửi.
        </p>

        {props.winner !== null ? (
          <div
            data-openclaw-unknown="winner"
            className="mt-4 border border-[#cbd5df] bg-white p-3 text-sm"
          >
            <p className="font-bold">Người khác đã đối chiếu trước.</p>
            <p className="mt-1 leading-6 text-[#526777]">
              Kết luận được giữ: <strong>{props.winner.outcome}</strong> lúc {props.winner.resolvedAt}.
              Kết luận này là một lần duy nhất và không sửa được.
            </p>
            {props.winner.newOutboxId !== null && (
              <p data-openclaw-unknown="new-outbox" className="mt-1 font-mono text-xs">
                Lần gửi mới: {props.winner.newOutboxId}
              </p>
            )}
          </div>
        ) : (
          <>
            <fieldset className="mt-4 grid gap-2" disabled={!props.canManageOperations}>
              <legend className="sr-only">Kết luận</legend>
              {UNKNOWN_OUTCOMES.map(item => {
                const unavailable = UNAVAILABLE_UNKNOWN_OUTCOMES[
                  item.outcome as keyof typeof UNAVAILABLE_UNKNOWN_OUTCOMES
                ];
                return (
                  <button
                    key={item.outcome}
                    type="button"
                    onClick={() => props.onSelectOutcome(item.outcome)}
                    // Shown disabled rather than hidden: an operator who expected this
                    // choice must learn why it is gone, not hunt for it.
                    disabled={unavailable !== undefined}
                    aria-pressed={props.selectedOutcome === item.outcome}
                    data-openclaw-unknown-outcome={item.outcome}
                    data-openclaw-unknown-outcome-unavailable={unavailable === undefined ? undefined : "true"}
                    className={`border px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                      props.selectedOutcome === item.outcome
                        ? "border-[#0f766e] bg-[#dfeee9]"
                        : "border-[#cbd5df] bg-white"
                    }`}
                  >
                    <span className="font-bold">{item.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[#607585]">
                      {unavailable ?? item.detail}
                    </span>
                  </button>
                );
              })}
            </fieldset>

            <label
              htmlFor="openclaw-unknown-observation"
              className="mt-4 block text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]"
            >
              Bạn đã kiểm tra và thấy gì?
            </label>
            {/* The server stores a hash of this and never recomputes it, so the text
                is the only thing that gives the audit record any meaning. */}
            <textarea
              id="openclaw-unknown-observation"
              value={props.observation}
              onChange={event => props.onObservationChange(event.target.value)}
              disabled={!props.canManageOperations}
              rows={3}
              data-openclaw-unknown="observation"
              placeholder="Ví dụ: mở Zalo trên máy khách lúc 10:05, thấy tin đã tới."
              className="mt-1 w-full border border-[#9fb0bf] bg-white p-2 text-sm"
            />
          </>
        )}

        {(() => {
          const gate = unknownResolutionGate({
            canManageOperations: props.canManageOperations,
            alreadyResolved: props.winner !== null,
            authorityLoading: props.authorityLoading,
            authorityError: props.authorityError,
            authorityHash: props.authorityHash,
            selectedOutcome: props.selectedOutcome,
            observation: props.observation,
          });
          return gate.blockedBy === null || gate.blockedBy === "ALREADY_RESOLVED" ? null : (
            <p
              data-openclaw-unknown-blocked={gate.blockedBy}
              className="mt-3 text-sm font-bold text-[#8a4b12]"
            >
              {BLOCK_COPY[gate.blockedBy]}
            </p>
          );
        })()}

        {props.failureMessage !== null && (
          <p
            data-openclaw-unknown="failure"
            className="mt-3 border border-[#c0563a] bg-[#fdeceb] p-3 text-sm font-bold text-[#8a2f1c]"
          >
            {props.failureMessage}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {props.winner === null && (
            <button
              type="button"
              onClick={props.onConfirm}
              disabled={!unknownResolutionGate({
                canManageOperations: props.canManageOperations,
                alreadyResolved: props.winner !== null,
                authorityLoading: props.authorityLoading,
                authorityError: props.authorityError,
                authorityHash: props.authorityHash,
                selectedOutcome: props.selectedOutcome,
                observation: props.observation,
              }).canRecord || props.busy}
              data-openclaw-action="confirm-unknown-resolution"
              className="min-h-11 flex-1 border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Ghi nhận kết luận
            </button>
          )}
          <button
            type="button"
            onClick={props.onClose}
            data-openclaw-action="close-unknown-resolution"
            className="min-h-11 flex-1 border border-[#9fb0bf] bg-white px-4 text-sm font-bold text-[#102a43]"
          >
            Đóng
          </button>
        </div>

        <p className="mt-2 font-mono text-xs text-[#607585]">outbox {props.outboxId}</p>
      </section>
    </div>
  );
}
