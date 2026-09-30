import { describe, expect, it } from 'vitest';
import { MeterReadingImportUnknownError, parseMeterReadingImportResult } from '../meterReadingImportResult';

describe('parseMeterReadingImportResult', () => {
  it('treats null and missing rows as unknown, never success', () => {
    expect(() => parseMeterReadingImportResult(null, 1)).toThrow(MeterReadingImportUnknownError);
    expect(() => parseMeterReadingImportResult([], 1)).toThrow(MeterReadingImportUnknownError);
  });
  it('retains confirmed IDs and sanitizes raw SQL row errors', () => {
    const rows = parseMeterReadingImportResult([
      { success: true, reading_id: 'id-1', reading_code: 'CSS1', error_message: null },
      { success: false, reading_id: null, reading_code: null, error_message: 'duplicate key value violates unique constraint' },
    ], 2);
    expect(rows[0]).toMatchObject({ success: true, reading_id: 'id-1' });
    expect(rows[1].error_message).not.toMatch(/duplicate key/i);
  });
});

it('duplicate successful IDs cannot confirm two imported rows',()=>{expect(()=>parseMeterReadingImportResult([{success:true,reading_id:'same'},{success:true,reading_id:'same'}],2)).toThrow(MeterReadingImportUnknownError);});
