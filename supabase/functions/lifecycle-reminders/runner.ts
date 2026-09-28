export interface LifecycleRpc {
  (name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}
export interface LifecycleDelivery {
  id: string;
  lease: string;
  user_id: string;
  idempotency_key: string;
  notification_ids: string[];
  title: string;
  body: string;
  url: string;
}
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function rpcValue(rpc: LifecycleRpc, name: string, args?: Record<string, unknown>) {
  const result = await rpc(name, args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return result.data;
}

export function parseLifecycleDelivery(value: unknown): LifecycleDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed lifecycle delivery');
  const row = value as Record<string, unknown>;
  for (const key of ['id', 'lease', 'user_id', 'idempotency_key', 'title', 'body', 'url']) {
    if (typeof row[key] !== 'string' || !row[key]) throw new Error(`Malformed lifecycle delivery: ${key}`);
  }
  if (!Array.isArray(row.notification_ids) || row.notification_ids.some(id => typeof id !== 'string')) {
    throw new Error('Malformed lifecycle notification IDs');
  }
  return row as unknown as LifecycleDelivery;
}

/** Server-only sweep. No browser, financial jobs or global drain dependency. */
export async function runLifecycleReminders(rpc: LifecycleRpc, fetcher: FetchLike, url: string, serviceKey: string) {
  const tally: Record<string, number> = {};
  let delivered = 0;
  const failures: string[] = [];
  try {
    const sweep = await rpcValue(rpc, 'lifecycle_reminder_sweep_v1');
    const rawBatch = await rpcValue(rpc, 'lifecycle_reminder_claim_v1', { p_limit: 10 });
    if (!Array.isArray(rawBatch)) throw new Error('Malformed lifecycle claim response');
    for (const raw of rawBatch) {
      const claimed = parseLifecycleDelivery(raw);
      // Recheck immediately before HTTP; permission/source changes since batch claim
      // discard this delivery. We send only fresh count text, no customer details.
      const validated = await rpcValue(rpc, 'lifecycle_reminder_validate_v1', { p_id: claimed.id, p_lease: claimed.lease });
      if (validated === null) { tally.SKIPPED = (tally.SKIPPED ?? 0) + 1; continue; }
      const item = parseLifecycleDelivery(validated);
      let outcome = 'PROVIDER_ERROR';
      let sent = 0;
      let error: string | null = null;
      try {
        const response = await fetcher(`${url}/functions/v1/send-push`, {
          method: 'POST', headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: item.user_id, idempotencyKey: item.idempotency_key, notificationIds: item.notification_ids,
            title: item.title, body: item.body, url: item.url, tag: `lifecycle:${item.id}` }),
          signal: AbortSignal.timeout(8000),
        });
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid push response body');
        const value = body as Record<string, unknown>;
        const allowed = ['SENT', 'PARTIAL', 'DUPLICATE', 'NO_DEVICE', 'CONFIG_ERROR', 'ALL_FAILED', 'PROVIDER_ERROR', 'BAD_REQUEST', 'UNAUTHORIZED'];
        if (typeof value.outcome !== 'string' || !allowed.includes(value.outcome)) throw new Error('Invalid push outcome');
        outcome = value.outcome;
        sent = typeof value.sent === 'number' && Number.isInteger(value.sent) && value.sent >= 0 ? value.sent : 0;
        error = typeof value.error === 'string' ? value.error : null;
        // HTTP 200 / DUPLICATE are not proof of provider acceptance. CONFIG_ERROR
        // is returned before send-push gets an idempotencyKey (e.g. TEST no VAPID).
        if (['SENT', 'PARTIAL'].includes(outcome) && (sent === 0 || value.idempotencyKey !== item.idempotency_key)) {
          throw new Error('Push acceptance receipt does not match this attempt');
        }
      } catch (reason) {
        outcome = 'PROVIDER_ERROR'; sent = 0; error = String(reason);
      }
      await rpcValue(rpc, 'lifecycle_reminder_settle_v1', { p_id: item.id, p_lease: item.lease, p_outcome: outcome, p_sent: sent, p_error: error });
      tally[outcome] = (tally[outcome] ?? 0) + 1;
      if (['SENT', 'PARTIAL'].includes(outcome) && sent > 0) delivered++;
      if (['PROVIDER_ERROR', 'ALL_FAILED', 'BAD_REQUEST', 'UNAUTHORIZED'].includes(outcome)) failures.push(`${item.id}: ${outcome}`);
    }
    if (failures.length) {
      await rpcValue(rpc, 'lifecycle_reminder_record_failure_v1', { p_error: failures.join('; ') });
    }
    return { ok: failures.length === 0, sweep, batches: rawBatch.length, delivered, outcomes: tally };
  } catch (reason) {
    // A failed sweep/claim/settle must be observable and retriable, never a daily
    // done flag. Propagate if the health write also fails; edge returns HTTP 500.
    await rpcValue(rpc, 'lifecycle_reminder_record_failure_v1', { p_error: String(reason).slice(0, 2000) });
    throw reason;
  }
}
