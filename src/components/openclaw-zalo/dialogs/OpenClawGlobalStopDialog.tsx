import { GLOBAL_STOP_CONFIRMATION, globalStopGate } from "@/lib/openclaw-zalo/operations";

interface OpenClawGlobalStopDialogProps {
  open: boolean;
  organizationName: string;
  canManageOperations: boolean;
  alreadyStopped: boolean;
  typedConfirmation: string;
  busy: boolean;
  /** What the last attempt failed with; silence here would be the worst outcome. */
  failureMessage: string | null;
  onTypedConfirmationChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

const BLOCK_COPY = {
  PERMISSION: "Bạn không có quyền vận hành để dừng toàn bộ.",
  CONFIRMATION: "Gõ đúng câu xác nhận ở trên để bật nút dừng.",
  ALREADY_STOPPED: "Toàn bộ việc gửi của tổ chức này đã đang dừng.",
} as const;

export default function OpenClawGlobalStopDialog(props: OpenClawGlobalStopDialogProps) {
  if (!props.open) return null;
  const gate = globalStopGate({
    canManageOperations: props.canManageOperations,
    typedConfirmation: props.typedConfirmation,
    alreadyStopped: props.alreadyStopped,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Dừng toàn bộ việc gửi"
      data-openclaw-dialog="global-stop"
      className="fixed inset-0 z-50 grid place-items-center bg-[#102a43]/40 p-4"
    >
      <section className="w-full max-w-lg border border-[#c0563a] bg-[#fffdf8] p-5 sm:p-6">
        <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#8a2f1c]">
          Dừng khẩn cấp
        </p>
        {/* The organization is named, not implied: an operator with several
            organizations open must not stop the wrong one from muscle memory. */}
        <h2 className="mt-1 text-xl font-black tracking-[-0.03em]">
          Dừng toàn bộ việc gửi của: {props.organizationName}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#526777]">
          Việc này dừng mọi tin đang chờ gửi của tổ chức, không riêng tài khoản bạn đang xem.
          Tin đã rời hệ thống thì không thu hồi được.
        </p>

        <label className="mt-4 block text-xs font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Gõ đúng câu sau để xác nhận
        </label>
        <p
          data-openclaw-global-stop="phrase"
          className="mt-1 select-all border border-[#cbd5df] bg-white p-2 font-mono text-sm"
        >
          {GLOBAL_STOP_CONFIRMATION}
        </p>
        <input
          type="text"
          value={props.typedConfirmation}
          onChange={event => props.onTypedConfirmationChange(event.target.value)}
          data-openclaw-global-stop="input"
          aria-label="Câu xác nhận"
          className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 font-mono text-sm"
        />

        {gate.blockedBy !== null && (
          <p
            data-openclaw-global-stop-blocked={gate.blockedBy}
            className="mt-3 text-sm font-bold text-[#8a4b12]"
          >
            {BLOCK_COPY[gate.blockedBy]}
          </p>
        )}

        {props.failureMessage !== null && (
          <p
            data-openclaw-global-stop="failure"
            className="mt-3 border border-[#c0563a] bg-[#fdeceb] p-3 text-sm font-bold text-[#8a2f1c]"
          >
            {props.failureMessage}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={props.onConfirm}
            disabled={!gate.canStop || props.busy}
            data-openclaw-action="confirm-global-stop"
            className="min-h-11 flex-1 border border-[#c0563a] bg-[#c0563a] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Dừng toàn bộ ngay
          </button>
          <button
            type="button"
            onClick={props.onClose}
            data-openclaw-action="close-global-stop"
            className="min-h-11 flex-1 border border-[#9fb0bf] bg-white px-4 text-sm font-bold text-[#102a43]"
          >
            Huỷ
          </button>
        </div>
      </section>
    </div>
  );
}
