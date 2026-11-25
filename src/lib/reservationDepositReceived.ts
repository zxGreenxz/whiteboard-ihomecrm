import { supabase } from "@/integrations/supabase/client";
import { z } from "zod";

const receivedFactSchema = z.object({
  voucher_id: z.string().guid(),
  reservation_id: z.string().guid().nullable(),
  received_amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ReservationReceivedFact = z.infer<typeof receivedFactSchema>;
export type ReservationReceivedInvoker = (
  name: "read_reservation_deposit_received_v1",
  args: { p_organization_id: string; p_voucher_ids: string[] },
) => PromiseLike<{ data: unknown; error: unknown }>;

/** Keep each request within the server cap, including after deduplication. */
export async function readReservationReceivedFacts(
  invoke: ReservationReceivedInvoker, organizationId: string, voucherIds: string[],
): Promise<Map<string, ReservationReceivedFact>> {
  const ids = [...new Set(voucherIds)].sort();
  const facts = new Map<string, ReservationReceivedFact>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const { data, error } = await invoke("read_reservation_deposit_received_v1", {
      p_organization_id: organizationId, p_voucher_ids: batch,
    });
    if (error) throw error;
    for (const fact of z.array(receivedFactSchema).parse(data)) {
      if (!batch.includes(fact.voucher_id) || facts.has(fact.voucher_id)) {
        throw new TypeError("Chưa xác nhận được số tiền cọc thực nhận.");
      }
      facts.set(fact.voucher_id, fact);
    }
  }
  // Missing facts may be withheld by RLS or reflect a concurrent conversion.
  // Callers must retain UNKNOWN and must never fall back to voucher face value.
  return facts;
}

const contractRoomDepositsSchema = z.object({
  hold: z.object({ id: z.string().guid(), revision: z.number().int().positive(), hint: z.string().nullable() }).nullable(),
  vouchers: z.array(z.object({
    id: z.string().guid(), code: z.string().nullable(), name: z.string(), total_amount: z.number().finite().nonnegative(),
    voucher_date: z.iso.date(), approval_status: z.string(), received: z.boolean(),
  })),
});
/** Decode the complete posting snapshot before it is used to calculate a contract's paid deposit. */
export async function readContractRoomDeposits(organizationId: string, roomId: string) {
  const { data, error } = await supabase.rpc("get_contract_room_deposits_v1", {
    p_organization_id: organizationId,
    p_room_id: roomId,
  });
  if (error) throw error;
  const snapshot = contractRoomDepositsSchema.parse(data);
  if (new Set(snapshot.vouchers.map(voucher => voucher.id)).size !== snapshot.vouchers.length) {
    throw new TypeError("Danh sách phiếu cọc của phòng có phiếu bị lặp.");
  }
  return snapshot;
}
