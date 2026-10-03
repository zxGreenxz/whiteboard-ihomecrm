// =============================================================================
// resilientUpload — tải MỘT tệp lên Supabase Storage chịu được mạng điện thoại
// chập chờn (chủ chốt 03/10/2026, "làm sao upload nhanh nhất").
//
// storage-js tải bằng một lệnh fetch duy nhất: không báo %, không huỷ thật được,
// không tự tải lại. Mạng đứng giữa chừng là người dùng ngồi đủ hạn 20 giây rồi
// nhận lỗi và phải chọn lại ảnh — đúng hiện tượng "lúc nhanh lúc chậm, treo".
// Máy chủ thì không chậm: đo trên TEST 03/10/2026, ảnh 45 KB trung vị 232 ms.
//
// Ở đây gọi thẳng REST của Storage (cùng multipart với storage-js) để:
//   • báo % cho ô ảnh (xhr.upload.onprogress);
//   • nhận ra mạng đứng — chưa nối được, không nhích byte nào, hoặc gửi xong mà
//     chờ trả lời quá lâu — rồi huỷ THẬT lần đó và tải lại ngay;
//   • tải lại an toàn: giữ nguyên khoá, `x-upsert: false`. Lần trước thật ra đã
//     lên mà mất trả lời thì lần sau nhận 409 KeyAlreadyExists; hỏi lại cỡ tệp
//     trong kho, đúng cỡ là xong — không tạo bản trùng (đo trên TEST 03/10/2026).
// =============================================================================

import { supabase } from '@/integrations/supabase/client';
import {
  isAbortError,
  resilientUploadDeadlineMs,
  uploadAbortError,
  UploadRejectedError,
  UploadTimeoutError,
} from '../uploadDeadline';

/** Chưa nối được / chưa gửi byte nào trong khoảng này ⇒ coi như mạng đứng. */
export const CONNECT_MS = 8_000;
/** Đang gửi mà không nhích byte nào trong khoảng này ⇒ coi như mạng đứng. */
export const STALL_MS = 6_000;
/**
 * Gửi xong thân mà chờ trả lời quá khoảng này ⇒ coi như mạng đứng. Trình duyệt báo
 * "đã gửi" khi byte mới vào bộ đệm của máy, chưa chắc đã tới máy chủ — nên cộng
 * thêm thời gian đẩy hết tệp ở mạng rất yếu (~32 KB/giây).
 */
export function responseWaitMs(bytes: number): number {
  return 8_000 + Math.ceil(bytes / 32);
}
export const MAX_ATTEMPTS = 3;
/** Nghỉ trước lần tải lại thứ 2, thứ 3. */
const BACKOFF_MS = [500, 1_500];

export type UploadPhase = 'sending' | 'waiting' | 'retrying' | 'offline';

export interface UploadProgress {
  loaded: number;
  total: number;
  /** Lần tải thứ mấy (bắt đầu từ 1). */
  attempt: number;
  phase: UploadPhase;
}

export interface ResilientUploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  /** Huỷ thật lệnh tải (gỡ ảnh, đóng hộp). Ném AbortError. */
  signal?: AbortSignal;
}

export interface ResilientUploadResult {
  path: string;
  attempts: number;
  elapsedMs: number;
}

export { UploadRejectedError };

export interface SendActivity {
  loaded: number;
  total: number;
  /** Đã gửi hết thân, đang chờ máy chủ trả lời. */
  done: boolean;
}

export interface SendRequest {
  url: string;
  headers: Record<string, string>;
  body: FormData;
  signal: AbortSignal;
  onActivity: (activity: SendActivity) => void;
}

export interface SendResult {
  status: number;
  text: string;
}

