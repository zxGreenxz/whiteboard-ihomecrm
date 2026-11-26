// @vitest-environment jsdom
// Đợt 9: nhập chỉ số từ Excel và ghi chỉ số hàng loạt đi qua `record_meter_readings_v2` (production 26/11/2026, md5
// 3904b0d1): khoá toà (khoá tư vấn) TRƯỚC khi tra mã chống trùng; cùng mã cùng nội dung ⇒ trả kết quả đã chốt; cùng mã
// khác nội dung ⇒ 23505 «idempotency_key đã dùng với nội dung khác» (chỉ có khi lần trước ĐÃ ghi: claim nằm cùng giao dịch
// với chỉ số); tháng đã có chỉ số ⇒ từ chối cả lô. Máy chủ giả dưới đây chép đúng các điểm đó.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: null as unknown as FakeRecordServer }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'u1' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'o1' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useBulkCreateMeterReadings, useImportMeterReadings } from '../useMeterReadings';
import { FinancialAlreadyRecordedError } from '@/lib/financialWorkflowError';
import { MeterReadingsRejectedError } from '@/lib/meterReadingRpc';
import { fakeRecordServer, seedLegacyPending, pendingKeys } from './fakeRecordServer';

const id = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const [B1, B2, M1, M2, M3, M9] = ['b', 'c', '1', '2', '3', '9'].map(id);
const T0 = Date.parse('2026-11-26T02:00:00.000Z');
let seq = 0;
const claims = new Map<string, { hash: string; response: unknown }>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
  localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'o1');
  seq = 0; claims.clear();
  io.server = fakeRecordServer();
  io.server.rows.meters = [
    { id: M1, code: 'DH1', building_id: B1, user_id: 'u1', deleted_at: null },
    { id: M2, code: 'DH2', building_id: B1, user_id: 'u1', deleted_at: null },
    { id: M3, code: 'DH3', building_id: B2, user_id: 'u1', deleted_at: null },
    { id: M9, code: 'DH9', building_id: B1, user_id: 'u2', deleted_at: null },
  ];
  io.server.rows.meter_readings = [];
  io.server.rpcHandlers.record_meter_readings_v2 = args => {
    const building = String(args.p_building_id); const date = String(args.p_reading_date); const rows = args.p_rows as Row[];
    const key = String(args.p_idempotency_key);
    const hash = JSON.stringify([building, date, rows, args.p_replace]);
    const claim = claims.get(`${building}|${key}`);
    if (claim) {
      if (claim.hash !== hash) return { data: null, error: { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' } };
      return { data: claim.response, error: null };
    }
    const readings = io.server.rows.meter_readings;
    const rejected = rows.flatMap((row, index) => readings.some(r => r.meter_id === row.meterId && String(r.reading_date).slice(0, 7) === date.slice(0, 7) && !r.deleted_at)
      ? [{ n: index + 1, status: 'duplicate_month', meterCode: io.server.rows.meters.find(m => m.id === row.meterId)?.code, existingValue: 1 }] : []);
    if (rejected.length) return { data: null, error: { code: '22023', message: 'meter_readings_rejected', details: JSON.stringify(rejected), hint: 'duplicate_month' } };
    const created = rows.map((row, index) => {
      seq += 1;
      const reading = { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, reading_code: `CS${String(seq).padStart(4, '0')}`,
        meter_id: row.meterId, building_id: building, reading_date: date, current_reading: row.value, user_id: 'u1', deleted_at: null, created_at: new Date().toISOString() };
      readings.push(reading);
      return { n: index + 1, id: reading.id, code: reading.reading_code, meterId: row.meterId, previous: 0, value: row.value, consumption: row.value };
    });
    const response = { buildingId: building, readingDate: date, settlementMonth: date.slice(0, 7), count: created.length, created, replaced: [] };
    claims.set(`${building}|${key}`, { hash, response });
    return { data: response, error: null };
  };
});
afterEach(() => { vi.useRealTimers(); });

