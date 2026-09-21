import type { Database } from "@/integrations/supabase/types";
import type { SettlementSourceRef } from "./contractSettlement";
import type { IncomeExpenseActionSnapshot } from "./incomeExpenseActionSnapshot";
import { rpcNullable } from "./rpcNullable";

export type CreatableSettlementSourceRef = Exclude<
  SettlementSourceRef,
  { kind: "reservation_refund" }
>;
export type SettlementCreateKind = CreatableSettlementSourceRef["kind"];
export interface SettlementRefundPreview {
  terminationId: string;
  contractId: string;
  organizationId: string;
  requestedAmount: number;
  realHeld: number;
  recognizedOnly: number;
  basisStatus: string;
  basisFingerprint: string;
  obligationStatus: "OK" | "VUOT_COC_THAT" | "CHUA_TUNG_VAO_KET";
  warning: string | null;
}
export interface SettlementRefundObligation {
  id: string;
  organizationId: string;
  terminationId: string;
  contractId: string;
  version: number;
  requestedAmount: number;
  realHeld: number;
  recognizedOnly: number;
  basisFingerprint: string;
  obligationStatus: SettlementRefundPreview["obligationStatus"];
}
export interface SettlementCreateSource {
  actorId: string;
  organizationId: string;
  kind: SettlementCreateKind;
  sourceId: string;
  revision: string;
  canCreate: boolean;
  blockedReason: string | null;
  canForce: boolean;
  existingVoucherId: string | null;
  hiddenExisting: boolean;
  contractId: string | null;
  buildingId: string;
  roomId: string | null;
  sourceCode: string | null;
  sourceStatus: string;
  sourceDate: string | null;
  today: string;
  name: string;
  recipientName: string | null;
  recipientBank: string | null;
  recipientAccount: string | null;
  suggestedAmount: number | null;
  capAmount: number | null;
  basis: {
    kind: "commission" | "bonus" | "refund";
    months: number | null;
    ratePercent: number | null;
    expectedAmount: number | null;
    warning: string | null;
  };
  refund: SettlementRefundPreview | null;
  latestObligation: SettlementRefundObligation | null;
}
export interface SettlementCreateDraft {
  amount: number;
  voucherDate: string;
  payerName: string;
  recipientName: string;
  bank: string;
  accountNumber: string;
  itemDescription: string;
  attachments: string[];
  force: boolean;
  forceReason: string;
  forceConfirmed: boolean;
}
export interface SettlementCreateRequest {
  actorId: string;
  sourceRef: SettlementSourceRef;
  expectedRevision: string;
  draft: SettlementCreateDraft;
}
type Functions = Database["public"]["Functions"];
export type SettlementRefundCreateArgs =
  Functions["create_termination_refund_voucher_v1"]["Args"] & {
    p_recipient_name: string;
    p_recipient_bank: string;
    p_recipient_account: string;
  };
export interface SettlementCreatePorts {
  readSource: (
    ref: CreatableSettlementSourceRef,
    amount?: number,
  ) => Promise<SettlementCreateSource>;
  readVoucher: (id: string) => Promise<IncomeExpenseActionSnapshot>;
  createCommission: (
    args: Functions["create_commission_voucher"]["Args"],
  ) => Promise<unknown>;
  createDeposit: (
    args: Functions["create_sale_bonus_from_deposit_v1"]["Args"],
  ) => Promise<unknown>;
  previewRefund: (id: string) => Promise<SettlementRefundPreview>;
  recordObligation: (id: string) => Promise<unknown>;
  readObligation: (
    id: string,
    ref: Extract<CreatableSettlementSourceRef, { kind: "termination_refund" }>,
  ) => Promise<SettlementRefundObligation>;
  createRefund: (args: SettlementRefundCreateArgs) => Promise<unknown>;
}
export type SettlementCreateResult = {
  outcome: "created" | "existing";
  voucherId: string;
};
export class SettlementCreateError extends Error {
  constructor(
    public readonly kind: "blocked" | "validation" | "conflict" | "unconfirmed",
    message: string,
  ) {
    super(message);
    this.name = "SettlementCreateError";
  }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new SettlementCreateError(
      "unconfirmed",
      "Chưa xác minh được kết quả lập phiếu.",
    );
  return x as Record<string, unknown>;
};
const returnedId = (x: unknown, key: string): string => {
  const value = object(x)[key];
  if (typeof value !== "string" || !uuid.test(value))
    throw new SettlementCreateError(
      "unconfirmed",
      "Kết quả chưa có mã định danh phiếu hợp lệ.",
    );
  return value;
};
const nonempty = (s: string) => rpcNullable<string>(s.trim() || null);
export const settlementCreateSourceId = (ref: CreatableSettlementSourceRef) =>
  ref.kind === "sale_deposit"
    ? ref.depositVoucherId
    : ref.kind === "termination_refund"
      ? ref.terminationId
      : ref.contractId;
