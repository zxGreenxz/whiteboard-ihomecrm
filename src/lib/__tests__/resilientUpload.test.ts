// Đường tải chịu mạng điện thoại chập chờn (chủ chốt 03/10/2026). Kiểm phần lõi với
// mạng giả + đồng hồ giả: mạng đứng thì huỷ THẬT rồi tự tải lại; lần trước đã lên mà
// mất trả lời thì 409 + đúng cỡ = xong (đo trên TEST: 409 KeyAlreadyExists); máy chủ
// từ chối hẳn thì không tải lại; người dùng huỷ thì dừng ngay; hết hạn tổng thì báo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  CONNECT_MS,
  MAX_ATTEMPTS,
  STALL_MS,
  responseWaitMs,
  uploadResilient,
  UploadRejectedError,
  type SendRequest,
  type SendResult,
  type UploadDeps,
  type UploadProgress,
} from '../storage/resilientUpload';
import { isAbortError, UploadTimeoutError } from '../uploadDeadline';

const FILE = new File([new Uint8Array(40_000)], 'bill.webp', { type: 'image/webp' });
const KEY = 'u1/1790000000000-abc123-bill.webp';

/** Một lần gửi giả: test quyết định nó nhích byte, xong, hỏng hay đứng im. */
type Kich = (req: SendRequest) => Promise<SendResult>;

const ok: Kich = async (req) => {
  req.onActivity({ loaded: 40_000, total: 40_100, done: false });
  req.onActivity({ loaded: 40_100, total: 40_100, done: true });
  return { status: 200, text: '{"Key":"x"}' };
};
/** Mạng đứng: không bao giờ trả lời, chỉ dừng khi bị huỷ. */
const dungIm: Kich = (req) =>
  new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
const traLoi = (status: number, body: object): Kich => async () => ({ status, text: JSON.stringify(body) });