const v2Calls = () => io.server.rpcCalls.filter(call => call.name === 'record_meter_readings_v2');
const readings = () => io.server.rows.meter_readings;
interface ImportRow { reading_id: string | null; reading_code: string | null; success: boolean; error_message: string | null }
const importReadings = (rows: Row[]) =>
  (renderHook(() => useImportMeterReadings()).result.current as unknown as { mutationFn: (input: { readings: Row[] }) => Promise<ImportRow[]> }).mutationFn({ readings: rows });
const excel = (code: string, value: number, date = '2026-11-20') => ({ meter_code: code, reading_date: date, current_reading: value });
const importScope = { namespace: 'useImportMeterReadings', userId: 'u1', organizationId: 'actor-scope', businessKey: 'import' };

it('nhập chỉ số: mỗi nhóm toà + ngày chốt một lần ghi v2, mã chống trùng suy từ mã yêu cầu; mã công tơ đọc trước (công tơ của chính người nhập)', async () => {
  const result = await importReadings([excel('DH1', 10), excel('DH3', 30), excel('DH2', 20), excel('DHX', 1), excel('DH9', 9)]);
  expect(io.server.rpcCalls.some(call => call.name === 'bulk_create_meter_readings')).toBe(false);
  expect(v2Calls()).toHaveLength(2);
  const [first, second] = v2Calls().map(call => call.args);
  expect(first).toMatchObject({ p_building_id: B1, p_reading_date: '2026-11-20', p_rows: [{ meterId: M1, value: 10 }, { meterId: M2, value: 20 }] });
  expect(second).toMatchObject({ p_building_id: B2, p_rows: [{ meterId: M3, value: 30 }] });
  const keys = v2Calls().map(call => String(call.args.p_idempotency_key));
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[0].split(':')[0]).toBe(keys[1].split(':')[0]);
  expect(result.map(row => row.success)).toEqual([true, true, true, false, false]);
  expect(result[0].reading_code).toBeTruthy();
  expect(result[3].error_message).toBe('Không tìm thấy công tơ với mã: DHX');
  expect(result[4].error_message).toBe('Không tìm thấy công tơ với mã: DH9');
  expect(pendingKeys()).toEqual([]);
});

