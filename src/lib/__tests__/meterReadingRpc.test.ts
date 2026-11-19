import { describe, expect, it, vi } from 'vitest';
import { buildRecordMeterReadingsArgs, meterRejectedRowText, MeterReadingsRejectedError, parseMeterReadingsRejection, recordMeterReadings,
  type MeterReadingInvoker } from '@/lib/meterReadingRpc';

const [B1, M1, M2, R1] = ['b', '1', '2', '3'].map(c => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);
const input = { buildingId: B1, readingDate: '2026-10-22', idempotencyKey: 'request-key-0001',
  rows: [{ meterId: M1, value: 1234, notes: '  đọc tay ', imageUrl: '' }, { meterId: M2, value: 7 }] };

describe('meterReadingRpc (record_meter_readings_v2, hàm dùng chung web ⇄ Hermes)', () => {
  it('dựng tham số đúng chữ ký hàm ghi; bỏ ghi chú/ảnh rỗng; từ chối dữ liệu sai trước khi gọi', () => {
    expect(buildRecordMeterReadingsArgs(input)).toEqual({ p_building_id: B1, p_reading_date: '2026-10-22', p_replace: false,
      p_idempotency_key: 'request-key-0001', p_rows: [{ meterId: M1, value: 1234, notes: 'đọc tay' }, { meterId: M2, value: 7 }] });
    for (const bad of [{ ...input, rows: [] }, { ...input, buildingId: 'b1' }, { ...input, readingDate: '22/10/2026' }, { ...input, idempotencyKey: 'short' },
      { ...input, rows: [{ meterId: M1, value: -1 }] }, { ...input, rows: [{ meterId: M1, value: Number.NaN }] }])
      expect(() => buildRecordMeterReadingsArgs(bad)).toThrow();
  });

  it('từ chối cả lô (22023 meter_readings_rejected) ⇒ MeterReadingsRejectedError có từng dòng, là từ chối đã xác nhận', async () => {
    const details = JSON.stringify([{ n: 1, status: 'duplicate_month', roomName: 'P101', meterCode: 'DH-101', previous: 1200, existingValue: 1230 },
      { n: 2, status: 'lower_than_previous', roomName: 'P105', meterCode: 'DH-105', previous: 2210 }]);
    const invoke: MeterReadingInvoker = vi.fn(async () => ({ data: null, error: { code: '22023', message: 'meter_readings_rejected', details, hint: 'duplicate_month' } }));
    const error = await recordMeterReadings(invoke, input).catch(e => e);
    expect(error).toBeInstanceOf(MeterReadingsRejectedError);
    expect(error.outcome).toBe('failure');
    expect(error.rows.map((r: { n: number; status: string }) => [r.n, r.status])).toEqual([[1, 'duplicate_month'], [2, 'lower_than_previous']]);
    expect(error.message).toBe('Chưa lưu chỉ số nào: P101 (DH-101): đã có chỉ số tháng này (1.230); mở dòng đó để sửa; P105 (DH-105): nhỏ hơn chỉ số kỳ trước (2.210).');
    expect(invoke).toHaveBeenCalledWith('record_meter_readings_v2', expect.objectContaining({ p_building_id: B1 }));
  });

  it('lỗi khác giữ nguyên (quyền, idempotency khác nội dung); chi tiết không phải JSON thì không giả từ chối dòng', async () => {
    for (const error of [{ code: '42501', message: 'Không có quyền ghi chỉ số cho toà này' }, { code: '23505', message: 'idempotency_key đã dùng với nội dung khác' },
      { code: '22023', message: 'meter_readings_rejected', details: 'không phải json' }]) {
      expect(parseMeterReadingsRejection(error)).toBeNull();
      await expect(recordMeterReadings(async () => ({ data: null, error }), input)).rejects.toBe(error);
    }
  });

  it('kết quả phải đúng khuôn (không nhận null/thiếu id như thành công)', async () => {
    const ok = { buildingId: B1, readingDate: '2026-10-22', settlementMonth: '2026-10', count: 1, replaced: [],
      created: [{ n: 1, id: R1, code: 'CSS261000001', meterId: M1, previous: 1200, value: 1234, consumption: 34 }] };
    await expect(recordMeterReadings(async () => ({ data: ok, error: null }), input)).resolves.toMatchObject({ count: 1, created: [{ id: R1 }] });
    await expect(recordMeterReadings(async () => ({ data: null, error: null }), input)).rejects.toThrow();
    await expect(recordMeterReadings(async () => ({ data: { ...ok, created: [{ ...ok.created[0], id: 'x' }] }, error: null }), input)).rejects.toThrow();
  });

  it('câu từng dòng: mọi trạng thái có câu tiếng Việt; trạng thái lạ vẫn có câu chung', () => {
    expect(meterRejectedRowText({ n: 3, status: 'used_by_invoice', roomName: 'P103' })).toBe('P103: chỉ số tháng này đã lên hoá đơn; sửa bằng điều chỉnh hoá đơn');
    expect(meterRejectedRowText({ n: 4, status: 'meter_ambiguous' })).toBe('Dòng 4: phòng có nhiều công tơ cùng loại');
    expect(meterRejectedRowText({ status: 'gì đó' })).toBe('Một dòng: không ghi được');
  });
});
