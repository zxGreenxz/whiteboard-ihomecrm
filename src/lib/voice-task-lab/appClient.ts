import { z } from 'zod';
import { extractionSchema, statusSchema } from './model';
import { isCanceled, LabApiError, type LabClient } from './client';
import { createLocalEvaluations } from './localEvaluations';

type Session = { access_token: string; user: { id: string } } | null;
type Options = { userId: string; organizationId: string; getSession: () => Promise<Session>; storage: Pick<Storage, 'getItem' | 'setItem'>; fetcher?: typeof fetch };
const canceled = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Đã hủy', 'AbortError'); };

export function createAppLabClient({ userId, organizationId, getSession, storage, fetcher = fetch }: Options): LabClient {
  const evaluations = createLocalEvaluations(storage, userId, organizationId);
  async function authorize(signal?: AbortSignal) {
    canceled(signal);
    const session = await getSession();
    canceled(signal);
    if (!session?.access_token || session.user.id !== userId) throw new LabApiError('Phiên đăng nhập đã thay đổi. Hãy mở lại trang thử nghiệm từ CRM.', 401);
    return session.access_token;
  }
  async function request<T>(schema: z.ZodType<T>, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = await authorize(signal);
    canceled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    // Covers auth + discovery + extraction inside the deployed function's 90-second budget.
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 95_000);
    try {
      const response = await fetcher('/api/voice-task-lab', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, organizationId }), signal: controller.signal });
      const data: unknown = await response.json().catch((error: unknown) => {
        if (isCanceled(error)) throw error;
        throw new LabApiError('Máy chủ trả dữ liệu chưa hợp lệ. Vui lòng thử lại.', response.status);
      });
      canceled(signal);
      if (!response.ok) {
        const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(data);
        throw new LabApiError(error.success ? error.data.error.message : 'Chưa xử lý được yêu cầu. Vui lòng thử lại.', response.status);
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new LabApiError('Máy chủ trả dữ liệu chưa hợp lệ. Vui lòng thử lại.');
      return parsed.data;
    } catch (error) {
      if (timedOut) throw new LabApiError('Máy chủ phản hồi quá lâu. Hãy thử lại; bản ghi trên màn hình vẫn được giữ.');
      if (error instanceof LabApiError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new LabApiError('Không kết nối được máy chủ thử nghiệm. Kiểm tra kết nối rồi thử lại.');
    } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    status: signal => request(statusSchema, { action: 'status' }, signal),
    extract: (transcript, model, signal) => request(extractionSchema, { action: 'extract', transcript, model, referenceTime: new Date().toISOString(), timeZone: 'Asia/Ho_Chi_Minh' }, signal),
    async transcribe(blob, model, signal) {
      if (!blob.size || blob.size > 2 * 1024 * 1024) throw new LabApiError('Bản ghi cần nhỏ hơn hoặc bằng 2 MiB. Hãy ghi lại ngắn hơn.');
      canceled(signal);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      canceled(signal);
      let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return request(z.object({ transcript: z.string(), elapsedMs: z.number().nonnegative(), model: z.string() }), { action: 'transcribe', audioBase64: btoa(binary), contentType: blob.type, model }, signal);
    },
    async evaluations(signal) { await authorize(signal); canceled(signal); return evaluations.list(); },
    async save(evaluation, signal) { await authorize(signal); canceled(signal); evaluations.save(evaluation); },
    async export(signal) { await authorize(signal); canceled(signal); return { ...evaluations.list(), exportedAt: new Date().toISOString(), storage: 'device', userId, organizationId }; },
  };
}
