import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  invokeReservationSettlementRpc,
  reservationSettlementListSchema,
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

const rpc = supabase.rpc.bind(supabase) as unknown as ReservationSettlementRpcInvoker;

const affectedQueryKeys = [
  ["income-expenses"], ["ie-history"], ["voucher-change-log"],
  ["reservation-deposits"], ["orphan-deposit-vouchers"], ["deposit-dashboard"],
  ["reservation-settlements"], ["reservation-settlement-summary"],
  ["rooms"], ["contracts"], ["phong-trong"], ["financial-analysis"],
  ["business-performance"], ["cash-flow-by-day"], ["accounts-with-balance"],
] as const;

function useStableIdempotencyKey(prefix: string) {
  const keys = useRef(new Map<string, string>());
  return (payload: object) => {
    const signature = JSON.stringify(payload);
    const current = keys.current.get(signature);
    if (current) return current;
    const next = `${prefix}:${crypto.randomUUID()}`;
    keys.current.set(signature, next);
    return next;
  };
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
  const idempotencyKey = useStableIdempotencyKey("reservation-settle");
  return useMutation({
    mutationFn: (input: Omit<SettleReservationInput, "idempotencyKey">) => {
      const p_input: SettleReservationInput = { ...input, idempotencyKey: idempotencyKey(input) };
      return invokeReservationSettlementRpc(
        rpc, "settle_reservation_deposit_v1", { p_input }, reservationSettlementSchema,
      );
    },
    onSuccess: invalidate,
  });
}

export function usePayReservationRefund() {
  const invalidate = useInvalidateSettlementData();
  const idempotencyKey = useStableIdempotencyKey("reservation-refund");
  return useMutation({
    mutationFn: (input: Omit<PayReservationRefundInput, "idempotencyKey">) => {
      const p_input: PayReservationRefundInput = { ...input, idempotencyKey: idempotencyKey(input) };
      return invokeReservationSettlementRpc(
        rpc, "pay_reservation_refund_v1", { p_input }, reservationSettlementSchema,
      );
    },
    onSuccess: invalidate,
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
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["reservation-settlements", input ?? {}],
    enabled: input?.enabled ?? true,
    queryFn: () => invokeReservationSettlementRpc(
      rpc,
      "get_reservation_settlements_v1",
      {
        p_building_ids: input?.buildingIds?.length ? input.buildingIds : null,
        p_refund_state: input?.refundState ?? null,
        p_cursor: input?.cursor ?? null,
        p_limit: 50,
      },
      reservationSettlementListSchema,
    ),
  });
}
