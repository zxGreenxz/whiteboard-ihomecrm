import { describe, expect, it } from 'vitest';
import { hermesActivation } from './activation';
import type { HermesConnectionMetadata, HermesConnectorStatus } from './connectionClient';

const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const LINKED = '33333333-3333-4333-8333-333333333333', OTHER = '66666666-6666-4666-8666-666666666666';
const ASSISTANT = '44444444-4444-4444-8444-444444444444';
const STARTED = 1_000, SUCCESS = 2_000, FAILED = 3_000;
const row = (id: string, state: HermesConnectionMetadata['state'] = 'active'): HermesConnectionMetadata => ({ id, assistantId: ASSISTANT,
  organizationId: ORG, userId: USER, state, epoch: 1, restrictions: { read: [], action: [] }, scopeIds: [] });
type Activity = HermesConnectorStatus['connections'][number];
const seen = (id: string, change: Partial<Activity> = {}): Activity => ({ id, lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: null, lastErrorAt: null, ...change });
const status = (...connections: Activity[]): HermesConnectorStatus => ({ connector: { version: '0.2.0', startedAt: STARTED, observedAt: FAILED + 1 }, connections });
const base = { connections: [row(LINKED), row(OTHER)], name: (id: string) => id === LINKED ? 'Kết nối 1' : 'Kết nối 2',
  shortId: (id: string) => id.slice(-8), time: (value: number) => `t${value}` };
const linked = (provisioningState: Parameters<typeof hermesActivation>[0]['provisioningState'], value: HermesConnectorStatus | null) =>
  hermesActivation({ ...base, linkedConnectionId: LINKED, provisioningState, status: value });