function deps(kichBan: Kich[], over: Partial<UploadDeps> = {}) {
  const sent: SendRequest[] = [];
  const d: UploadDeps = {
    send: (req) => {
      sent.push(req);
      const k = kichBan.shift();
      if (!k) throw new Error('gửi quá số lần trong kịch bản');
      return k(req);
    },
    getToken: vi.fn(async () => 'token-phien'),
    storedSize: vi.fn(async () => null),
    remove: vi.fn(async () => undefined),
    baseUrl: 'https://kho.test',
    apiKey: 'khoa-cong-khai',
    isOnline: () => true,
    waitOnline: vi.fn(async () => undefined),
    ...over,
  };
  return { d, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('uploadResilient', () => {
  it('a caller-retained durable key resumes its prior upload after matching a first-attempt conflict',async()=>{
    const {d}=deps([traLoi(409,{error:'Duplicate'})],{storedSize:vi.fn(async()=>FILE.size)});
    await expect(uploadResilient('personal-finance-attachments',KEY,FILE,{resumeExisting:true,deleteOnFailure:false},d)).resolves.toMatchObject({path:KEY});
    expect(d.remove).not.toHaveBeenCalled();
    const mismatch=deps([traLoi(409,{error:'Duplicate'})],{storedSize:vi.fn(async()=>FILE.size+1)});
    await expect(uploadResilient('personal-finance-attachments',KEY,FILE,{resumeExisting:true,deleteOnFailure:false},mismatch.d)).rejects.toMatchObject({statusCode:409});
  });
  it('durable personal evidence opts out of physical cleanup after abort and exhaustion', async()=>{
    const ctl=new AbortController();const aborted=deps([dungIm]);
    const result=uploadResilient('personal-finance-attachments',KEY,FILE,{signal:ctl.signal,deleteOnFailure:false},aborted.d).catch(e=>e);
    await vi.advanceTimersByTimeAsync(100);ctl.abort();expect(isAbortError(await result)).toBe(true);expect(aborted.d.remove).not.toHaveBeenCalled();
    const exhausted=deps([], {getToken:()=>new Promise<string|null>(()=>{})});
    const pending=uploadResilient('personal-finance-attachments',KEY,FILE,{deleteOnFailure:false},exhausted.d).catch(e=>e);
    await vi.advanceTimersByTimeAsync(CONNECT_MS*3+2000);expect(await pending).toBeInstanceOf(UploadTimeoutError);expect(exhausted.d.remove).not.toHaveBeenCalled();
  });
  it('gửi đúng multipart như storage-js: khoá, phiên, x-upsert=false; báo % và xong ngay lần đầu', async () => {
    const { d, sent } = deps([ok]);
    const tien: UploadProgress[] = [];
    const kq = await uploadResilient('income-expense-attachments', KEY, FILE, { onProgress: (p) => tien.push(p) }, d);
    expect(kq).toMatchObject({ path: KEY, attempts: 1 });
    expect(sent[0].url).toBe('https://kho.test/storage/v1/object/income-expense-attachments/u1/1790000000000-abc123-bill.webp');
    expect(sent[0].headers).toEqual({ apikey: 'khoa-cong-khai', Authorization: 'Bearer token-phien', 'x-upsert': 'false' });
    expect(sent[0].body.get('cacheControl')).toBe('31536000');
    expect(sent[0].body.get('')).toBeInstanceOf(File);
    expect(tien.map((p) => p.phase)).toEqual(['sending', 'waiting']);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('chưa có phiên: dùng khoá công khai làm Bearer (như supabase-js), để máy chủ tự từ chối theo quyền', async () => {
    const { d, sent } = deps([ok], { getToken: async () => null });
    await uploadResilient('b', KEY, FILE, {}, d);
    expect(sent[0].headers.Authorization).toBe('Bearer khoa-cong-khai');
  });

  it('không nối được (không nhích byte nào): quá CONNECT_MS thì huỷ THẬT lần đó rồi tải lại', async () => {
    const { d, sent } = deps([dungIm, ok]);
    const p = uploadResilient('b', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(CONNECT_MS - 1);
    expect(sent).toHaveLength(1);
    expect(sent[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500); // nghỉ trước lần 2
    await expect(p).resolves.toMatchObject({ attempts: 2 });
  });

  it('đang gửi thì đứng: không nhích byte nào STALL_MS là tải lại (nhích đều thì không bị cắt)', async () => {
    const nhichRoiDung: Kich = (req) => {
      req.onActivity({ loaded: 1_000, total: 40_100, done: false });
      return dungIm(req);
    };
    const { d, sent } = deps([nhichRoiDung, ok]);
    const p = uploadResilient('b', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(sent[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toMatchObject({ attempts: 2 });
  });

  it('gửi xong mà chờ trả lời quá lâu: tải lại; hạn chờ có tính thời gian đẩy tệp ở mạng yếu', async () => {
    const guiXongRoiDung: Kich = (req) => {
      req.onActivity({ loaded: 40_100, total: 40_100, done: true });
      return dungIm(req);
    };
    const { d, sent } = deps([guiXongRoiDung, ok]);
    const p = uploadResilient('b', KEY, FILE, {}, d);
    const han = responseWaitMs(FILE.size);
    expect(han).toBeGreaterThan(8_000);
    await vi.advanceTimersByTimeAsync(han - 1);
    expect(sent[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toMatchObject({ attempts: 2 });
  });

  it('rớt mạng (lỗi mạng) rồi máy chủ 503: tải lại tới lần thứ ba thì được', async () => {
    const rot: Kich = async () => { throw new TypeError('Network request failed'); };
    const { d } = deps([rot, traLoi(503, { statusCode: '503', message: 'busy' }), ok]);
    const tien: UploadProgress[] = [];
    const p = uploadResilient('b', KEY, FILE, { onProgress: (x) => tien.push(x) }, d);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toMatchObject({ attempts: 3 });
    expect(tien.filter((x) => x.phase === 'retrying').map((x) => x.attempt)).toEqual([2, 3]);
  });

  it('lượt CUỐI không bị cắt vì "đứng": mạng rất yếu mà vẫn nhích thì chạy tới hạn tổng, khỏi tải lại từ 0', async () => {
    const chamMaVanToi: Kich = (req) =>
      new Promise((resolve, reject) => {
        req.onActivity({ loaded: 1_000, total: 40_100, done: false });
        // Đứng 10 giây (quá STALL_MS) rồi mới xong.
        const t = setTimeout(() => resolve({ status: 200, text: '{}' }), 10_000);
        req.signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('a', 'AbortError')); });
      });
    const { d, sent } = deps([dungIm, dungIm, chamMaVanToi]);
    const p = uploadResilient('b', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(CONNECT_MS * 2 + 2_000 + 10_000);
    await expect(p).resolves.toMatchObject({ attempts: 3 });
    expect(sent[2].signal.aborted).toBe(false);
  });

  it('lấy phiên bị treo (auth-js chờ khoá không giới hạn): mỗi lượt chỉ chờ CONNECT_MS, hết lượt thì báo — không treo "0%" mãi', async () => {
    const { d, sent } = deps([], { getToken: () => new Promise<string | null>(() => {}) });
    const p = uploadResilient('b', KEY, FILE, {}, d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CONNECT_MS * 3 + 2_000);
    expect(await p).toBeInstanceOf(UploadTimeoutError);
    expect(sent).toHaveLength(0);
  });

  it('gỡ ảnh đúng lúc đang lấy phiên: dừng ngay, KHÔNG gửi tệp đi', async () => {
    const ctl = new AbortController();
    const { d, sent } = deps([ok], { getToken: () => new Promise<string | null>(() => {}) });
    const p = uploadResilient('b', KEY, FILE, { signal: ctl.signal }, d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();
    expect(isAbortError(await p)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('409 ngay lượt đầu: không nhận vơ dù trùng cỡ', async () => {
    const storedSize = vi.fn(async () => FILE.size);
    const { d } = deps([traLoi(400, { statusCode: '409', error: 'Duplicate' })], { storedSize });
    await expect(uploadResilient('b', KEY, FILE, {}, d)).rejects.toMatchObject({ statusCode: 409 });
    expect(storedSize).not.toHaveBeenCalled();
  });

  it('409 mà chưa đọc được cỡ (mạng chập chờn): hỏi lại ở lượt sau rồi mới kết luận', async () => {
    const rot: Kich = async () => { throw new TypeError('Network request failed'); };
    const trung = traLoi(400, { statusCode: '409', error: 'Duplicate' });
    const storedSize = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(FILE.size);
    const { d } = deps([rot, trung, trung], { storedSize });
    const p = uploadResilient('b', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(p).resolves.toMatchObject({ attempts: 3 });
    expect(storedSize).toHaveBeenCalledTimes(2);
  });

  it('navigator.onLine báo sai (WebView/VPN): chỉ chờ có mạng 3 giây rồi vẫn gửi', async () => {
    const waitOnline = vi.fn((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const { d, sent } = deps([ok], { isOnline: () => false, waitOnline });
    const p = uploadResilient('b', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toMatchObject({ attempts: 1 });
    expect(waitOnline).toHaveBeenCalledWith(3_000, expect.any(AbortSignal));
    expect(sent).toHaveLength(1);
  });

  it('lần trước đã lên mà mất trả lời: lần sau nhận 409, kho có đúng cỡ tệp ⇒ coi là xong, không tạo bản trùng', async () => {
    const lenRoiMatTraLoi: Kich = async () => { throw new TypeError('Network request failed'); };
    const storedSize = vi.fn(async () => FILE.size);
    const { d } = deps(
      [lenRoiMatTraLoi, traLoi(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' })],
      { storedSize },
    );
    const p = uploadResilient('income-expense-attachments', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toMatchObject({ path: KEY, attempts: 2 });
    expect(storedSize).toHaveBeenCalledWith('income-expense-attachments', KEY);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('409 mà cỡ trong kho khác: KHÔNG nhận nhầm tệp khác', async () => {
    const rot: Kich = async () => { throw new TypeError('Network request failed'); };
    const { d } = deps(
      [rot, traLoi(400, { statusCode: '409', error: 'Duplicate' })],
      { storedSize: async () => 12 },
    );
    const p = uploadResilient('b', KEY, FILE, {}, d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toMatchObject({ statusCode: 409 });
  });

  it('máy chủ từ chối hẳn (quyền): không tải lại, ném lỗi có mã', async () => {
    const { d, sent } = deps([
      traLoi(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }),
    ]);
    const loi = await uploadResilient('b', KEY, FILE, {}, d).catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(UploadRejectedError);
    expect(loi).toMatchObject({ statusCode: 403 });
    expect(sent).toHaveLength(1);
  });

  it('phiên hết hạn đúng lúc gửi: lấy phiên mới rồi tải lại', async () => {
    const { d } = deps([traLoi(400, { statusCode: '403', error: 'Unauthorized', message: 'jwt expired' }), ok]);
    const p = uploadResilient('b', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toMatchObject({ attempts: 2 });
    expect(d.getToken).toHaveBeenCalledTimes(2);
  });

  it('mất mạng: chờ có mạng lại rồi mới gửi tiếp, không đốt lượt tải', async () => {
    let online = false;
    const waitOnline = vi.fn(async () => { online = true; });
    const rot: Kich = async () => { throw new TypeError('Network request failed'); };
    const { d } = deps([rot, ok], { isOnline: () => online, waitOnline });
    const tien: UploadProgress[] = [];
    const p = uploadResilient('b', KEY, FILE, { onProgress: (x) => tien.push(x) }, d);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toMatchObject({ attempts: 2 });
    expect(waitOnline).toHaveBeenCalled();
    expect(tien.some((x) => x.phase === 'offline')).toBe(true);
  });

  it('người dùng huỷ giữa chừng: dừng ngay, ném AbortError, dọn khoá phòng lần gửi đã kịp lên', async () => {
    const ctl = new AbortController();
    const { d, sent } = deps([dungIm]);
    const p = uploadResilient('b', KEY, FILE, { signal: ctl.signal }, d);
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();
    const loi = await p.catch((e: unknown) => e);
    expect(isAbortError(loi)).toBe(true);
    expect(sent[0].signal.aborted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(d.remove).toHaveBeenCalledWith('b', KEY);
  });

  it(`mạng đứng cả ${MAX_ATTEMPTS} lượt: lượt cuối chờ tới hạn tổng 45 giây rồi báo đúng số giây, dọn lần gửi dở`, async () => {
    const { d, sent } = deps([dungIm, dungIm, dungIm]);
    const p = uploadResilient('b', KEY, FILE, {}, d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(45_000);
    const loi = await p;
    expect(loi).toBeInstanceOf(UploadTimeoutError);
    expect(sent).toHaveLength(MAX_ATTEMPTS);
    expect((loi as UploadTimeoutError).ms).toBe(45_000);
    expect(d.remove).toHaveBeenCalledWith('b', KEY);
  });

  it('mất mạng thật (gửi lỗi và máy báo mất mạng): chờ có mạng tới hạn tổng, không gửi dồn 3 lượt vô ích', async () => {
    const rot: Kich = async () => { throw new TypeError('Network request failed'); };
    const waitOnline = vi.fn((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const { d, sent } = deps([rot], { isOnline: () => false, waitOnline });
    const p = uploadResilient('b', KEY, FILE, {}, d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(46_000);
    const loi = await p;
    expect(loi).toBeInstanceOf(UploadTimeoutError);
    expect(sent).toHaveLength(1);
    // ≈ hạn tổng 45 giây (đồng hồ giả tính vài nhịp 0 ms thành 1 ms).
    expect((loi as UploadTimeoutError).ms).toBeGreaterThanOrEqual(45_000);
    expect((loi as UploadTimeoutError).ms).toBeLessThan(45_100);
  });

  it('đi qua vùng mất sóng 15 giây (thang máy): có mạng lại thì tự tải tiếp, không đốt lượt', async () => {
    let online = true;
    const rotRoiMatSong: Kich = async () => {
      online = false;
      throw new TypeError('Network request failed');
    };
    const waitOnline = vi.fn((ms: number) => new Promise<void>((r) => {
      setTimeout(() => { online = true; r(); }, Math.min(ms, 15_000));
    }));
    const tien: UploadProgress[] = [];
    const { d, sent } = deps([rotRoiMatSong, ok], { isOnline: () => online, waitOnline });
    const p = uploadResilient('b', KEY, FILE, { onProgress: (x) => tien.push(x) }, d);
    await vi.advanceTimersByTimeAsync(15_500);
    await expect(p).resolves.toMatchObject({ attempts: 2 }); // 2 lần gửi thật
    expect(sent).toHaveLength(2);
    expect(tien.some((x) => x.phase === 'offline')).toBe(true);
  });

  it('mất sóng đúng lúc chờ trả lời mà máy chủ ĐÃ lưu: có mạng lại, gửi lại nhận 409 đúng cỡ ⇒ xong, không báo "từ chối"', async () => {
    let online = true;
    const daLuuMaMatTraLoi: Kich = async () => {
      online = false;
      throw new TypeError('Network request failed');
    };
    const waitOnline = vi.fn((ms: number) => new Promise<void>((r) => {
      setTimeout(() => { online = true; r(); }, Math.min(ms, 10_000));
    }));
    const storedSize = vi.fn(async () => FILE.size);
    const { d } = deps(
      [daLuuMaMatTraLoi, traLoi(400, { statusCode: '409', error: 'Duplicate' })],
      { isOnline: () => online, waitOnline, storedSize },
    );
    const p = uploadResilient('b', KEY, FILE, {}, d);
    await vi.advanceTimersByTimeAsync(10_500);
    await expect(p).resolves.toMatchObject({ path: KEY, attempts: 2 });
    expect(storedSize).toHaveBeenCalledWith('b', KEY);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('máy chủ lỗi 5xx cả 3 lượt: báo máy chủ lỗi, không đổ cho mạng chậm', async () => {
    const loi500 = traLoi(500, { statusCode: '500', message: 'internal' });
    const { d } = deps([loi500, loi500, loi500]);
    const p = uploadResilient('b', KEY, FILE, {}, d).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const loi = await p;
    expect(loi).toBeInstanceOf(UploadRejectedError);
    expect(loi).toMatchObject({ statusCode: 500 });
  });
});
