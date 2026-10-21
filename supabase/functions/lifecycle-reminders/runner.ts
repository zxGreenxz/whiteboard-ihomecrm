import {
  callSendPush,
  FAILURE_OUTCOMES,
  formatEdgeError,
  rpcValue,
  runGenericPushDrain,
  type DrainOptions,
  type DrainResult,
  type DrainRpc,
  type FetchLike,
} from '../_shared/push-drain.ts';

// Một lượt cron 15' (B12, plan 2026-10-21 §3) chạy BA pha, mỗi pha cô lập lỗi:
//   (a) maintenance — notification_maintenance_v1: đối soát thông báo lỗi thời, dọn push_send_log;
//   (b) lifecycle   — sweep/claim/validate/settle nhắc vòng đời (gồm họ nhắc hoá đơn/HĐ/cọc, logic ở SQL);
//   (c) drain       — hàng đợi push E1–E6 dùng chung (_shared/push-drain.ts).
// Pha lỗi ghi lifecycle_reminder_record_failure_v1 với tiền tố '[maintenance]'/'[lifecycle]'/'[drain]'
// rồi pha sau VẪN chạy. Kết quả ok=false ⇒ edge trả 503 để cron/health thấy lượt hỏng.

export type LifecycleRpc = DrainRpc;

export interface LifecycleDelivery {
  id: string;
  lease: string;
  user_id: string;
  organization_id: string | null;
  idempotency_key: string;
  notification_ids: string[];
  title: string;
  body: string;
  url: string;
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
  if (row.organization_id !== undefined && row.organization_id !== null && typeof row.organization_id !== 'string') {
    throw new Error('Malformed lifecycle delivery: organization_id');
  }
  return {
    ...(row as unknown as LifecycleDelivery),
    organization_id: typeof row.organization_id === 'string' && row.organization_id ? row.organization_id : null,
  };
}

export interface LifecyclePhaseState {
  sweep: unknown;
  batches: number;
  delivered: number;
  outcomes: Record<string, number>;
  failures: string[];
}

/** Pha (b). Ném khi sweep/claim/validate/settle hỏng; `state` giữ số đếm tới lúc hỏng. */
export async function runLifecyclePhase(
  rpc: LifecycleRpc,
  fetcher: FetchLike,
  url: string,
  serviceKey: string,
  state: LifecyclePhaseState,
): Promise<LifecyclePhaseState> {
  state.sweep = await rpcValue(rpc, 'lifecycle_reminder_sweep_v1');
  const rawBatch = await rpcValue(rpc, 'lifecycle_reminder_claim_v1', { p_limit: 10 });
  if (!Array.isArray(rawBatch)) throw new Error('Malformed lifecycle claim response');
  state.batches = rawBatch.length;
  for (const raw of rawBatch) {
    const claimed = parseLifecycleDelivery(raw);
    // Recheck immediately before HTTP; permission/source changes since batch claim
    // discard this delivery. We send only fresh count text, no customer details.
    const validated = await rpcValue(rpc, 'lifecycle_reminder_validate_v1', { p_id: claimed.id, p_lease: claimed.lease });
    if (validated === null) { state.outcomes.SKIPPED = (state.outcomes.SKIPPED ?? 0) + 1; continue; }
    const item = parseLifecycleDelivery(validated);
    // send-push chép data.notificationIds/organizationId vào payload ⇒ SW bấm vào đánh dấu đọc
    // đúng dòng và chuyển đúng công ty. HTTP 200/DUPLICATE không phải bằng chứng đã nhận —
    // callSendPush chỉ đọc outcome và đòi biên nhận khớp khoá của lượt này.
    const data: Record<string, unknown> = { notificationIds: item.notification_ids };
    if (item.organization_id) data.organizationId = item.organization_id;
    const pushed = await callSendPush(fetcher, url, serviceKey, {
      userId: item.user_id, idempotencyKey: item.idempotency_key, notificationIds: item.notification_ids,
      title: item.title, body: item.body, url: item.url, tag: `lifecycle:${item.id}`, data,
    });
    const sent = pushed.outcome === 'SENT' || pushed.outcome === 'PARTIAL' ? pushed.sent : 0;
    await rpcValue(rpc, 'lifecycle_reminder_settle_v1', {
      p_id: item.id, p_lease: item.lease, p_outcome: pushed.outcome, p_sent: sent, p_error: pushed.error,
    });
    state.outcomes[pushed.outcome] = (state.outcomes[pushed.outcome] ?? 0) + 1;
    if ((pushed.outcome === 'SENT' || pushed.outcome === 'PARTIAL') && sent > 0) state.delivered++;
    if (FAILURE_OUTCOMES.has(pushed.outcome)) state.failures.push(`${item.id}: ${pushed.outcome}`);
  }
  return state;
}

