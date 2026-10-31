import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { HermesCallerScope } from './connectionClient';

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
// SQL to_char(... 'US') luôn trả đúng 6 chữ số phần triệu giây; con trỏ lịch sử cần đủ độ chính xác đó.
const isoMicro = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => Number.isFinite(Date.parse(value)));
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Giới hạn SQL (char_length) đếm theo code point; `.length` UTF-16 đếm emoji hai lần.
const codePoints = (value: string) => Array.from(value).length;
const bounded = (max: number) => z.string().refine(value => codePoints(value) <= max);
const kind = z.enum(['skill_crm_write', 'memory_crm_write']);
const status = z.enum(['pending', 'approved', 'rejected']);
const decisionValue = z.enum(['approve', 'reject']);
const seqNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const profileName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const proposal = z.object({
  id: uuid, seq: seqNumber, kind, profile: profileName, userId: uuid, userName: bounded(120).nullable(),
  // Không đặt thêm luật nội dung chặt hơn CHECK của SQL: dòng đề xuất bất biến, một dòng "lạ" không được làm hỏng cả danh sách.
  // Lịch sử trả nội dung rút gọn (≤ 300 ký tự, `contentTruncated`) và không kèm nguồn — trang đọc luôn dưới trần 1 MiB.
  title: bounded(200), content: bounded(4000), contentTruncated: z.boolean(),
  source: z.record(z.string(), z.unknown()), detectedAt: isoMicro, status,
  decidedBy: uuid.nullable(), decidedByName: bounded(120).nullable(), decidedAt: isoMicro.nullable(), note: bounded(500).nullable(),
  via: z.enum(['crm_ui', 'hermes_connector']).nullable(), redactedAt: isoMicro.nullable(),
}).strict().refine(value => (value.status === 'pending') === (value.decidedAt === null && value.decidedBy === null && value.via === null)
  && (value.status !== 'pending' || (value.note === null && value.redactedAt === null)));
const cursor = z.object({ decidedAt: isoMicro, id: uuid }).strict();
// "Lần kiểm cuối" của từng hồ sơ trợ lý: job kiểm học tập trên máy chủ Hermes ghi mỗi lần chạy (kể cả không có đề xuất).
const audit = z.object({ profile: profileName, userId: uuid, userName: bounded(120).nullable(), generatedAt: isoMicro, receivedAt: isoMicro }).strict();
const snapshot = z.object({
  organizationId: uuid, canDecide: z.literal(true), pendingCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pending: z.array(proposal).max(20), nextPendingAfterSeq: seqNumber.nullable(),
  history: z.array(proposal).max(20), nextHistoryCursor: cursor.nullable(), audits: z.array(audit).max(20),
}).strict().refine(value => value.pending.every(item => item.status === 'pending' && !item.contentTruncated)
  && value.history.every(item => item.status !== 'pending')
  && value.pending.every((item, index) => index === 0 || item.seq > value.pending[index - 1].seq)
  && (value.nextPendingAfterSeq === null || value.nextPendingAfterSeq === value.pending[value.pending.length - 1]?.seq)
  && new Set([...value.pending, ...value.history].map(item => item.id)).size === value.pending.length + value.history.length);
const decided = z.object({ organizationId: uuid, decision: decisionValue, replayed: z.boolean(), proposals: z.array(proposal).min(1).max(20) }).strict();
const note = z.string().refine(value => value.trim() !== '' && codePoints(value.trim()) <= 500 && !controls.test(value));
const decideInput = z.object({
  requestId: uuid, proposalIds: z.array(uuid).min(1).max(20).refine(ids => new Set(ids).size === ids.length),
  decision: decisionValue, note: note.nullable(),
}).strict();

