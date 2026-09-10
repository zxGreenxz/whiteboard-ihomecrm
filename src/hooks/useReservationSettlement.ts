import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  invokeReservationSettlementRpc,
  createReservationIdempotencyStore,
  reservationSettlementListSchema,
  reservationSettlementListArgs,
  reservationSettlementPreviewSchema,
  reservationSettlementSchema,
  reservationSettlementSummarySchema,
  type PayReservationRefundInput,
  type RefundState,
  type ReservationSettlementCursor,
  type ReservationSettlementRpcInvoker,
  type SettleReservationInput,
} from "@/lib/reservationSettlementRpc";
import { useRef } from "react";
import { z } from "zod";

const rpc = (supabase.rpc as unknown as ReservationSettlementRpcInvoker).bind(supabase);
type LegQueryResult = { data: unknown; error: { message?: string | null } | null };
type LegQuery = { select: (columns: string) => { eq: (column: "voucher_id", value: string) => { maybeSingle: () => PromiseLike<LegQueryResult> } } };
export function bindReservationSettlementLegTable(client: { from: (table: string) => unknown }) {
  return (client.from as unknown as (table: "reservation_settlement_vouchers") => LegQuery).bind(client);
}
const settlementLegTable = bindReservationSettlementLegTable(supabase as unknown as { from: (table: string) => unknown });
const settlementLegSchema = z.object({
  settlement: z.object({ sourceVoucherId: z.string().uuid() }),
}).nullable();
const settlementAuditSchema = z.object({
  created_by: z.string().uuid(),
  reason_code: z.string(),
  reason_text: z.string(),
  source_voucher_id: z.string().uuid(),
  revenue_voucher_id: z.string().uuid().nullable(),
  offset_voucher_id: z.string().uuid().nullable(),
  refund_voucher_id: z.string().uuid().nullable(),
  settlement_date: z.string(),
});

export const SETTLEMENT_LEG_SELECT = "settlement:reservation_deposit_settlements!inner(sourceVoucherId:source_voucher_id)";

async function findSettlementByLeg(voucherId: string) {
  const { data, error } = await settlementLegTable("reservation_settlement_vouchers")
    .select(SETTLEMENT_LEG_SELECT)
    .eq("voucher_id", voucherId)
    .maybeSingle();
  if (error) throw new Error("Không đọc được hồ sơ xử lý cọc. Hãy tải lại và thử lại.");
  const sourceVoucherId = settlementLegSchema.parse(data)?.settlement.sourceVoucherId;
  if (!sourceVoucherId) return null;
  const result = reservationSettlementListSchema.parse(await invokeReservationSettlementRpc(rpc, "get_reservation_settlements_v1", reservationSettlementListArgs({ sourceVoucherId }), reservationSettlementListSchema));
  return result.rows[0] ? reservationSettlementSchema.parse(result.rows[0]) : null;
}

const affectedQueryKeys = [
  ["income-expenses"], ["voucher-with-batch"], ["ie-history"], ["voucher-change-log"],
  ["reservation-deposits"], ["orphan-deposit-vouchers"], ["deposit-dashboard"],
  ["reservation-settlement-preview"],
  ["reservation-settlement-by-voucher"],
  ["reservation-settlement-audit"],
  ["reservation-refund-evidence"],
  ["reservation-settlements"], ["reservation-settlement-summary"],
  ["rooms"], ["contracts"], ["phong-trong"], ["financial-analysis"],
  ["business-performance"], ["cash-flow-by-day"], ["accounts-with-balance"],
] as const;

function useStableIdempotencyKey(prefix: string) {
  return useRef(createReservationIdempotencyStore(prefix)).current;
}

function useInvalidateSettlementData() {
  const client = useQueryClient();
  return async () => {
    await Promise.all(affectedQueryKeys.map((queryKey) => client.invalidateQueries({ queryKey })));
  };
}

export function useReservationSettlementPreview(voucherId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["reservation-settlement-preview", voucherId],
    enabled: enabled && !!voucherId,
    queryFn: () => invokeReservationSettlementRpc(
      rpc,
      "preview_reservation_settlement_v1",
      { p_voucher_id: voucherId },
      reservationSettlementPreviewSchema,
    ),
  });
}