export interface PhaseFailure {
  ok: false;
  error: string;
  /** Có khi chính lệnh ghi lifecycle_reminder_record_failure_v1 cũng hỏng. */
  failureLogError: string | null;
}

export type MaintenanceReport = { ok: true; result: unknown } | PhaseFailure;
export type LifecycleReport = LifecyclePhaseState & { ok: boolean; error: string | null; failureLogError: string | null };
export type DrainReport = (DrainResult & { failureLogError: string | null }) | (PhaseFailure & { job: 'push_drain' });

export interface LifecycleRunResult {
  ok: boolean;
  maintenance: MaintenanceReport;
  lifecycle: LifecycleReport;
  drain: DrainReport;
}

async function recordPhaseFailure(rpc: LifecycleRpc, phase: 'maintenance' | 'lifecycle' | 'drain', message: string): Promise<string | null> {
  try {
    await rpcValue(rpc, 'lifecycle_reminder_record_failure_v1', { p_error: `[${phase}] ${message}`.slice(0, 2000) });
    return null;
  } catch (reason) {
    // Không ném: pha sau vẫn phải chạy; ok=false của pha này đã đủ để edge trả 503.
    const text = formatEdgeError(reason);
    console.error('[lifecycle-reminders] ghi lỗi pha thất bại', phase, text);
    return text;
  }
}

/** Server-only. Không phụ thuộc trình duyệt, job tài chính hay lịch Vercel. */
export async function runLifecycleReminders(
  rpc: LifecycleRpc,
  fetcher: FetchLike,
  url: string,
  serviceKey: string,
  drainOptions: DrainOptions = {},
): Promise<LifecycleRunResult> {
  // (a) Bảo trì: chạy TRƯỚC để thông báo đã lỗi thời thành CANCELLED trước khi claim/push.
  let maintenance: MaintenanceReport;
  try {
    maintenance = { ok: true, result: await rpcValue(rpc, 'notification_maintenance_v1') };
  } catch (reason) {
    const error = formatEdgeError(reason);
    maintenance = { ok: false, error, failureLogError: await recordPhaseFailure(rpc, 'maintenance', error) };
  }

  // (b) Lifecycle + họ nhắc server.
  const state: LifecyclePhaseState = { sweep: null, batches: 0, delivered: 0, outcomes: {}, failures: [] };
  let lifecycle: LifecycleReport;
  try {
    await runLifecyclePhase(rpc, fetcher, url, serviceKey, state);
    lifecycle = state.failures.length
      ? { ...state, ok: false, error: null, failureLogError: await recordPhaseFailure(rpc, 'lifecycle', state.failures.join('; ')) }
      : { ...state, ok: true, error: null, failureLogError: null };
  } catch (reason) {
    // Sweep/claim/settle hỏng phải quan sát được và thử lại được ở nhịp sau, không bao giờ là cờ "xong ngày".
    const error = formatEdgeError(reason);
    const detail = state.failures.length ? `${error} | ${state.failures.join('; ')}` : error;
    lifecycle = { ...state, ok: false, error, failureLogError: await recordPhaseFailure(rpc, 'lifecycle', detail) };
  }

  // (c) Drain chung E1–E6.
  let drain: DrainReport;
  try {
    const result = await runGenericPushDrain(rpc, fetcher, url, serviceKey, drainOptions);
    const ok = result.ok && result.failures.length === 0;
    const problems = [result.error, result.recordError && `record_run ${result.recordError}`, result.failures.join('; ')]
      .filter((part): part is string => !!part);
    drain = { ...result, ok, failureLogError: ok ? null : await recordPhaseFailure(rpc, 'drain', problems.join(' | ')) };
  } catch (reason) {
    const error = formatEdgeError(reason);
    drain = { job: 'push_drain', ok: false, error, failureLogError: await recordPhaseFailure(rpc, 'drain', error) };
  }

  return { ok: maintenance.ok && lifecycle.ok && drain.ok, maintenance, lifecycle, drain };
}
