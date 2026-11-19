// @vitest-environment jsdom
// (jsdom: React Query coi môi trường không có `window` là server và KHÔNG chạy
// refetchInterval — phép thử tích hợp bên dưới cần interval thật.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { LuckyPublicState, LuckyRoundPublic } from '@/lib/luckyDrawApi';
import {
  daQuayXong,
  dangHoiThua,
  DUNG_HAN_KHI_DONG_QUA_MS,
  NHIP_SAU_XONG_MAN_CHIEU_MS,
  NHIP_SAU_XONG_NGUOI_XEM_MS,
  nhipHoiManChieu,
  nhipHoiSauKhiXong,
  taoTheoDoiDong,
} from './quaySoPolling';

const event = (status: 'open' | 'drawn' | 'closed', serverNow = '2026-10-21T08:00:00Z', drawnAt: string | null = null) =>
  ({ id: 'e', status, serverNow, drawnAt }) as unknown as NonNullable<LuckyPublicState['event']>;
const round = (status: 'pending' | 'drawn') => ({ id: status, status }) as unknown as LuckyRoundPublic;

describe('daQuayXong — khi nào trang quay số chuyển sang hỏi thưa (RT-OTHER-6)', () => {
  it('chưa đọc được trạng thái / lỗi thì CHƯA xong (tiếp tục hỏi)', () => {
    expect(daQuayXong(undefined)).toBe(false);
    expect(daQuayXong({ ok: false, reason: 'not_found' })).toBe(false);
    expect(daQuayXong({ ok: true })).toBe(false);
  });

  it('một giải kiểu cũ: xong khi drawn hoặc closed, chưa xong khi open', () => {
    expect(daQuayXong({ ok: true, event: event('open'), rounds: [] })).toBe(false);
    expect(daQuayXong({ ok: true, event: event('drawn'), rounds: [] })).toBe(true);
    expect(daQuayXong({ ok: true, event: event('closed') })).toBe(true);
  });

  it('chia lượt: chỉ xong khi MỌI lượt đã quay, bất kể trạng thái event', () => {
    expect(daQuayXong({ ok: true, event: event('drawn'), rounds: [round('drawn'), round('pending')] })).toBe(false);
    expect(daQuayXong({ ok: true, event: event('open'), rounds: [round('drawn'), round('drawn')] })).toBe(true);
  });
});

describe('nhịp hỏi sau khi xong — giãn chứ không dừng (RT-CLIENT-2)', () => {
  it('quay xong: màn chiếu 30 s, người xem 60 s — không bao giờ false khi chưa đóng', () => {
    const xong: LuckyPublicState = { ok: true, event: event('drawn'), rounds: [] };
    expect(nhipHoiManChieu(xong, taoTheoDoiDong())).toBe(NHIP_SAU_XONG_MAN_CHIEU_MS);
    expect(nhipHoiSauKhiXong(xong, NHIP_SAU_XONG_NGUOI_XEM_MS, taoTheoDoiDong())).toBe(NHIP_SAU_XONG_NGUOI_XEM_MS);
    const chiaLuotXong: LuckyPublicState = { ok: true, event: event('open'), rounds: [round('drawn')] };
    expect(nhipHoiManChieu(chiaLuotXong, taoTheoDoiDong())).toBe(NHIP_SAU_XONG_MAN_CHIEU_MS);
  });

  it('chưa xong thì trả null cho trang dùng nhịp thường; màn chiếu còn lượt hỏi 1,5 s', () => {
    const conLuot: LuckyPublicState = { ok: true, event: event('drawn'), rounds: [round('drawn'), round('pending')] };
    expect(nhipHoiSauKhiXong(conLuot, NHIP_SAU_XONG_NGUOI_XEM_MS, taoTheoDoiDong())).toBeNull();
    expect(nhipHoiManChieu(conLuot, taoTheoDoiDong())).toBe(1500);
    expect(nhipHoiManChieu({ ok: true, event: event('open'), rounds: [] }, taoTheoDoiDong())).toBe(5000);
    expect(nhipHoiManChieu(undefined, taoTheoDoiDong())).toBe(5000);
    expect(dangHoiThua(conLuot)).toBe(false);
  });

  it("đóng: hỏi thưa (kể cả đóng giữa chừng), chỉ dừng hẳn khi đã 'closed' liên tục quá 6 giờ giờ server", () => {
    const theoDoi = taoTheoDoiDong();
    const dong = (serverNow: string): LuckyPublicState => ({ ok: true, event: event('closed', serverNow), rounds: [round('pending')] });
    expect(dangHoiThua(dong('2026-10-21T08:00:00Z'))).toBe(true);
    expect(nhipHoiManChieu(dong('2026-10-21T08:00:00Z'), theoDoi)).toBe(NHIP_SAU_XONG_MAN_CHIEU_MS);
    const truocHan = new Date(Date.parse('2026-10-21T08:00:00Z') + DUNG_HAN_KHI_DONG_QUA_MS - 1).toISOString();
    expect(nhipHoiManChieu(dong(truocHan), theoDoi)).toBe(NHIP_SAU_XONG_MAN_CHIEU_MS);
    const toiHan = new Date(Date.parse('2026-10-21T08:00:00Z') + DUNG_HAN_KHI_DONG_QUA_MS).toISOString();
    expect(nhipHoiManChieu(dong(toiHan), theoDoi)).toBe(false);
  });

  it('sự kiện mở lại thì xoá mốc đóng — lần đóng sau đếm lại từ đầu', () => {
    const theoDoi = taoTheoDoiDong();
    nhipHoiSauKhiXong({ ok: true, event: event('closed', '2026-10-21T08:00:00Z') }, NHIP_SAU_XONG_NGUOI_XEM_MS, theoDoi);
    nhipHoiSauKhiXong({ ok: true, event: event('open', '2026-10-21T13:00:00Z'), rounds: [] }, NHIP_SAU_XONG_NGUOI_XEM_MS, theoDoi);
    expect(theoDoi.since).toBeNull();
    nhipHoiSauKhiXong({ ok: true, event: event('closed', '2026-10-21T13:30:00Z') }, NHIP_SAU_XONG_NGUOI_XEM_MS, theoDoi);
    expect(
      nhipHoiSauKhiXong({ ok: true, event: event('closed', '2026-10-21T15:00:00Z') }, NHIP_SAU_XONG_NGUOI_XEM_MS, theoDoi),
    ).toBe(NHIP_SAU_XONG_NGUOI_XEM_MS);
  });
});