export function useSettleReservationDeposit() {
  const invalidate = useInvalidateSettlementData();
  const idempotency = useStableIdempotencyKey("reservation-settle");
  return useMutation({
    mutationFn: (input: Omit<SettleReservationInput, "idempotencyKey">) => {
      const p_input: SettleReservationInput = { ...input, idempotencyKey: idempotency.keyFor(input) };
      return invokeReservationSettlementRpc(
        rpc, "settle_reservation_deposit_v1", { p_input }, reservationSettlementSchema,
      );
    },
    onSuccess: async (_result, input) => { idempotency.retire(input); await invalidate(); },
  });
}

export function usePayReservationRefund() {
  const invalidate = useInvalidateSettlementData();
  const idempotency = useStableIdempotencyKey("reservation-refund");
  return useMutation({
    mutationFn: (input: Omit<PayReservationRefundInput, "idempotencyKey">) => {
      const p_input: PayReservationRefundInput = { ...input, idempotencyKey: idempotency.keyFor(input) };
      return invokeReservationSettlementRpc(
        rpc, "pay_reservation_refund_v1", { p_input }, reservationSettlementSchema,
      );
    },
    onSuccess: async (_result, input) => { idempotency.retire(input); await invalidate(); },
  });
}

export function useReservationSettlementSummary(buildingIds?: string[]) {
  return useQuery({
    queryKey: ["reservation-settlement-summary", buildingIds ?? []],
    queryFn: () => invokeReservationSettlementRpc(
      rpc,
      "get_reservation_settlement_summary_v1",
      { p_building_ids: buildingIds?.length ? buildingIds : null },
      reservationSettlementSummarySchema,
    ),
  });
}

export function useReservationSettlements(input?: {
  buildingIds?: string[];
  refundState?: RefundState | null;
  cursor?: ReservationSettlementCursor | null;
  sourceVoucherId?: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["reservation-settlements", input ?? {}],
    enabled: input?.enabled ?? true,
    queryFn: () => invokeReservationSettlementRpc(
      rpc,
      "get_reservation_settlements_v1",
      reservationSettlementListArgs(input),
      reservationSettlementListSchema,
    ),
  });
}

export function useInfiniteReservationSettlements(input?: {
  buildingIds?: string[];
  refundState?: RefundState | null;
}) {
  return useInfiniteQuery({
    queryKey: ["reservation-settlements", "infinite", input ?? {}],
    initialPageParam: null as ReservationSettlementCursor | null,
    queryFn: ({ pageParam }) => invokeReservationSettlementRpc(
      rpc,
      "get_reservation_settlements_v1",
      reservationSettlementListArgs({ ...input, cursor: pageParam }),
      reservationSettlementListSchema,
    ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useReservationSettlementForVoucher(voucherId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["reservation-settlement-by-voucher", voucherId],
    enabled: enabled && !!voucherId,
    queryFn: async () => {
      if (!voucherId) return null;
      const sourceMatch = await invokeReservationSettlementRpc(
        rpc,
        "get_reservation_settlements_v1",
        reservationSettlementListArgs({ sourceVoucherId: voucherId }),
        reservationSettlementListSchema,
      );
      if (sourceMatch.rows[0]) return sourceMatch.rows[0];
      return findSettlementByLeg(voucherId);
    },
  });
}

export function useReservationSettlementAudit(settlementId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["reservation-settlement-audit", settlementId],
    enabled: enabled && !!settlementId,
    queryFn: async () => {
      const { data, error } = await supabase.from("reservation_deposit_settlements")
        .select("created_by,reason_code,reason_text,source_voucher_id,revenue_voucher_id,offset_voucher_id,refund_voucher_id,settlement_date")
        .eq("id", settlementId!)
        .maybeSingle();
      if (error || !data) throw new Error("Không đọc được dấu vết xử lý cọc.");
      const audit = settlementAuditSchema.parse(data);
      const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", audit.created_by).maybeSingle();
      return { ...audit, settlementDate: audit.settlement_date, actorName: profile?.full_name ?? null };
    },
  });
}
