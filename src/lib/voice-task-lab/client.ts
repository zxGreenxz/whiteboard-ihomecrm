import { z } from 'zod';
import { evaluationSchema, extractionSchema, statusSchema, summarySchema, type Evaluation } from './model';

export class LabApiError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); this.name = 'LabApiError'; }
}

async function request(path: string, init: RequestInit = {}, timeoutMs = 90_000): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) throw new DOMException('Đã hủy', 'AbortError');
  init.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`/api${path}`, { ...init, credentials: 'same-origin', signal: controller.signal });
    const payload: unknown = await response.json().catch((error: unknown) => {
      if (isCanceled(error)) throw error;
      throw new LabApiError('Máy chủ trả dữ liệu chưa hợp lệ. Vui lòng thử lại.', response.status);
    });
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(payload);
      throw new LabApiError(parsed.success ? parsed.data.error.message : `Yêu cầu chưa thành công (${response.status}). Vui lòng thử lại.`, response.status);
    }
    return payload;
  } catch (error) {
    if (timedOut) throw new LabApiError('Máy chủ phản hồi quá lâu. Dữ liệu trên màn hình vẫn được giữ; bạn có thể thử lại.');
    if (error instanceof LabApiError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new LabApiError('Không kết nối được máy chủ thử nghiệm. Kiểm tra kết nối và thử lại.');
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LabApiError('Máy chủ trả dữ liệu chưa hợp lệ. Vui lòng thử lại.');
  return result.data;
}

export const labClient = {
  async session(code: string, signal?: AbortSignal) { await request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal }, 15_000); },
  // Provider discovery has a 60-second deadline; allow its capability error to reach the UI.
  async status(signal?: AbortSignal) { return validate(statusSchema, await request('/status', { signal }, 75_000)); },
  async transcribe(blob: Blob, model: string, signal?: AbortSignal) {
    return validate(z.object({ transcript: z.string(), elapsedMs: z.number().nonnegative(), model: z.string() }), await request(`/transcribe?model=${encodeURIComponent(model)}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob, signal }));
  },
  async extract(transcript: string, model: string, signal?: AbortSignal) {
    return validate(extractionSchema, await request('/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript, model, referenceTime: new Date().toISOString(), timeZone: 'Asia/Ho_Chi_Minh' }), signal }));
  },
  async evaluations(signal?: AbortSignal) {
    return validate(z.object({ records: z.array(evaluationSchema.passthrough()), summary: summarySchema }), await request('/evaluations', { signal }, 15_000));
  },
  async save(evaluation: Evaluation, signal?: AbortSignal) {
    await request('/evaluations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evaluationSchema.parse(evaluation)), signal }, 15_000);
  },
  async export(signal?: AbortSignal) { return request('/export', { signal }, 15_000); },
};

export type LabClient = Omit<typeof labClient, 'session'> & { session?: typeof labClient.session };

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Có lỗi khi xử lý. Vui lòng thử lại.'; }
export function isCanceled(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
