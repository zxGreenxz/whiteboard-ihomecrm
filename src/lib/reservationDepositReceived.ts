import { z } from "zod";

const receivedFactSchema = z.object({
  voucher_id: z.string().uuid(),
  reservation_id: z.string().uuid().nullable(),
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
