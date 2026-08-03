import {
  LEGAL_HOLD_TARGET_KINDS,
  legalHoldGate,
  type LegalHoldTargetKind,
  type ReplayOutcome,
} from "@/lib/openclaw-zalo/legalHold";

export interface DeadLetterView {
  deadLetterId: string;
  reasonCode: string;
  createdAt: string;
}

export interface UnknownRowView {
  outboxId: string;
  /** There is no targetId on an UNKNOWN row; the payload hash is what identifies it. */
  payloadHash: string;
  terminalAt: string;
  /** Non-null once somebody has recorded a conclusion. */
  resolutionOutcome: string | null;
}

interface OpenClawOperationsProps {
  unknownRows: readonly UnknownRowView[];
  deadLetters: readonly DeadLetterView[];
  loading: boolean;
  canManageOperations: boolean;
  canAudit: boolean;
  busy: boolean;
  /** The outcome of the most recent replay, if one has been run this session. */
  lastReplay: ReplayOutcome | null;
  holdTargetKind: LegalHoldTargetKind;
  holdTargetId: string;
  holdReason: string;
  onOpenUnknown: (outboxId: string) => void;
  onReplayDeadLetter: (deadLetterId: string) => void;
  onHoldTargetKindChange: (kind: LegalHoldTargetKind) => void;
  onHoldTargetIdChange: (targetId: string) => void;
  onHoldReasonChange: (reason: string) => void;
  onCreateHold: () => void;
}

const HOLD_BLOCK_COPY = {
  PERMISSION_AUDIT: "Cần thêm quyền kiểm toán để tạo lệnh giữ bằng chứng.",
  PERMISSION_OPERATIONS: "Cần thêm quyền vận hành để tạo lệnh giữ bằng chứng.",
  NO_TARGET: "Nhập định danh đối tượng cần giữ.",
  NO_REASON: "Nhập lý do giữ; lý do này đi vào nhật ký kiểm toán.",
} as const;

const REPLAY_COPY = {
  WORK_ITEM: "Đã xếp một việc gửi lại cho runtime xử lý. Chưa có tin mới nào tới khách.",
  NEW_OUTBOX: "Đã tạo một tin gửi MỚI tới khách, sau khi máy chủ kiểm lại chính sách.",
} as const;

