import { supabase } from "@/integrations/supabase/client";
import { readIncomeExpenseActionSnapshotPage } from "@/hooks/income-expenses/useIncomeExpenseActionSnapshots";
import { readActionSnapshotBatches } from "./incomeExpenseActionSnapshot";
import { SettlementCreateError } from "./contractSettlementCreate";
import {
  parseReservationRefundSource,
  type ReservationRefundPorts,
  type CreateReservationRefundInput,
} from "./reservationRefundWorkflow";
export interface ReservationRefundActionInput {
  organizationId: string;
  sourceVoucherId: string;
  settlementId: string;
  basisFingerprint: string;
  expectedRemaining: number;
  voucherId: string;
  expectedApprovalVersion: number;
  expectedPostingVersion: number;
  expectedReviewVersion: number;
  idempotencyKey: string;
  action:
    | "approve"
    | "approve_and_post"
    | "post"
    | "reverse"
    | "request_changes"
    | "resubmit";
  reason?: string;
  cashbookId?: string;
  postedOn?: string;
  evidenceIds?: string[];
}
type RpcResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};
type WorkflowRpc = (
  name:
    | "create_reservation_refund_pending_v1"
    | "execute_reservation_refund_action_v1",
  args: {
    p_input: CreateReservationRefundInput | ReservationRefundActionInput;
  },
) => PromiseLike<RpcResult>;
type ReadRpc = (
  name: "read_reservation_refund_workflow_v1",
  args: {
    p_organization_id: string;
    p_source_voucher_id: string;
    p_settlement_id: string | null;
  },
) => PromiseLike<RpcResult>;
const value = (r: RpcResult) => {
  if (r.error)
    throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.data;
};
export function reservationRefundRepository(
  actorId: string,
  organizationId: string,
): ReservationRefundPorts {
  return {
    readSource: async (ref) => {
      if (ref.organizationId !== organizationId)
        throw new SettlementCreateError(
          "blocked",
          "Nguồn không thuộc tổ chức hiện tại.",
        );
      return parseReservationRefundSource(
        value(
          await (supabase.rpc as unknown as ReadRpc)(
            "read_reservation_refund_workflow_v1",
            {
              p_organization_id: organizationId,
              p_source_voucher_id: ref.sourceVoucherId,
              p_settlement_id: ref.settlementId,
            },
          ),
        ),
        ref,
        actorId,
      );
    },
    readVoucher: async (id) => {
      const b = await readActionSnapshotBatches(
        { actorId, organizationId },
        [id],
        readIncomeExpenseActionSnapshotPage,
      );
      const v = b.rows[id];
      if (!v)
        throw new SettlementCreateError(
          "unconfirmed",
          "Chưa đọc được phiếu hoàn.",
        );
      return v;
    },
    createPending: async (input) =>
      value(
        await (supabase.rpc as unknown as WorkflowRpc)(
          "create_reservation_refund_pending_v1",
          { p_input: input },
        ),
      ),
  };
}
/** The controller owns the stable key and all source/CAS facts. No retry or fallback here. */
export async function executeReservationRefundAction(
  input: ReservationRefundActionInput,
): Promise<void> {
  const response = value(
    await (supabase.rpc as unknown as WorkflowRpc)(
      "execute_reservation_refund_action_v1",
      { p_input: input },
    ),
  );
  if (!response || typeof response !== "object" || Array.isArray(response))
    throw new Error("Chưa xác nhận được kết quả phiếu hoàn.");
  const r = response as Record<string, unknown>,
    a = input.action;
  let valid = r.voucherId === input.voucherId;
  if (a === "request_changes" || a === "resubmit")
    valid =
      valid &&
      r.approvalStatus === "UNAPPROVED" &&
      r.reviewState === (a === "resubmit" ? "PENDING" : "CHANGES_REQUESTED") &&
      r.reviewVersion === input.expectedReviewVersion + 1;
  if (a === "approve" || a === "approve_and_post")
    valid =
      valid &&
      r.approvalStatus === "APPROVED" &&
      r.approvalVersion === input.expectedApprovalVersion + 1;
  if (a === "post" || a === "approve_and_post" || a === "reverse")
    valid =
      valid &&
      r.postingStatus === (a === "reverse" ? "REVERSED" : "POSTED") &&
      r.postingVersion === input.expectedPostingVersion + 1 &&
      typeof r[a === "reverse" ? "reversalPostingId" : "postingId"] ===
        "string";
  if (!valid)
    throw new Error(
      "Chưa xác nhận được kết quả phiếu hoàn. Tải lại để đối chiếu.",
    );
}
