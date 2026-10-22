// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { UseQueryResult } from '@tanstack/react-query';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));
import { nextPolicyReadBoundary, parseTimedRoomSaleRead, policyReadServerNow, projectTimedRoomSaleRead, type TimedRoomSaleRead } from '../publicSalePolicyExpiry';
import { useTimedRoomSaleResult } from '@/hooks/useTimedRoomSaleResult';
import { parseSaleRoomInventory, saleInventoryAtTime, saleInventoryBoundaryDelay, saleInventoryClock } from '../saleRoomOperations';

const now = '2026-11-01T00:00:00Z', end = '2026-11-01T00:00:10Z';
const payload = () => ({ server_now: now, next_policy_boundary_at: end,
  buildings: [{ id: 'b1', name: 'Tòa A', code: null, district: null, ward: null, address: null, total_floors: 1, images: [] }],
  rooms: [{ id: 'r1', building_id: 'b1', floor: 1, name: '101', code: null, area: 20, rent_price: 3e6, max_occupants: 2,
    amenities: [], images: [], description: null, sale_note: 'Ghi chú nền\nƯu đãi', sale_note_base: 'Ghi chú nền',
    active_policy_text: 'Ưu đãi', active_policy_ends_at: end, status_public: 'free', avail_date: null }],
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Public and legacy read-time policy cache', () => {
  it('C01 cached public text loses only the campaign at the exact known end', () => {
    const read = parseTimedRoomSaleRead(payload(), false, 100, 100);
    expect(projectTimedRoomSaleRead(read, 10_099)[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền\nƯu đãi');
    expect(projectTimedRoomSaleRead(read, 10_100)[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền');
    expect(projectTimedRoomSaleRead(read, 10_100)[0]?.floors[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền');
    expect(read.payload.rooms[0]?.sale_note).toBe('Ghi chú nền\nƯu đãi');
  });
  it('C02 network latency cannot postpone expiry and wall-clock skew is irrelevant', () => {
    const read = parseTimedRoomSaleRead(payload(), true, 0, 15_000);
    expect(policyReadServerNow(read, 15_000)).toBe(Date.parse(now) + 15_000);
    expect(projectTimedRoomSaleRead(read, 15_000)[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền');
    expect(nextPolicyReadBoundary(read, 15_000)).toBeNull();
  });
  it('C03 null base stays null after expiry and missing timing cannot authorize cached offer text', () => {
    const data = payload(); data.rooms[0]!.sale_note_base = null as unknown as string;
    expect(projectTimedRoomSaleRead(parseTimedRoomSaleRead(data, false, 0, 0), 10_000)[0]?.rooms[0]?.saleNote).toBeNull();
    expect(() => parseTimedRoomSaleRead({ ...payload(), server_now: undefined }, false, 0, 0)).toThrow();
    expect(() => parseTimedRoomSaleRead({ ...payload(), rooms: [{ ...payload().rooms[0], active_policy_ends_at: undefined }] }, false, 0, 0)).toThrow();
  });
  it('C04 future boundary asks for a fresh read without exposing a future campaign', () => {
    const data = payload(); Object.assign(data.rooms[0]!, { sale_note: 'Ghi chú nền', active_policy_text: null, active_policy_ends_at: null });
    const read = parseTimedRoomSaleRead(data, false, 0, 0);
    expect(nextPolicyReadBoundary(read, 0)).toBe(10_000);
    expect(projectTimedRoomSaleRead(read, 10_000)[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền');
  });
  it('C05 old payload without timed fields keeps existing base content', () => {
    const data = payload();const { server_now: _server, next_policy_boundary_at: _next, ...legacy } = data;
    legacy.rooms = data.rooms.map(({ sale_note_base: _base, active_policy_text: _text, active_policy_ends_at: _end, ...room }) => room) as typeof data.rooms;
    expect(projectTimedRoomSaleRead(parseTimedRoomSaleRead(legacy, false, 0, 0), 999_999)[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền\nƯu đãi');
  });
  it('C06 boundary timer removes expired text while refetch fails; image refresh refuses stale cache', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const read = parseTimedRoomSaleRead(payload(), false, performance.now(), performance.now());
    const refetch = vi.fn().mockResolvedValue({ data: read, error: new Error('offline') });
    const query = { data: read, refetch } as unknown as UseQueryResult<TimedRoomSaleRead, Error>;
    const hook = renderHook(() => useTimedRoomSaleResult(query));
    expect(hook.result.current.data?.[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền\nƯu đãi');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.data?.[0]?.rooms[0]?.saleNote).toBe('Ghi chú nền');
    await expect(hook.result.current.readFresh()).rejects.toThrow('Chưa xác minh');
  });
  it('C07 image refresh projects the returned read at completion, not the older screen cache', async () => {
    const original = parseTimedRoomSaleRead(payload(), false, 0, 0);
    const fresh = payload(); Object.assign(fresh.rooms[0]!, { sale_note: 'Mới', sale_note_base: 'Mới', active_policy_text: null, active_policy_ends_at: null });
    const refetch = vi.fn().mockResolvedValue({ data: parseTimedRoomSaleRead(fresh, false, performance.now(), performance.now()), error: null });
    const hook = renderHook(() => useTimedRoomSaleResult({ data: original, refetch } as unknown as UseQueryResult<TimedRoomSaleRead, Error>));
    expect((await hook.result.current.readFresh())[0]?.rooms[0]?.saleNote).toBe('Mới');
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  const inventory = () => {
    const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const first={id:id(10),version:1,title:'Đợt 1',content:'Ưu đãi',starts_at:now,ends_at:end,status:'ACTIVE'};
    const second={...first,id:id(11),title:'Đợt 2',content:'Đợt nối tiếp',starts_at:end,ends_at:'2026-11-01T00:00:20Z',status:'SCHEDULED'};
    return parseSaleRoomInventory({...payload(),buildings:[{...payload().buildings[0],id:id(1)}],
      rooms:[{...payload().rooms[0],id:id(2),building_id:id(1),sale_note:'Ghi chú nền',revision:'a'.repeat(32),updated_at:now,
        policy:first,policies:[first,second],capabilities:{edit:true,images:true,pass:false,lock:false,releaseLock:false,deposit:false}}]});
  };
  it('C08 slow inventory read expires conservatively but does not activate the next policy early', () => {
    const data={...inventory(),readTiming:{receivedMonotonicMs:15_000,requestDurationMs:15_000}};
    const clock=saleInventoryClock(data,15_000);
    expect(clock.lowerBoundMs).toBe(Date.parse(now));expect(clock.upperBoundMs).toBe(Date.parse(now)+15_000);
    const current=saleInventoryAtTime(data,clock.lowerBoundMs,clock.upperBoundMs);
    expect(current.rooms[0]?.activePolicyText).toBeNull();expect(current.rooms[0]?.policy?.status).toBe('SCHEDULED');
    expect(current.rooms[0]?.room.saleNote).toBe('Ghi chú nền');
    expect(saleInventoryBoundaryDelay(data,clock.lowerBoundMs,clock.upperBoundMs)).toBe(5_000);
  });
  it('C09 adjacent campaigns remain individually selectable and switch at the shared boundary', () => {
    const data=inventory();const atStart=saleInventoryAtTime(data,Date.parse(now));
    expect(atStart.rooms[0]?.policies).toHaveLength(2);expect(atStart.rooms[0]?.activePolicyText).toBe('Ưu đãi');
    const next=saleInventoryAtTime(data,Date.parse(end));expect(next.rooms[0]?.activePolicyText).toBe('Đợt nối tiếp');
    expect(next.rooms[0]?.policies).toHaveLength(1);expect(next.rooms[0]?.room.saleNote).toBe('Ghi chú nền\nĐợt nối tiếp');
    expect(next.rooms[0]?.saleNote).toBe('Ghi chú nền');
  });
});