function assertScope(
  source: SettlementCreateSource,
  request: SettlementCreateRequest,
  ref: CreatableSettlementSourceRef,
) {
  if (
    source.actorId !== request.actorId ||
    source.organizationId !== ref.organizationId ||
    source.kind !== ref.kind ||
    source.sourceId !== settlementCreateSourceId(ref)
  )
    throw new SettlementCreateError(
      "blocked",
      "Nguồn không thuộc người dùng hoặc tổ chức đang thao tác.",
    );
  if (source.hiddenExisting)
    throw new SettlementCreateError(
      "blocked",
      "Nguồn đã có phiếu nhưng bạn chưa được xem phiếu đó.",
    );
}
const sameRefund = (
  a: SettlementRefundPreview,
  b: SettlementRefundPreview | SettlementRefundObligation,
) =>
  a.organizationId === b.organizationId &&
  a.terminationId === b.terminationId &&
  a.contractId === b.contractId &&
  a.requestedAmount === b.requestedAmount &&
  a.realHeld === b.realHeld &&
  a.recognizedOnly === b.recognizedOnly &&
  a.basisFingerprint === b.basisFingerprint &&
  a.obligationStatus === b.obligationStatus;
function validateDraft(
  source: SettlementCreateSource,
  draft: SettlementCreateDraft,
) {
  if (!Number.isSafeInteger(draft.amount) || draft.amount <= 0)
    throw new SettlementCreateError(
      "validation",
      "Nhập số tiền nguyên lớn hơn 0.",
    );
  const day = new Date(draft.voucherDate + "T00:00:00Z");
  if (
    source.kind !== "termination_refund" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(draft.voucherDate) ||
      Number.isNaN(day.valueOf()) ||
      day.toISOString().slice(0, 10) !== draft.voucherDate)
  )
    throw new SettlementCreateError(
      "validation",
      "Ngày lập phiếu không hợp lệ.",
    );
  if (
    source.kind.startsWith("sale_") &&
    source.capAmount !== null &&
    draft.amount > source.capAmount
  )
    throw new SettlementCreateError(
      "validation",
      "Số tiền đề xuất vượt trần thưởng đã công bố.",
    );
  if (
    !Array.isArray(draft.attachments) ||
    draft.attachments.some((x) => typeof x !== "string" || !x.trim())
  )
    throw new SettlementCreateError(
      "validation",
      "Danh sách chứng từ không hợp lệ.",
    );
  if (source.kind === "termination_refund") {
    if (
      !source.refund ||
      !["APPROVED", "COMPLETED"].includes(source.sourceStatus) ||
      source.refund.requestedAmount <= 0 ||
      draft.amount !== source.refund.requestedAmount
    )
      throw new SettlementCreateError(
        "blocked",
        "Hồ sơ chưa có khoản hoàn đã được duyệt phù hợp.",
      );
    if (
      source.refund.obligationStatus !== "OK" &&
      (!source.canForce ||
        !draft.force ||
        !draft.forceConfirmed ||
        draft.forceReason.trim().length < 8)
    )
      throw new SettlementCreateError(
        "blocked",
        "Cần chủ tổ chức xác nhận hoàn dù có cảnh báo và ghi lý do ít nhất 8 ký tự.",
      );
  }
}
async function readVoucherForSource(
  id: string,
  source: SettlementCreateSource,
  ports: Pick<SettlementCreatePorts, "readVoucher">,
): Promise<IncomeExpenseActionSnapshot> {
  let row: IncomeExpenseActionSnapshot;
  try {
    row = await ports.readVoucher(id);
  } catch {
    throw new SettlementCreateError(
      "unconfirmed",
      "Chưa đọc được trạng thái phiếu. Tải lại để đối chiếu; không lập thêm phiếu.",
    );
  }
  const expectedSystem =
    source.kind === "termination_refund"
      ? "termination.refund"
      : "contract.commission";
  if (
    row.id !== id ||
    row.organizationId !== source.organizationId ||
    row.type !== "EXPENSE" ||
    row.systemSource !== expectedSystem ||
    (source.kind !== "sale_deposit" && row.contractId !== source.contractId)
  )
    throw new SettlementCreateError(
      "unconfirmed",
      "Chưa xác minh được phiếu đúng nguồn. Không lập lại hoặc tự hoàn tác.",
    );
  return row;
}
export async function verifySettlementExistingVoucher(
  source: SettlementCreateSource,
  ports: Pick<SettlementCreatePorts, "readVoucher">,
): Promise<SettlementCreateResult> {
  if (source.hiddenExisting || !source.existingVoucherId)
    throw new SettlementCreateError(
      "blocked",
      "Chưa có phiếu hiện hữu được xác minh từ nguồn.",
    );
  await readVoucherForSource(source.existingVoucherId, source, ports);
  return { outcome: "existing", voucherId: source.existingVoucherId };
}
async function verifyVoucher(
  id: string,
  outcome: SettlementCreateResult["outcome"],
  source: SettlementCreateSource,
  request: SettlementCreateRequest,
  ports: SettlementCreatePorts,
): Promise<SettlementCreateResult> {
  const row = await readVoucherForSource(id, source, ports);
  if (
    outcome === "created" &&
    (row.totalAmount !== request.draft.amount ||
      row.approvalStatus !== "UNAPPROVED" ||
      row.reviewState !== "PENDING" ||
      row.postingStatus !== "UNPOSTED" ||
      row.accountId !== null ||
      row.activePostingId !== null)
  )
    throw new SettlementCreateError(
      "unconfirmed",
      "Phiếu vừa lập có trạng thái khác Chờ duyệt. Cần đối chiếu trước khi thao tác tiếp.",
    );
  if (
    outcome === "created" &&
    source.kind === "termination_refund" &&
    (row.payerName !== (request.draft.recipientName.trim() || null) ||
      row.receiveBankName !== (request.draft.bank.trim() || null) ||
      row.receiveBankAccount !== (request.draft.accountNumber.trim() || null))
  )
    throw new SettlementCreateError(
      "unconfirmed",
      "Chưa đối chiếu được thông tin người nhận đã lưu trên phiếu hoàn.",
    );
  return { outcome, voucherId: id };
}
/** Natural source claims own deduplication. No generic create, approval, posting or compensation lives here. */
export async function createContractSettlementVoucher(
  request: SettlementCreateRequest,
  ports: SettlementCreatePorts,
): Promise<SettlementCreateResult> {
  if (request.sourceRef.kind === "reservation_refund")
    throw new SettlementCreateError(
      "blocked",
      "Luồng lập phiếu hoàn giữ chỗ chưa sẵn sàng.",
    );
  const ref = request.sourceRef,
    source = await ports.readSource(ref, request.draft.amount);
  assertScope(source, request, ref);
  if (source.existingVoucherId)
    return verifyVoucher(
      source.existingVoucherId,
      "existing",
      source,
      request,
      ports,
    );
  if (source.revision !== request.expectedRevision)
    throw new SettlementCreateError(
      "conflict",
      "Nguồn hoặc căn cứ đã thay đổi. Tải lại và rà soát trước khi lập phiếu.",
    );
  if (!source.canCreate)
    throw new SettlementCreateError(
      "blocked",
      source.blockedReason || "Chưa đủ điều kiện lập phiếu từ nguồn này.",
    );
  validateDraft(source, request.draft);
  const d = request.draft;
  let response: unknown;
  let existing = false;
  try {
    if (ref.kind === "broker" || ref.kind === "sale_contract")
      response = await ports.createCommission({
        p_contract_id: ref.contractId,
        p_kind: ref.kind === "broker" ? "broker" : "sale",
        p_amount: d.amount,
        p_voucher_date: d.voucherDate,
        p_account_id: rpcNullable<string>(null),
        p_payer_name: nonempty(d.payerName),
        p_recipient_name: nonempty(d.recipientName),
        p_recipient_bank: nonempty(d.bank),
        p_recipient_account: nonempty(d.accountNumber),
        p_item_description: nonempty(d.itemDescription),
        p_attachments: d.attachments,
      });
    else if (ref.kind === "sale_deposit")
      response = await ports.createDeposit({
        p_deposit_voucher_id: ref.depositVoucherId,
        p_amount: d.amount,
        p_account_id: rpcNullable<string>(null),
        p_voucher_date: d.voucherDate,
        p_recipient: nonempty(d.recipientName),
        p_bank: nonempty(d.bank),
        p_account_number: nonempty(d.accountNumber),
        p_attachments: d.attachments,
      });
    else {
      const preview = await ports.previewRefund(ref.terminationId);
      if (!source.refund || !sameRefund(source.refund, preview))
        throw new SettlementCreateError(
          "conflict",
          "Căn cứ hoàn cọc vừa thay đổi. Hãy tải lại để rà soát.",
        );
      const recorded = object(await ports.recordObligation(ref.terminationId));
      const obligationId = returnedId(recorded, "obligationId");
      const obligation = await ports.readObligation(obligationId, ref);
      if (
        obligation.id !== obligationId ||
        !Number.isSafeInteger(recorded.version) ||
        obligation.version !== recorded.version ||
        !sameRefund(preview, obligation)
      )
        throw new SettlementCreateError(
          "conflict",
          "Nghĩa vụ hoàn đã thay đổi trong lúc ghi nhận. Chưa lập phiếu chi.",
        );
      response = await ports.createRefund({
        p_obligation_id: obligationId,
        p_account_id: rpcNullable<string>(null),
        p_force: preview.obligationStatus !== "OK" && d.force,
        p_force_reason: nonempty(d.forceReason),
        p_recipient_name: nonempty(d.recipientName),
        p_recipient_bank: nonempty(d.bank),
        p_recipient_account: nonempty(d.accountNumber),
      });
      existing = object(response).alreadyCreated === true;
    }
  } catch (error) {
    if (error instanceof SettlementCreateError) throw error;
    // The RPC may have committed or a concurrent writer may have claimed this exact source.
    let latest: SettlementCreateSource;
    try {
      latest = await ports.readSource(ref, d.amount);
      assertScope(latest, request, ref);
    } catch {
      throw new SettlementCreateError(
        "unconfirmed",
        "Chưa xác nhận được kết quả. Giữ nguồn này và tải lại để tìm phiếu.",
      );
    }
    if (latest.existingVoucherId)
      return verifyVoucher(
        latest.existingVoucherId,
        "existing",
        latest,
        request,
        ports,
      );
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (
      code &&
      [
        "42501",
        "P0001",
        "P0002",
        "22023",
        "23502",
        "23514",
        "23505",
        "55000",
      ].includes(code)
    )
      throw new SettlementCreateError(
        "blocked",
        error instanceof Error
          ? error.message
          : "Nguồn chưa đủ điều kiện lập phiếu.",
      );
    throw new SettlementCreateError(
      "unconfirmed",
      "Chưa xác nhận được kết quả lập phiếu. Tải lại để đối chiếu; không tự lập thêm phiếu.",
    );
  }
  const id = returnedId(
    response,
    ref.kind === "broker" || ref.kind === "sale_contract" ? "id" : "voucherId",
  );
  let linked: SettlementCreateSource;
  try {
    linked = await ports.readSource(ref, d.amount);
    assertScope(linked, request, ref);
  } catch {
    throw new SettlementCreateError(
      "unconfirmed",
      "Đã nhận kết quả lập phiếu nhưng chưa đọc lại được liên kết nguồn.",
    );
  }
  if (linked.existingVoucherId !== id)
    throw new SettlementCreateError(
      "unconfirmed",
      "Chưa đối chiếu được phiếu với liên kết nguồn. Không lập lại phiếu.",
    );
  return verifyVoucher(
    id,
    existing ? "existing" : "created",
    linked,
    request,
    ports,
  );
}