/** Phần chạm mạng/phiên — tách ra để test thay bằng bản giả. */
export interface UploadDeps {
  send: (request: SendRequest) => Promise<SendResult>;
  getToken: () => Promise<string | null>;
  /** Cỡ tệp đang nằm ở khoá này trong kho; null = không có hoặc không đọc được. */
  storedSize: (bucket: string, key: string) => Promise<number | null>;
  remove: (bucket: string, key: string) => Promise<void>;
  baseUrl: string;
  apiKey: string;
  isOnline: () => boolean;
  /** Chờ có mạng lại, tối đa `ms`. */
  waitOnline: (ms: number, signal: AbortSignal) => Promise<void>;
}

type AttemptOutcome =
  | { kind: 'ok' }
  | { kind: 'conflict' }
  | { kind: 'retry'; status: number | null }
  | { kind: 'reject'; error: UploadRejectedError };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(uploadAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(uploadAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseFailure(result: SendResult): { status: number; message: string } {
  try {
    const body = JSON.parse(result.text) as { statusCode?: unknown; message?: unknown; error?: unknown };
    const status = Number(body.statusCode) || result.status;
    const message = [body.error, body.message].filter((v) => typeof v === 'string').join(': ');
    return { status, message: message || `HTTP ${result.status}` };
  } catch {
    return { status: result.status, message: `HTTP ${result.status}` };
  }
}

/** Phiên hết hạn đúng lúc gửi: lấy phiên mới rồi tải lại là được. */
function isExpiredToken(status: number, message: string): boolean {
  return [400, 401, 403].includes(status) && /jwt|token|expired/i.test(message);
}

function objectUrl(baseUrl: string, bucket: string, key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl.replace(/\/+$/, '')}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`;
}

const TIMED_OUT = Symbol('timed-out');

/**
 * Chờ `work` tối đa `ms`, dừng ngay khi `signal` huỷ. Dùng cho các bước KHÔNG tự có
 * hạn (lấy phiên — auth-js chờ khoá không giới hạn; hỏi cỡ tệp): kẹt ở đó thì ô ảnh
 * đứng "0%" mãi và chiếm chỗ tải.
 */
function within<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(uploadAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(uploadAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(TIMED_OUT);
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** `navigator.onLine` có thể báo sai (WebView, VPN): chỉ chờ có mạng chừng này rồi vẫn gửi. */
const OFFLINE_WAIT_MS = 3_000;

async function attemptOnce(
  deps: UploadDeps,
  url: string,
  file: File,
  token: string | null,
  attempt: number,
  outer: AbortSignal,
  deadlineAt: number,
  onProgress: ((progress: UploadProgress) => void) | undefined,
): Promise<AttemptOutcome> {
  // Listener gắn lên signal ĐÃ huỷ không bao giờ chạy ⇒ phải kiểm trước.
  if (outer.aborted) throw uploadAbortError();
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outer.addEventListener('abort', onOuterAbort, { once: true });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Lượt cuối không cắt vì "đứng": mạng rất yếu mà vẫn nhích thì cho chạy tới hạn tổng,
  // khỏi tải lại từ 0 byte lần nữa.
  const lastAttempt = attempt >= MAX_ATTEMPTS;
  const arm = (ms: number) => {
    clearTimeout(timer);
    const remaining = deadlineAt - Date.now();
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, Math.max(0, lastAttempt ? remaining : Math.min(ms, remaining)));
  };
  arm(CONNECT_MS);

  const body = new FormData();
  body.append('cacheControl', '31536000');
  body.append('', file);

  try {
    const result = await deps.send({
      url,
      headers: {
        apikey: deps.apiKey,
        Authorization: `Bearer ${token ?? deps.apiKey}`,
        'x-upsert': 'false',
      },
      body,
      signal: controller.signal,
      onActivity: ({ loaded, total, done }) => {
        onProgress?.({ loaded, total: total || file.size, attempt, phase: done ? 'waiting' : 'sending' });
        arm(done ? responseWaitMs(file.size) : STALL_MS);
      },
    });
    if (result.status >= 200 && result.status < 300) return { kind: 'ok' };
    const failure = parseFailure(result);
    if (failure.status === 409) return { kind: 'conflict' };
    if (failure.status >= 500 || [408, 425, 429].includes(failure.status) || isExpiredToken(failure.status, failure.message)) {
      return { kind: 'retry', status: failure.status };
    }
    return { kind: 'reject', error: new UploadRejectedError(failure.status, failure.message) };
  } catch (error) {
    if (outer.aborted) throw uploadAbortError();
    // Mạng đứng (đồng hồ huỷ) hoặc rớt mạng (xhr.onerror): tải lại.
    if (stalled || !isAbortError(error)) return { kind: 'retry', status: null };
    throw error;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Tải `file` vào `bucket/key`. Trả về khi máy chủ đã xác nhận tệp nằm trong kho.
 * Ném: AbortError (người dùng huỷ), UploadRejectedError (máy chủ từ chối hẳn),
 * UploadTimeoutError (hết lượt tải lại hoặc quá hạn tổng — tệp KHÔNG được ghi nhận).
 */
export async function uploadResilient(
  bucket: string,
  key: string,
  file: File,
  options: ResilientUploadOptions = {},
  deps: UploadDeps = browserDeps(),
): Promise<ResilientUploadResult> {
  const started = Date.now();
  const deadlineAt = started + resilientUploadDeadlineMs(file.size);
  const outer = options.signal ?? new AbortController().signal;
  const report = options.onProgress;
  const url = objectUrl(deps.baseUrl, bucket, key);
  if (outer.aborted) throw uploadAbortError();

  /** Dọn khoá của lần gửi dở — hỏng thì chỉ để lại một tệp rác, không chặn người dùng. */
  const cleanup = () => {
    void deps.remove(bucket, key).catch((error: unknown) => {
      console.warn('[tai-anh] không dọn được lần gửi dở:', key, error);
    });
  };

  let lastStatus: number | null = null;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        report?.({ loaded: 0, total: file.size, attempt, phase: 'retrying' });
        await sleep(Math.min(BACKOFF_MS[attempt - 2] ?? 1_500, deadlineAt - Date.now()), outer);
      }
      if (!deps.isOnline()) {
        report?.({ loaded: 0, total: file.size, attempt, phase: 'offline' });
        await deps.waitOnline(Math.min(OFFLINE_WAIT_MS, deadlineAt - Date.now()), outer);
      }
      if (Date.now() >= deadlineAt) break;

      const token = await within(deps.getToken(), Math.min(CONNECT_MS, deadlineAt - Date.now()), outer);
      if (token === TIMED_OUT) {
        lastStatus = null; // lấy phiên kẹt: tính như một lượt đứng mạng
        continue;
      }
      const outcome = await attemptOnce(deps, url, file, token, attempt, outer, deadlineAt, report);
      if (outcome.kind === 'ok') return { path: key, attempts: attempt, elapsedMs: Date.now() - started };
      if (outcome.kind === 'reject') throw outcome.error;
      if (outcome.kind === 'conflict') {
        // Lượt đầu mà trùng khoá (có đuôi ngẫu nhiên) là chuyện lạ: không nhận vơ.
        if (attempt === 1) throw new UploadRejectedError(409, 'Đã có tệp khác cùng tên trong kho');
        // Từ lượt 2: trùng nghĩa là CHÍNH tệp này đã lên ở lượt trước mà mất trả lời.
        const size = await within(
          deps.storedSize(bucket, key).catch((): null => null),
          Math.min(CONNECT_MS, deadlineAt - Date.now()),
          outer,
        );
        if (size === file.size) return { path: key, attempts: attempt, elapsedMs: Date.now() - started };
        // Chưa đọc được cỡ (mạng chập chờn): hỏi lại ở lượt sau; hết lượt thì dọn khoá.
        if (size === null || size === TIMED_OUT) {
          lastStatus = null;
          continue;
        }
        throw new UploadRejectedError(409, 'Đã có tệp khác cùng tên trong kho');
      }
      lastStatus = outcome.status;
      // Rớt mạng mà máy cũng báo đang mất mạng: chờ có mạng tới hết hạn tổng, KHÔNG tính
      // lượt — đi qua thang máy, vùng mất sóng 15 giây vẫn tự tải tiếp.
      if (outcome.status === null && !deps.isOnline()) {
        report?.({ loaded: 0, total: file.size, attempt, phase: 'offline' });
        await deps.waitOnline(deadlineAt - Date.now(), outer);
        if (deps.isOnline()) attempt -= 1;
      }
    }
  } catch (error) {
    // Huỷ giữa chừng: lần gửi cuối có thể đã kịp lên — dọn cho khỏi rác.
    if (isAbortError(error)) cleanup();
    throw error;
  }

  // Hết lượt: lần cuối có thể vẫn kịp lên sau khi bị huỷ — dọn, người dùng sẽ tải lại tên mới.
  cleanup();
  if (lastStatus !== null && lastStatus >= 500) {
    throw new UploadRejectedError(lastStatus, 'Máy chủ lưu trữ đang lỗi');
  }
  throw new UploadTimeoutError(Math.max(1_000, Date.now() - started));
}

// ── Bản chạy trên trình duyệt ────────────────────────────────────────────────

function xhrSend(request: SendRequest): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(uploadAbortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let last = { loaded: 0, total: 0 };
    const onAbort = () => xhr.abort();
    const settle = () => request.signal.removeEventListener('abort', onAbort);
    request.signal.addEventListener('abort', onAbort, { once: true });
    xhr.open('POST', request.url, true);
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      last = { loaded: event.loaded, total: event.lengthComputable ? event.total : 0 };
      request.onActivity({ ...last, done: false });
    };
    xhr.upload.onload = () => request.onActivity({ loaded: last.total || last.loaded, total: last.total, done: true });
    xhr.onload = () => {
      settle();
      resolve({ status: xhr.status, text: xhr.responseText });
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError('Network request failed'));
    };
    xhr.onabort = () => {
      settle();
      reject(uploadAbortError());
    };
    xhr.send(request.body);
  });
}

function waitOnline(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      reject(uploadAbortError());
    };
    const timer = setTimeout(done, Math.max(0, ms));
    window.addEventListener('online', done, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function browserDeps(): UploadDeps {
  return {
    send: xhrSend,
    getToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
    storedSize: async (bucket, key) => {
      const { data, error } = await supabase.storage.from(bucket).info(key);
      if (error || !data) return null;
      return typeof data.size === 'number' ? data.size : null;
    },
    remove: async (bucket, key) => {
      // remove() báo lỗi qua `error`, không ném — phải đọc mới biết dọn hỏng.
      const { error } = await supabase.storage.from(bucket).remove([key]);
      if (error) throw error;
    },
    baseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
    apiKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    waitOnline,
  };
}

let warmedAt = 0;

/**
 * Chuẩn bị đường tải TRƯỚC khi người dùng chọn xong ảnh (mở hộp, bấm "Thêm chứng
 * từ"): làm mới phiên nếu sắp hết hạn và mở sẵn kết nối tới máy chủ. App vừa nằm
 * nền thì lần tải đầu đỡ được khoảng một giây bắt tay mạng (đo TEST: 971 ms lạnh).
 * Không bao giờ ném.
 */
export function warmUploadConnection(): void {
  const now = Date.now();
  if (now - warmedAt < 15_000) return;
  warmedAt = now;
  try {
    void supabase.auth.getSession().catch(() => {
      /* chỉ là bước chuẩn bị: lệnh tải tự lấy phiên lại và báo lỗi nếu có */
    });
  } catch {
    // Không có phiên/khách giả lập: chỉ là bước chuẩn bị, bỏ qua.
  }
  try {
    const base = import.meta.env.VITE_SUPABASE_URL;
    if (!base || typeof document === 'undefined') return;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = new URL(base).origin;
    // Lệnh tải không gửi cookie ⇒ dùng chung nhóm kết nối "anonymous".
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
    setTimeout(() => link.remove(), 10_000);
  } catch {
    // URL cấu hình hỏng: bỏ qua, lệnh tải tự mở kết nối như thường.
  }
}