describe('hermesActivation: bước 6 theo bằng chứng trợ lý đã dùng CRM', () => {
  it('hàng chờ đứng ở pending (production không chạy bộ đồng bộ) nhưng trợ lý đã gọi CRM bằng kết nối đang ghép thì xong', () => {
    const result = linked('pending', status(seen(LINKED, { lastSuccessAt: SUCCESS }), seen(OTHER)));
    expect(result).toEqual({ done: true, waiting: false, note: 'Trợ lý đang dùng kết nối này.',
      summary: 'Trợ lý đang dùng kết nối này. Lần gần nhất gọi CRM: t2000.' });
  });
  it('không bao giờ nói "đang đồng bộ": pending mà chưa có bằng chứng thì nói đúng là chưa thấy, kể từ lúc dịch vụ chạy lại', () => {
    for (const state of ['pending', null, undefined] as const) {
      const result = linked(state, status(seen(LINKED), seen(OTHER)));
      expect(result.done).toBe(false); expect(result.waiting).toBe(true);
      expect(result.summary).toBe('Chưa thấy trợ lý dùng kết nối này kể từ khi dịch vụ kết nối CRM chạy lại lúc t1000. Nếu bạn vừa liên kết, nhờ quản trị viên kích hoạt trợ lý; nếu trợ lý đã chạy, nhắn thử bot trên Zalo.');
      expect(`${result.summary} ${result.note}`).not.toMatch(/[Đđ]ang đồng bộ/);
    }
  });
  it('trợ lý chạy bằng kết nối KHÁC kết nối đang ghép với Zalo: chưa xong, chỉ rõ kết nối cần chọn, không tự chờ', () => {
    const result = linked('pending', status(seen(LINKED), seen(OTHER, { lastSuccessAt: SUCCESS })));
    expect(result.done).toBe(false); expect(result.waiting).toBe(false);
    expect(result.summary).toBe('Trợ lý đang chạy bằng Kết nối 2 (mã …66666666), không phải kết nối đang ghép với nick Zalo. Ở bước 3, chọn kết nối đó rồi bấm “Dùng kết nối này cho trợ lý”.');
    expect(result.note).toBe('Trợ lý đang chạy bằng kết nối khác. Xem bước 6.');
  });
  it('bằng chứng ở kết nối đã ngắt hoặc ngoài danh sách không được tính là trợ lý đang chạy', () => {
    const result = hermesActivation({ ...base, connections: [row(LINKED), row(OTHER, 'revoked')], linkedConnectionId: LINKED, provisioningState: 'pending',
      status: status(seen(LINKED), seen(OTHER, { lastSuccessAt: SUCCESS }), seen(ASSISTANT, { lastSuccessAt: SUCCESS })) });
    expect(result.done).toBe(false); expect(result.summary).toMatch(/^Chưa thấy trợ lý dùng kết nối này/);
  });
  it('kết nối đang ghép đã ngắt, chưa hoàn tất hoặc không còn trong danh sách: không bao giờ xong, dù trước đó từng gọi được', () => {
    // Dịch vụ kết nối không ghi lỗi cho token đã thu hồi, nên lastSuccessAt cũ còn nguyên sau khi ngắt.
    const stale = status(seen(LINKED, { lastSuccessAt: SUCCESS }), seen(OTHER));
    for (const rows of [[row(LINKED, 'revoked'), row(OTHER)], [row(LINKED, 'pending'), row(OTHER)], [row(OTHER)]]) {
      for (const state of ['pending', 'synchronized'] as const) {
        const result = hermesActivation({ ...base, connections: rows, linkedConnectionId: LINKED, provisioningState: state, status: stale });
        expect(result).toEqual({ done: false, waiting: false, note: 'Kết nối đang ghép không còn dùng được. Xem bước 6.',
          summary: 'Kết nối đang ghép với nick Zalo đã ngắt hoặc chưa hoàn tất nên trợ lý không dùng được CRM. Tạo kết nối mới ở bước 2 nếu chưa có, rồi bấm “Dùng kết nối này cho trợ lý” ở bước 3.' });
      }
    }
    const moved = hermesActivation({ ...base, connections: [row(LINKED, 'revoked'), row(OTHER)], linkedConnectionId: LINKED, provisioningState: 'pending',
      status: status(seen(LINKED, { lastSuccessAt: SUCCESS }), seen(OTHER, { lastSuccessAt: FAILED })) });
    expect(moved.done).toBe(false);
    expect(moved.summary).toBe('Kết nối đang ghép với nick Zalo đã ngắt hoặc chưa hoàn tất. Trợ lý đang chạy bằng Kết nối 2 (mã …66666666): ở bước 3, chọn kết nối đó rồi bấm “Dùng kết nối này cho trợ lý”.');
  });
  it('lần gọi thành công không mới hơn lần bị từ chối vì hết hạn thì không còn là bằng chứng', () => {
    for (const lastErrorAt of [FAILED, SUCCESS]) {
      const result = linked('pending', status(seen(LINKED, { lastSuccessAt: SUCCESS, lastErrorCode: 'unauthorized', lastErrorAt }), seen(OTHER)));
      expect(result).toEqual({ done: false, waiting: true, note: 'Trợ lý bị từ chối khi dùng kết nối này. Xem bước 6.',
        summary: `Trợ lý bị từ chối khi dùng kết nối này lúc t${lastErrorAt}: kết nối hết hạn hoặc đã bị thu hồi. Nếu vài phút nữa vẫn vậy, tạo kết nối mới ở bước 2 rồi chọn nó cho trợ lý ở bước 3.` });
    }
  });
  it('lỗi khác (giới hạn tần suất) hoặc lần từ chối cũ hơn lần thành công không xoá bằng chứng', () => {
    expect(linked('pending', status(seen(LINKED, { lastSuccessAt: SUCCESS, lastErrorCode: 'rate_limited', lastErrorAt: FAILED }))).done).toBe(true);
    expect(linked('pending', status(seen(LINKED, { lastSuccessAt: FAILED, lastErrorCode: 'unauthorized', lastErrorAt: SUCCESS }))).done).toBe(true);
  });
  it('kết nối khác chỉ được nêu khi đó là dấu vết mới nhất và chính nó chưa bị từ chối', () => {
    // Kết nối khác từng gọi được nhưng sau đó bị từ chối: không còn là bằng chứng trợ lý đang chạy bằng nó.
    const dead = linked('pending', status(seen(LINKED), seen(OTHER, { lastSuccessAt: SUCCESS, lastErrorCode: 'unauthorized', lastErrorAt: FAILED })));
    expect(dead.summary).toMatch(/^Chưa thấy trợ lý dùng kết nối này/);
    // Sau lần kết nối khác gọi được, trợ lý đã trình kết nối đang ghép và bị từ chối: nói việc bị từ chối, không bảo đổi sang kết nối khác.
    const later = linked('pending', status(seen(LINKED, { lastErrorCode: 'unauthorized', lastErrorAt: FAILED }), seen(OTHER, { lastSuccessAt: SUCCESS })));
    expect(later.waiting).toBe(true); expect(later.summary).toMatch(/^Trợ lý bị từ chối khi dùng kết nối này lúc t3000/);
    // Ngược lại, kết nối khác gọi được SAU lần từ chối thì nêu kết nối khác.
    const earlier = linked('pending', status(seen(LINKED, { lastErrorCode: 'unauthorized', lastErrorAt: SUCCESS }), seen(OTHER, { lastSuccessAt: FAILED })));
    expect(earlier.waiting).toBe(false); expect(earlier.summary).toMatch(/^Trợ lý đang chạy bằng Kết nối 2 /);
  });
  it('giữ nguyên các trạng thái của bộ đồng bộ khi chưa có bằng chứng, và bằng chứng thắng trạng thái hàng chờ', () => {
    const quiet = status(seen(LINKED), seen(OTHER));
    expect(linked('synchronized', quiet)).toEqual({ done: true, waiting: false, note: 'Đã đồng bộ với trợ lý.', summary: 'Trợ lý đã sẵn sàng.' });
    expect(linked('pending_credential', quiet)).toEqual({ done: false, waiting: true, note: 'Đang chờ kết nối CRM của trợ lý.',
      summary: 'Trợ lý chưa nhận được kết nối CRM. Kiểm tra bước 2, rồi bấm “Dùng kết nối này cho trợ lý” ở bước 3 nếu có.' });
    expect(linked('restart_pending', quiet)).toEqual({ done: false, waiting: true, note: 'Đang chờ quản trị viên kích hoạt trợ lý.', summary: 'Đang chờ quản trị viên kích hoạt trợ lý.' });
    expect(linked('unavailable', quiet)).toEqual({ done: false, waiting: true, note: 'Chưa đồng bộ được với trợ lý. Hệ thống sẽ thử lại.',
      summary: 'Chưa đồng bộ được với trợ lý. Hệ thống sẽ tự thử lại.' });
    // Bộ đồng bộ không tự xoá được restart_pending sau khi quản trị khởi động lại: thấy trợ lý gọi CRM là đủ.
    expect(linked('restart_pending', status(seen(LINKED, { lastSuccessAt: SUCCESS }))).done).toBe(true);
    // Máy chủ báo đã đồng bộ nhưng dịch vụ kết nối đã từ chối chính kết nối này: không tin "đã đồng bộ".
    const refused = linked('synchronized', status(seen(LINKED, { lastErrorCode: 'unauthorized', lastErrorAt: FAILED }), seen(OTHER)));
    expect(refused.done).toBe(false); expect(refused.summary).toMatch(/^Trợ lý bị từ chối khi dùng kết nối này/);
  });
  it('chưa đọc được số liệu dịch vụ kết nối thì nói là chưa biết, không đoán', () => {
    const unknown = { done: false, waiting: true, note: 'Chưa đọc được trạng thái trợ lý.',
      summary: 'Chưa đọc được trạng thái dịch vụ kết nối CRM nên chưa biết trợ lý đã chạy chưa.' };
    expect(linked('pending', null)).toEqual(unknown);
    // Danh sách kết nối và số liệu về cùng một lượt: đang tải lại (cả hai trống) thì không được kết luận "kết nối đã ngắt",
    // cũng không tin "đã đồng bộ" khi chưa đối chiếu được với dịch vụ kết nối.
    for (const state of ['pending', 'synchronized'] as const) {
      expect(hermesActivation({ ...base, connections: [], linkedConnectionId: LINKED, provisioningState: state, status: null })).toEqual(unknown);
    }
  });
  it('chưa liên kết Zalo: không tính là xong; nếu trợ lý đã dùng CRM thì nói ra và chỉ sang bước 3', () => {
    const idle = hermesActivation({ ...base, linkedConnectionId: null, provisioningState: null, status: status(seen(LINKED), seen(OTHER)) });
    expect(idle).toEqual({ done: false, waiting: false, note: null, summary: 'Tự chạy sau khi bạn liên kết Zalo.' });
    const used = hermesActivation({ ...base, linkedConnectionId: null, provisioningState: null,
      status: status(seen(LINKED, { lastSuccessAt: SUCCESS }), seen(OTHER, { lastSuccessAt: FAILED })) });
    expect(used.done).toBe(false);
    expect(used.summary).toBe('Trợ lý đã gọi được CRM bằng Kết nối 2 lúc t3000. Liên kết Zalo ở bước 3 để nhắn trợ lý qua bot của công ty.');
  });
});
