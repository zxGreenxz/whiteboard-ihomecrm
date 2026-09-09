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

const rpc = supabase.rpc.bind(supabase) as unknown as ReservationSettlementRpcInvoker;
type LegQueryResult = { data: unknown; error: { message?: string | null } | null };
type LegQuery = { select: (columns: string) => { eq: (column: "voucher_id", value: string) => { maybeSingle: () => PromiseLike<LegQueryResult> } } };
const settlementLegTable = (supabase.from as unknown as (table: "reservation_settlement_vouchers") => LegQuery);
const settlementLegSchema = z.object({ settlement: reservationSettlementSchema }).nullable();

async function findSettlementByLeg(voucherId: string) {
  const { data, error } = await settlementLegTable("reservation_settlement_vouchers")
    .select("settlement:reservation_deposit_settlements!inner(id,sourceVoucherId:source_voucher_id,depositAmount:deposit_amount,retainedAmount:retained_amount,refundAmount:refund_amount,refundedAmount:refunded_amount,refundRemaining:refund_remaining,refundState:refund_state,roomReleased:room_released,roomBlockers:room_blockers,revenueVoucherId:revenue_voucher_id,offsetVoucherId:offset_voucher_id,refundVoucherId:refund_voucher_id)")
    .eq("voucher_id", voucherId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Không đọc được hồ sơ xử lý cọc");
  return settlementLegSchema.parse(data)?.settlement ?? null;
}

const affectedQueryKeys = [
  ["income-expenses"], ["ie-history"], ["voucher-change-log"],
  ["reservation-deposits"], ["orphan-deposit-vouchers"], ["deposit-dashboard"],
  ["reservation-settlement-preview"],
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