it('(i) nhập chỉ số không tới máy chủ: báo chưa xác nhận; bấm lại gửi lại NGAY đúng mã cũ ⇒ một lần ghi, gỡ dấu', async () => {
  io.server.failNext('record_meter_readings_v2', 'rpc', 'drop-before');
  await expect(importReadings([excel('DH1', 10)])).rejects.toThrow(/Chưa xác nhận/);
  expect(pendingKeys()).toHaveLength(1);
  const result = await importReadings([excel('DH1', 10)]);
  expect(result.map(row => row.success)).toEqual([true]);
  expect(v2Calls()).toHaveLength(2);
  expect(v2Calls()[1].args.p_idempotency_key).toBe(v2Calls()[0].args.p_idempotency_key);
  expect(readings()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('(ii) nhập chỉ số tới nhưng mất phản hồi: bấm lại cùng mã ⇒ máy chủ trả kết quả đã chốt, không ghi lần hai', async () => {
  io.server.failNext('record_meter_readings_v2', 'rpc', 'drop-after');
  await expect(importReadings([excel('DH1', 10), excel('DH2', 20)])).rejects.toThrow(/Chưa xác nhận/);
  expect(readings()).toHaveLength(2);
  const result = await importReadings([excel('DH1', 10), excel('DH2', 20)]);
  expect(result.map(row => row.reading_code)).toEqual(readings().map(row => row.reading_code));
  expect(readings()).toHaveLength(2);
  expect(pendingKeys()).toEqual([]);
});

it('nhập chỉ số: mã đã dùng với nội dung khác ⇒ lần trước đã ghi, báo mã chỉ số, không khoá, gỡ dấu', async () => {
  io.server.failNext('record_meter_readings_v2', 'rpc', 'drop-after');
  await expect(importReadings([excel('DH1', 10)])).rejects.toThrow(/Chưa xác nhận/);
  const result = await importReadings([excel('DH1', 12)]);
  expect(result[0].success).toBe(false);
  expect(result[0].error_message).toMatch(/lần nhập trước/);
  expect(result[0].error_message).toContain(String(readings()[0].reading_code));
  expect(readings()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('nhập chỉ số: nhóm có tháng đã có chỉ số ⇒ nêu đúng dòng, dòng cùng nhóm báo chưa ghi; nhóm khác vẫn ghi; không giữ dấu', async () => {
  readings().push({ id: 'old', meter_id: M2, reading_date: '2026-11-05', deleted_at: null });
  const result = await importReadings([excel('DH1', 10), excel('DH2', 20), excel('DH3', 30)]);
  expect(result.map(row => row.success)).toEqual([false, false, true]);
  expect(result[1].error_message).toMatch(/đã có chỉ số tháng này/);
  expect(result[0].error_message).toMatch(/Chưa ghi/);
  expect(pendingKeys()).toEqual([]);
});

it('nhập chỉ số: dấu bản trước gieo sẵn ≥ 10 phút (không tên thao tác) ⇒ không chặn, ghi, gỡ dấu', async () => {
  seedLegacyPending(importScope, new Date(T0 - 10 * 60_000));
  await expect(importReadings([excel('DH1', 10)])).resolves.toMatchObject([{ success: true }]);
  expect(readings()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('nhập chỉ số: đọc công tơ hỏng ⇒ báo lỗi TRƯỚC khi ghi dấu, không gửi', async () => {
  io.server.failNext('meters', 'read', 'drop-before');
  await expect(importReadings([excel('DH1', 10)])).rejects.toThrow();
  expect(v2Calls()).toHaveLength(0);
  expect(pendingKeys()).toEqual([]);
});

const bulk = (value = 1234, date = '2026-11-20') =>
  (renderHook(() => useBulkCreateMeterReadings()).result.current as unknown as { mutationFn: (rows: Row[]) => Promise<unknown> })
    .mutationFn([{ building_id: B1, meter_id: M1, reading_date: date, current_reading: value }]);

it('(i) ghi hàng loạt không tới máy chủ: bấm lại gửi lại ngay đúng khoá ⇒ một chỉ số, gỡ dấu', async () => {
  io.server.failNext('record_meter_readings_v2', 'rpc', 'drop-before');
  await expect(bulk()).rejects.toThrow(/Chưa xác nhận/);
  await expect(bulk()).resolves.toHaveLength(1);
  expect(v2Calls()[1].args.p_idempotency_key).toBe(v2Calls()[0].args.p_idempotency_key);
  expect(readings()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('(ii) ghi hàng loạt mất phản hồi: bấm lại ⇒ kết quả đã chốt, một chỉ số', async () => {
  io.server.failNext('record_meter_readings_v2', 'rpc', 'drop-after');
  await expect(bulk()).rejects.toThrow(/Chưa xác nhận/);
  await expect(bulk()).resolves.toEqual([expect.objectContaining({ code: readings()[0].reading_code })]);
  expect(readings()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('ghi hàng loạt: sau lần chưa rõ đổi số ⇒ mã đã dùng với nội dung khác = lần trước đã ghi: báo mã chỉ số, gỡ dấu, không khoá', async () => {
  io.server.failNext('record_meter_readings_v2', 'rpc', 'drop-after');
  await expect(bulk(1234)).rejects.toThrow(/Chưa xác nhận/);
  const error = await bulk(1240).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
  expect((error as Error).message).toContain(String(readings()[0].reading_code));
  expect(readings()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('ghi hàng loạt: lần gửi lại gặp từ chối rõ (tháng vừa có chỉ số) ⇒ báo từng dòng, gỡ dấu, không khoá', async () => {
  io.server.failNext('record_meter_readings_v2', 'rpc', 'drop-before');
  await expect(bulk()).rejects.toThrow(/Chưa xác nhận/);
  readings().push({ id: 'other', meter_id: M1, reading_date: '2026-11-02', deleted_at: null });
  await expect(bulk()).rejects.toBeInstanceOf(MeterReadingsRejectedError);
  expect(pendingKeys()).toEqual([]);
});

it('ghi hàng loạt: dấu bản trước gieo sẵn ≥ 10 phút ⇒ không chặn, ghi, gỡ dấu', async () => {
  seedLegacyPending({ namespace: 'useBulkCreateMeterReadings', userId: 'u1', organizationId: 'o1', businessKey: 'batch' }, new Date(T0 - 10 * 60_000));
  await expect(bulk()).resolves.toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});