export type HermesLearningProposal = z.infer<typeof proposal>;
export type HermesLearningAudit = z.infer<typeof audit>;
export type HermesLearningSnapshot = z.infer<typeof snapshot>;
export type HermesLearningCursor = z.infer<typeof cursor>;
export type HermesLearningDecision = z.infer<typeof decided>;
export type HermesLearningDecideInput = z.infer<typeof decideInput>;
export type HermesLearningErrorCode = 'invalid_request' | 'forbidden' | 'conflict' | 'not_supported' | 'reauthentication_required'
  | 'context_changed' | 'cancelled' | 'timeout' | 'invalid_response' | 'backend_unavailable' | 'decision_outcome_unknown';
export class HermesLearningError extends Error {
  /** `outcomeUnknown`: thao tác ghi đã có thể tới máy chủ; chỉ được gửi lại với CÙNG requestId. */
  constructor(readonly code: HermesLearningErrorCode, readonly outcomeUnknown = false) { super(code); }
}
interface Session { data: { session: { access_token: string; user: { id: string } } | null }; error: unknown }
interface Options {
  userId: string; organizationId: string; currentScope: () => HermesCallerScope;
  getSession?: () => Promise<Session>; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}
const MAX_BYTES = 1_048_576;

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (response.redirected || !response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => { /* Phản hồi lệch khuôn đã bị từ chối. */ }); throw new Error('invalid_response');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => { /* Phản hồi đã huỷ không thể thành công. */ }); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (signal.aborted) throw new Error('cancelled');
      if (next.done) {
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
      }
      bytes += next.value.byteLength; if (bytes > MAX_BYTES) throw new Error('invalid_response'); chunks.push(next.value);
    }
    throw new Error('cancelled');
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch { /* Luồng đã huỷ còn đang đóng. */ } }
}

/** JWT người dùng CRM. Đọc/duyệt đề xuất bài học của trợ lý Hermes trong công ty đang chọn; quyền do SQL quyết định
 * (users.edit). Không tự gửi lại thao tác ghi: mất phản hồi ⇒ báo "chưa rõ", chỉ lặp lại cùng requestId. */