describe('tích hợp React Query: sau khi quay xong, lệnh đặt lại của quản trị vẫn được nạp về (RT-CLIENT-2)', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  const daQuay: LuckyPublicState = {
    ok: true,
    event: event('drawn', '2026-10-21T08:00:00Z', '2026-10-21T07:59:00Z'),
    rounds: [{ ...round('drawn'), drawnAt: '2026-10-21T07:59:00Z' } as LuckyRoundPublic],
  };
  const datLai: LuckyPublicState = {
    ok: true,
    event: event('open', '2026-10-21T08:01:00Z'),
    rounds: [{ ...round('pending'), drawnAt: null } as LuckyRoundPublic],
  };

  async function chay(nhip: (state: LuckyPublicState | undefined) => number | false, cho: number) {
    let server = daQuay;
    const queryFn = vi.fn(async () => server);
    const observer = new QueryObserver<LuckyPublicState>(client, {
      queryKey: ['quayso-test'],
      queryFn,
      refetchInterval: (query) => nhip(query.state.data),
    });
    const stop = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data?.event?.status).toBe('drawn');
    expect(daQuayXong(observer.getCurrentResult().data)).toBe(true);

    // Quản trị bấm "Huỷ kết quả và mở lại" (resetDraw: event 'open', rounds 'pending').
    server = datLai;
    await vi.advanceTimersByTimeAsync(cho);
    const sau = observer.getCurrentResult().data;
    stop();
    return { sau, queryFn };
  }

  it('màn chiếu: trạng thái đặt lại về tới cache trong 30 s', async () => {
    const theoDoi = taoTheoDoiDong();
    const { sau, queryFn } = await chay((s) => nhipHoiManChieu(s, theoDoi), NHIP_SAU_XONG_MAN_CHIEU_MS);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(sau?.event?.status).toBe('open');
    expect(sau?.rounds?.[0]?.status).toBe('pending');
  });

  it('trang người xem: trạng thái đặt lại về tới cache trong 60 s', async () => {
    const theoDoi = taoTheoDoiDong();
    const nguoiXem = (s: LuckyPublicState | undefined) =>
      nhipHoiSauKhiXong(s, NHIP_SAU_XONG_NGUOI_XEM_MS, theoDoi) ?? 4000;
    const { sau } = await chay(nguoiXem, NHIP_SAU_XONG_NGUOI_XEM_MS);
    expect(sau?.event?.status).toBe('open');
    expect(sau?.rounds?.[0]?.status).toBe('pending');
  });
});
