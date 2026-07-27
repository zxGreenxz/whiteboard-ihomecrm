// gpsFix — thang 3 lớp lấy toạ độ. Test bằng geolocation giả (không cần browser).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGpsCache,
  acquireGpsFix,
  getCachedGpsFix,
  rememberGpsFix,
  type GpsPhase,
} from '@/lib/gpsFix';

type SuccessCb = (pos: any) => void;
type ErrorCb = (err: any) => void;

/** navigator.geolocation giả: giữ callback để test tự bắn success/error. */
function fakeGeolocation() {
  const watches: Array<{ id: number; ok: SuccessCb; fail: ErrorCb; opts?: PositionOptions }> = [];
  let nextId = 1;
  return {
    watches,
    cleared: [] as number[],
    watchPosition(ok: SuccessCb, fail: ErrorCb, opts?: PositionOptions) {
      const id = nextId++;
      watches.push({ id, ok, fail, opts });
      return id;
    },
    clearWatch(id: number) {
      this.cleared.push(id);
    },
  };
}

const pos = (lat: number, lng: number, accuracy = 10) => ({ coords: { latitude: lat, longitude: lng, accuracy } });
const TIMEOUT_ERR = { code: 3, PERMISSION_DENIED: 1 };
const DENIED_ERR = { code: 1, PERMISSION_DENIED: 1 };

describe('gpsFix', () => {
  beforeEach(() => __resetGpsCache());

  it('fix cache còn hạn được dùng NGAY, không bắt chờ watchPosition', () => {
    rememberGpsFix({ lat: 10.8, lng: 106.6, accuracy: 12, at: 1_000 });
    const geo = fakeGeolocation();
    const updates: Array<[unknown, GpsPhase]> = [];

    acquireGpsFix((fix, phase) => updates.push([fix?.lat ?? null, phase]), {
      geolocation: geo,
      now: () => 5_000, // 4 giây sau → còn hạn
    });

    expect(updates[0]).toEqual([10.8, 'ok']);
  });

  it('fix cache quá hạn thì bỏ, quay lại trạng thái đang bắt', () => {
    rememberGpsFix({ lat: 10.8, lng: 106.6, accuracy: 12, at: 0 });
    const geo = fakeGeolocation();
    const updates: Array<[unknown, GpsPhase]> = [];

    acquireGpsFix((fix, phase) => updates.push([fix?.lat ?? null, phase]), {
      geolocation: geo,
      now: () => 10 * 60_000, // 10 phút sau
    });

    expect(updates[0]).toEqual([null, 'locating']);
  });

  it('GPS chính xác cao timeout (đứng trong nhà) → tự hạ chuẩn sang vòng thô và vẫn lấy được toạ độ', () => {
    const geo = fakeGeolocation();
    const updates: Array<[unknown, GpsPhase]> = [];
    acquireGpsFix((fix, phase) => updates.push([fix?.lat ?? null, phase]), {
      geolocation: geo,
      now: () => 1_000,
    });

    expect(geo.watches[0].opts?.enableHighAccuracy).toBe(true);
    geo.watches[0].fail(TIMEOUT_ERR); // hết 12s không thấy vệ tinh

    // Vòng 2: định vị wifi/cell, chấp nhận fix cũ tới 5 phút
    expect(geo.watches).toHaveLength(2);
    expect(geo.watches[1].opts?.enableHighAccuracy).toBe(false);
    expect(geo.watches[1].opts?.maximumAge).toBeGreaterThanOrEqual(60_000);

    geo.watches[1].ok(pos(10.8457, 106.6498, 45));
    expect(updates.at(-1)).toEqual([10.8457, 'ok']);
    // và fix đó được nhớ cho lần mở camera kế tiếp
    expect(getCachedGpsFix(120_000, 1_000)?.lng).toBe(106.6498);
  });

  it('bị chặn quyền vị trí → báo denied, KHÔNG thử vòng thô vô ích', () => {
    const geo = fakeGeolocation();
    const updates: Array<[unknown, GpsPhase]> = [];
    acquireGpsFix((fix, phase) => updates.push([fix?.lat ?? null, phase]), {
      geolocation: geo,
      now: () => 1_000,
    });

    geo.watches[0].fail(DENIED_ERR);
    expect(updates.at(-1)).toEqual([null, 'denied']);
    expect(geo.watches).toHaveLength(1);
  });

  it('cả 2 vòng đều chết nhưng đã có fix trước đó → giữ fix, vẫn là ok', () => {
    const geo = fakeGeolocation();
    const updates: Array<[unknown, GpsPhase]> = [];
    acquireGpsFix((fix, phase) => updates.push([fix?.lat ?? null, phase]), {
      geolocation: geo,
      now: () => 1_000,
    });

    geo.watches[0].ok(pos(10.79, 106.64));
    geo.watches[0].fail(TIMEOUT_ERR);
    geo.watches[1].fail(TIMEOUT_ERR);

    expect(updates.at(-1)).toEqual([10.79, 'ok']);
  });

  it('máy không có geolocation → unavailable, không nổ', () => {
    const updates: Array<[unknown, GpsPhase]> = [];
    const stop = acquireGpsFix((fix, phase) => updates.push([fix?.lat ?? null, phase]), {
      geolocation: null,
      now: () => 1_000,
    });
    expect(updates.at(-1)).toEqual([null, 'unavailable']);
    expect(() => stop()).not.toThrow();
  });

  it('stop() gỡ watch đang chạy', () => {
    const geo = fakeGeolocation();
    const stop = acquireGpsFix(() => {}, { geolocation: geo, now: () => 1_000 });
    stop();
    expect(geo.cleared).toContain(geo.watches[0].id);
  });

  it('sau khi stop, callback trễ của trình duyệt không còn bắn update', () => {
    const geo = fakeGeolocation();
    const cb = vi.fn();
    const stop = acquireGpsFix(cb, { geolocation: geo, now: () => 1_000 });
    cb.mockClear();
    stop();
    geo.watches[0].ok(pos(10.1, 106.1));
    expect(cb).not.toHaveBeenCalled();
  });
});