export function createHermesLearningClient({ userId, organizationId, currentScope, getSession = () => supabase.auth.getSession(),
  fetch: request = globalThis.fetch.bind(globalThis), timeoutMs = 30000 }: Options) {
  if (!uuid.safeParse(userId).success || !uuid.safeParse(organizationId).success || typeof currentScope !== 'function' ||
      typeof getSession !== 'function' || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('invalid_learning_client');
  }
  async function invoke(write: boolean, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let dispatched = false;
    const failure = (code: HermesLearningErrorCode, unknown = write && dispatched) =>
      new HermesLearningError(unknown ? 'decision_outcome_unknown' : code, unknown);
    if (signal?.aborted) throw failure('cancelled');
    const caller = { ...currentScope() };
    const checkScope = () => {
      const now = currentScope();
      if (caller.userId !== userId || caller.organizationId !== organizationId || !Number.isSafeInteger(caller.generation) || caller.generation < 0 ||
          now.userId !== userId || now.organizationId !== organizationId || now.generation !== caller.generation) throw failure('context_changed');
    };
    checkScope();
    const controller = new AbortController(); let stopped = false;
    let rejectStop: (error: HermesLearningError) => void = () => {};
    const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (code: 'cancelled' | 'timeout') => { if (stopped) return; stopped = true; rejectStop(failure(code)); controller.abort(); };
    const cancel = () => stop('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const check = () => { checkScope(); if (stopped) throw failure('cancelled'); };
    const work = async () => {
      check(); const result = await getSession(); check(); const session = result.data.session;
      if (result.error || !session || session.user.id !== userId || session.access_token.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session.access_token)) throw failure('reauthentication_required', false);
      const base = import.meta.env.VITE_SUPABASE_URL, apiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (typeof base !== 'string' || !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(base) || typeof apiKey !== 'string' || !apiKey || apiKey.length > 16384) {
        throw failure('backend_unavailable', false);
      }
      const body = JSON.stringify({ p: { organizationId, ...payload } });
      if (new TextEncoder().encode(body).byteLength > 16384) throw failure('invalid_request', false);
      check(); dispatched = true;
      const response = await request(`${base.replace(/\/$/, '')}/rest/v1/rpc/${write ? 'hermes_learning_decide_v1' : 'hermes_learning_review_v1'}`, {
        method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${session.access_token}`, apikey: apiKey, 'content-type': 'application/json', accept: 'application/json',
          'accept-profile': 'public', 'content-profile': 'public', 'x-organization-id': organizationId }, body, signal: controller.signal,
      });
      check();
      if (response.status === 401) { void response.body?.cancel().catch(() => { /* Phản hồi bị từ chối. */ }); throw failure('reauthentication_required', false); }
      const raw = await readJson(response, controller.signal); check();
      if (response.status !== 200) {
        const error = z.object({ code: z.string() }).passthrough().safeParse(raw);
        // Lỗi xác định: máy chủ đã lùi giao dịch, quyết định chưa được ghi.
        if (error.success) {
          const { code } = error.data;
          if (code === '42501' && response.status === 403) throw failure('forbidden', false);
          if (code === 'PT409' && response.status === 409) throw failure('conflict', false);
          if (code === '22023' && response.status === 400) throw failure('invalid_request', false);
          if (code === 'PGRST202' && response.status === 404) throw failure('not_supported', false);
          if (code === 'PGRST301') throw failure('reauthentication_required', false);
        }
        throw failure('backend_unavailable');
      }
      return raw;
    };
    try { return await Promise.race([work(), stopPromise]); }
    catch (error) {
      if (error instanceof HermesLearningError) throw error;
      throw failure(stopped ? 'cancelled' : 'backend_unavailable');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
  }
  return {
    /** Trang đọc: `historyCursor` = trang lịch sử tiếp theo; `pendingAfterSeq` = các đề xuất chờ có số lớn hơn (trang chờ tiếp theo). */
    review: async (historyCursor: HermesLearningCursor | null, options?: { signal?: AbortSignal; pendingAfterSeq?: number | null }):
      Promise<HermesLearningSnapshot> => {
      const pendingAfterSeq = options?.pendingAfterSeq ?? null;
      if ((historyCursor !== null && !cursor.safeParse(historyCursor).success)
        || (pendingAfterSeq !== null && !seqNumber.safeParse(pendingAfterSeq).success)) throw new HermesLearningError('invalid_request');
      const raw = await invoke(false, { historyCursor, pendingAfterSeq }, options?.signal);
      const parsed = snapshot.safeParse(raw);
      if (!parsed.success || parsed.data.organizationId !== organizationId
        || (pendingAfterSeq !== null && parsed.data.pending.some(item => item.seq <= pendingAfterSeq))) throw new HermesLearningError('invalid_response');
      return parsed.data;
    },
    decide: async (input: HermesLearningDecideInput, options?: { signal?: AbortSignal }): Promise<HermesLearningDecision> => {
      const parsed = decideInput.safeParse(input);
      if (!parsed.success) throw new HermesLearningError('invalid_request');
      const want = { ...parsed.data, note: parsed.data.note === null ? null : parsed.data.note.trim() };
      const raw = await invoke(true, want, options?.signal);
      const result = decided.safeParse(raw);
      const expected = want.decision === 'approve' ? 'approved' : 'rejected';
      if (!result.success || result.data.organizationId !== organizationId || result.data.decision !== want.decision
        || result.data.proposals.length !== want.proposalIds.length
        || !result.data.proposals.every(item => want.proposalIds.includes(item.id) && item.status === expected && item.note === want.note && item.via === 'crm_ui')) {
        // Phản hồi 200 lệch khuôn sau khi đã gửi lệnh ghi: không chắc đã ghi gì ⇒ coi như chưa rõ kết cục.
        throw new HermesLearningError('decision_outcome_unknown', true);
      }
      return result.data;
    },
  };
}
