import { UNKNOWN_OUTCOMES, unknownBadges } from "@/lib/openclaw-zalo/operations";
import type { OpenClawUnknownResolutionOutcome } from "@/lib/openclaw-zalo/types";

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
  /** Set once the server reports someone else resolved this first. */
  winner: UnknownResolutionWinner | null;
  busy: boolean;
  onSelectOutcome: (outcome: OpenClawUnknownResolutionOutcome) => void;
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
          <fieldset className="mt-4 grid gap-2" disabled={!props.canManageOperations}>
            <legend className="sr-only">Kết luận</legend>
            {UNKNOWN_OUTCOMES.map(item => (
              <button
                key={item.outcome}
                type="button"
                onClick={() => props.onSelectOutcome(item.outcome)}
                aria-pressed={props.selectedOutcome === item.outcome}
                data-openclaw-unknown-outcome={item.outcome}
                className={`border px-3 py-2 text-left text-sm ${
                  props.selectedOutcome === item.outcome
                    ? "border-[#0f766e] bg-[#dfeee9]"
                    : "border-[#cbd5df] bg-white"
                }`}
              >
                <span className="font-bold">{item.label}</span>
                <span className="mt-1 block text-xs leading-5 text-[#607585]">{item.detail}</span>
              </button>
            ))}
          </fieldset>
        )}

        {!props.canManageOperations && (
          <p data-openclaw-unknown-blocked="PERMISSION" className="mt-3 text-sm font-bold text-[#8a4b12]">
            Bạn không có quyền vận hành để đối chiếu.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {props.winner === null && (
            <button
              type="button"
              onClick={props.onConfirm}
              disabled={!props.canManageOperations || props.selectedOutcome === null || props.busy}
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