export default function OpenClawOperations(props: OpenClawOperationsProps) {
  const holdGate = legalHoldGate({
    canAudit: props.canAudit,
    canManageOperations: props.canManageOperations,
    targetId: props.holdTargetId,
    reason: props.holdReason,
  });

  return (
    <div className="grid gap-4 p-4" data-openclaw-operations="root">
      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Tin không xác định
        </h2>
        {props.unknownRows.length === 0 ? (
          <p data-openclaw-operations="unknown-empty" className="mt-2 text-sm text-[#607585]">
            {props.loading ? "Đang tải…" : "Không có tin nào cần đối chiếu."}
          </p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {props.unknownRows.map(row => (
              <li
                key={row.outboxId}
                data-openclaw-unknown-row={row.outboxId}
                className="border border-[#e2e8ee] p-2"
              >
                <p className="flex flex-wrap gap-1 text-xs">
                  {/* The historical badge stays even after a conclusion; the
                      conclusion adds a second one. */}
                  <span className="border border-[#9fb0bf] px-1 font-bold">UNKNOWN</span>
                  {row.resolutionOutcome !== null && (
                    <span
                      data-openclaw-unknown-resolved={row.resolutionOutcome}
                      className="border border-[#0f766e] px-1 font-bold text-[#0b5d51]"
                    >
                      {row.resolutionOutcome}
                    </span>
                  )}
                </p>
                <p className="mt-1 font-mono text-xs text-[#607585]">
                  {row.payloadHash.slice(0, 12)}… · {row.terminalAt}
                </p>
                <button
                  type="button"
                  onClick={() => props.onOpenUnknown(row.outboxId)}
                  disabled={!props.canManageOperations}
                  data-openclaw-action="open-unknown"
                  className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {row.resolutionOutcome === null ? "Đối chiếu" : "Xem kết luận"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Dead-letter
        </h2>
        {props.lastReplay !== null && (
          <p
            data-openclaw-replay={props.lastReplay.kind}
            className="mt-2 border border-[#cbd5df] p-2 text-sm font-bold"
          >
            {REPLAY_COPY[props.lastReplay.kind]}
          </p>
        )}
        {props.deadLetters.length === 0 ? (
          <p data-openclaw-operations="dead-letter-empty" className="mt-2 text-sm text-[#607585]">
            Không có dead-letter.
          </p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {props.deadLetters.map(item => (
              <li
                key={item.deadLetterId}
                data-openclaw-dead-letter={item.deadLetterId}
                className="border border-[#e2e8ee] p-2"
              >
                <p className="text-sm font-bold">{item.reasonCode}</p>
                <p className="mt-1 font-mono text-xs text-[#607585]">{item.createdAt}</p>
                <button
                  type="button"
                  onClick={() => props.onReplayDeadLetter(item.deadLetterId)}
                  disabled={!props.canManageOperations || props.busy}
                  data-openclaw-action="replay-dead-letter"
                  className="mt-2 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Gửi lại
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* The recheck is the server's, not a promise this screen can keep on its
            own - but saying it happens is what stops "replay" reading as "force". */}
        <p className="mt-2 text-xs leading-5 text-[#607585]">
          Gửi lại chỉ tạo tin mới sau khi máy chủ kiểm lại chính sách hiện hành. Nếu chính sách
          đang chặn, sẽ không có tin nào được tạo.
        </p>
      </section>

      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Giữ bằng chứng
        </h2>
        <label className="mt-2 block text-xs font-bold text-[#607585]">Loại đối tượng</label>
        <select
          value={props.holdTargetKind}
          onChange={event => props.onHoldTargetKindChange(event.target.value as LegalHoldTargetKind)}
          data-openclaw-hold="target-kind"
          className="mt-1 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm"
        >
          {LEGAL_HOLD_TARGET_KINDS.map(kind => (
            <option key={kind} value={kind}>{kind}</option>
          ))}
        </select>

        <label className="mt-2 block text-xs font-bold text-[#607585]">Định danh đối tượng</label>
        <input
          type="text"
          value={props.holdTargetId}
          onChange={event => props.onHoldTargetIdChange(event.target.value)}
          data-openclaw-hold="target-id"
          className="mt-1 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 font-mono text-sm"
        />

        <label className="mt-2 block text-xs font-bold text-[#607585]">Lý do</label>
        <input
          type="text"
          value={props.holdReason}
          onChange={event => props.onHoldReasonChange(event.target.value)}
          data-openclaw-hold="reason"
          className="mt-1 min-h-11 w-full border border-[#9fb0bf] bg-white px-3 text-sm"
        />

        {holdGate.blockedBy !== null && (
          <p
            data-openclaw-hold-blocked={holdGate.blockedBy}
            className="mt-2 text-sm font-bold text-[#8a4b12]"
          >
            {HOLD_BLOCK_COPY[holdGate.blockedBy]}
          </p>
        )}

        <button
          type="button"
          onClick={props.onCreateHold}
          disabled={!holdGate.canCreate || props.busy}
          data-openclaw-action="create-legal-hold"
          className="mt-2 min-h-11 w-full border border-[#0f766e] bg-[#0f766e] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          Tạo lệnh giữ
        </button>
        <p className="mt-2 text-xs leading-5 text-[#607585]">
          Lệnh giữ chặn việc xoá theo vòng đời lưu trữ và được ghi vào nhật ký kiểm toán chỉ-thêm.
          Lý do bạn nhập nằm trong bản ghi đó.
        </p>
      </section>
    </div>
  );
}
