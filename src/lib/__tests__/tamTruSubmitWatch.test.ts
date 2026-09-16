// @vitest-environment jsdom
// Bộ bắt mã hồ sơ (extensions/tam-tru/submit-watch.js). Thân request mẫu dựng
// theo đúng gói THẬT cổng gửi khi chủ bấm Nộp ngày 16/09/2026.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WATCH = readFileSync(resolve(process.cwd(), 'extensions/tam-tru/submit-watch.js'), 'utf8');

interface Watcher { (body: string): Record<string, string> | null }

function goiNop(over: Record<string, unknown> = {}, subm: Record<string, unknown> = {}): string {
  const data = {
    is_send: '1',
    RECEIVE_ORG_ADDRESS: 'Công an Phường Hạnh Thông',
    TEMP_RESIDENT_FROM: '16/09/2026',
    TEMP_RESIDENT_TO: '14/09/2028',
    SUBM_INFO: { SUBM_CODE: 'G01.899.909-260916-890028', PROC_NAME: 'Đăng ký tạm trú' },
    ...subm,
  };
  return 'params=' + encodeURIComponent(JSON.stringify({
    type: 'add', provider: 'default', service: 'add_subm_info_v2', SUBM_DATA: data, ...over,
  }));
}

function nap(): { boc: Watcher; tin: unknown[] } {
  const tin: unknown[] = [];
  window.addEventListener('message', (e) => tin.push(e.data));
  new Function(WATCH)();
  return { boc: (window as unknown as { __ihomeTamTruBocMa: Watcher }).__ihomeTamTruBocMa, tin };
}

beforeEach(() => {
  delete (window as unknown as { __ihomeTamTruTheoDoiNop?: boolean }).__ihomeTamTruTheoDoiNop;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-16T02:25:16Z'));
});
afterEach(() => vi.useRealTimers());

describe('bóc mã hồ sơ từ gói nộp', () => {
  it('lấy đúng mã, cơ quan và thời hạn của lượt NỘP', () => {
    const { boc } = nap();
    expect(boc(goiNop())).toEqual({
      submCode: 'G01.899.909-260916-890028',
      receiveOrg: 'Công an Phường Hạnh Thông',
      tempResidentFrom: '16/09/2026',
      tempResidentTo: '14/09/2028',
      submittedAt: '2026-09-16T02:25:16.000Z',
    });
  });

  it('đọc được cả khi SUBM_DATA là chuỗi JSON (cổng gửi kiểu này)', () => {
    const { boc } = nap();
    const body = 'params=' + encodeURIComponent(JSON.stringify({
      service: 'add_subm_info_v2',
      SUBM_DATA: JSON.stringify({ is_send: '1', SUBM_INFO: JSON.stringify({ SUBM_CODE: 'G01.899.909-260916-890025' }) }),
    }));
    expect(boc(body)).toMatchObject({ submCode: 'G01.899.909-260916-890025' });
  });

  it('BỎ QUA lượt Lưu nháp — chỉ hồ sơ đã nộp mới vào sổ', () => {
    const { boc } = nap();
    expect(boc(goiNop({}, { is_send: '0' }))).toBeNull();
    expect(boc(goiNop({}, { is_send: undefined }))).toBeNull();
  });

  it('bỏ qua service khác và thân request không đọc được', () => {
    const { boc } = nap();
    expect(boc('params=' + encodeURIComponent(JSON.stringify({ service: 'search_subm_info2' })))).toBeNull();
    expect(boc('rác')).toBeNull();
    expect(boc('')).toBeNull();
  });

  it('bỏ qua mã rỗng hoặc trông không phải mã hồ sơ', () => {
    const { boc } = nap();
    expect(boc(goiNop({}, { SUBM_INFO: { SUBM_CODE: '' } }))).toBeNull();
    expect(boc(goiNop({}, { SUBM_INFO: { SUBM_CODE: 'x' } }))).toBeNull();
    expect(boc(goiNop({}, { SUBM_INFO: { SUBM_CODE: '<script>' } }))).toBeNull();
  });
});

describe('vá XMLHttpRequest', () => {
  // postMessage của jsdom đi qua vòng lặp sự kiện thật, nên mục này dùng đồng hồ thật.
  beforeEach(() => vi.useRealTimers());
  const nhip = () => new Promise((r) => setTimeout(r, 0));
  class XhrGia {
    static duocGoi: XhrGia[] = [];
    status = 200;
    responseText = '{"MSG_CODE":"OK"}';
    private nghe: Record<string, (() => void)[]> = {};
    open() { /* bị vá ghi đè */ }
    send() { /* bị vá ghi đè */ }
    addEventListener(ev: string, fn: () => void) { (this.nghe[ev] ||= []).push(fn); }
    phat(ev: string) { (this.nghe[ev] ?? []).forEach((f) => f()); }
  }

  it('báo mã sau khi cổng trả lời thành công, không báo khi lỗi', async () => {
    vi.stubGlobal('XMLHttpRequest', XhrGia);
    const { tin } = nap();
    const goi = (status: number, responseText: string) => {
      const x = new (window as unknown as { XMLHttpRequest: new () => XhrGia }).XMLHttpRequest();
      (x as unknown as { open: (m: string, u: string) => void }).open('POST', 'https://dichvucong.dancuquocgia.gov.vn/portal/util/rest_exec?csrt=1');
      (x as unknown as { send: (b: string) => void }).send(goiNop());
      x.status = status;
      x.responseText = responseText;
      x.phat('load');
      return x;
    };
    goi(200, '{"MSG_CODE":"OK"}');
    await nhip();
    expect(tin.filter((t) => (t as { type: string }).type === 'IHOME_TAMTRU_DA_NOP')).toHaveLength(1);
    goi(500, '{"MSG_CODE":"ERROR"}');
    goi(200, '{"MSG_CODE":"ERROR"}');
    await nhip();
    expect(tin.filter((t) => (t as { type: string }).type === 'IHOME_TAMTRU_DA_NOP')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('không đụng tới request không phải rest_exec', async () => {
    vi.stubGlobal('XMLHttpRequest', XhrGia);
    const { tin } = nap();
    const x = new (window as unknown as { XMLHttpRequest: new () => XhrGia }).XMLHttpRequest();
    (x as unknown as { open: (m: string, u: string) => void }).open('GET', 'https://dichvucong.dancuquocgia.gov.vn/portal/anh.png');
    (x as unknown as { send: (b?: string) => void }).send(goiNop());
    x.phat('load');
    await nhip();
    expect(tin).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
