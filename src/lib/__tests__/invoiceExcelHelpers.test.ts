import { describe, it, expect } from 'vitest';

import {
  generateInvoiceTemplate,
  parseInvoiceBuffer,
  validateParsedRows,
  type ParsedInvoiceRow,
  type TemplateBuildingInfo,
  type TemplateRoomInfo,
  type TemplateServiceInfo,
} from '../invoiceExcelHelpers';
import * as XLSX from 'xlsx';

// =============================================
// Test Helpers
// =============================================

const building: TemplateBuildingInfo = { id: 'b1', name: 'Toà A' };

const services: TemplateServiceInfo[] = [
  { id: 's1', name: 'Điện' },
  { id: 's2', name: 'Nước' },
  { id: 's3', name: 'Wifi' },
];

const rooms: TemplateRoomInfo[] = [
  { id: 'r1', name: 'Phòng 101', active_service_ids: ['s1', 's2'] },
  { id: 'r2', name: 'Phòng 102', active_service_ids: ['s1', 's2', 's3'] },
  { id: 'r3', name: 'Phòng 103', active_service_ids: [] },
];

function blobToWorkbook(blob: Blob): Promise<XLSX.WorkBook> {
  return blob.arrayBuffer().then((buf) => {
    const data = new Uint8Array(buf);
    return XLSX.read(data, { type: 'array' });
  });
}

function createExcelBuffer(rows: Record<string, any>[], sheetName = 'Hoá đơn'): ArrayBuffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return buf;
}

// =============================================
// generateInvoiceTemplate
// =============================================

describe('generateInvoiceTemplate', () => {
  it('should return a Blob', () => {
    const result = generateInvoiceTemplate(building, rooms, services);
    expect(result).toBeInstanceOf(Blob);
  });

  it('should create valid Excel with correct headers', async () => {
    const blob = generateInvoiceTemplate(building, rooms, services);
    const wb = await blobToWorkbook(blob);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { header: 1 });

    const headers = json[0] as string[];
    expect(headers[0]).toBe('Phòng (*)');
    expect(headers[1]).toBe('Giường');
    expect(headers[2]).toBe('Điện');
    expect(headers[3]).toBe('Nước');
    expect(headers[4]).toBe('Wifi');
  });

  it('should pre-fill room names', async () => {
    const blob = generateInvoiceTemplate(building, rooms, services);
    const wb = await blobToWorkbook(blob);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws);

    expect(json[0]['Phòng (*)']).toBe('Phòng 101');
    expect(json[1]['Phòng (*)']).toBe('Phòng 102');
    expect(json[2]['Phòng (*)']).toBe('Phòng 103');
  });

  it('should mark N/A for services not in use', async () => {
    const blob = generateInvoiceTemplate(building, rooms, services);
    const wb = await blobToWorkbook(blob);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws);

    // Room 101 uses Điện and Nước but not Wifi
    expect(json[0]['Wifi']).toBe('N/A');
    // Room 103 uses no services
    expect(json[2]['Điện']).toBe('N/A');
    expect(json[2]['Nước']).toBe('N/A');
    expect(json[2]['Wifi']).toBe('N/A');
  });

  it('should handle rooms with beds', async () => {
    const roomsWithBeds: TemplateRoomInfo[] = [
      {
        id: 'r1',
        name: 'Phòng 201',
        bed_names: ['Giường A', 'Giường B'],
        active_service_ids: ['s1'],
      },
    ];

    const blob = generateInvoiceTemplate(building, roomsWithBeds, services);
    const wb = await blobToWorkbook(blob);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws);

    expect(json).toHaveLength(2);
    expect(json[0]['Phòng (*)']).toBe('Phòng 201');
    expect(json[0]['Giường']).toBe('Giường A');
    expect(json[1]['Phòng (*)']).toBe('Phòng 201');
    expect(json[1]['Giường']).toBe('Giường B');
  });

  it('should handle empty rooms array', () => {
    const blob = generateInvoiceTemplate(building, [], services);
    expect(blob).toBeInstanceOf(Blob);
  });

  it('should handle empty services array', async () => {
    const blob = generateInvoiceTemplate(building, rooms, []);
    const wb = await blobToWorkbook(blob);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { header: 1 });

    const headers = json[0] as string[];
    expect(headers).toHaveLength(2); // Only Phòng and Giường
  });
});

// =============================================
// parseInvoiceBuffer
// =============================================

describe('parseInvoiceBuffer', () => {
  it('should parse a valid Excel buffer', () => {
    const buf = createExcelBuffer([
      { 'Phòng (*)': 'Phòng 101', 'Giường': '', 'Điện': 150, 'Nước': 20 },
      { 'Phòng (*)': 'Phòng 102', 'Giường': 'Giường A', 'Điện': 200, 'Nước': 30 },
    ]);

    const result = parseInvoiceBuffer(buf);

    expect(result).toHaveLength(2);
    expect(result[0].room_name).toBe('Phòng 101');
    expect(result[0].services['Điện']).toBe(150);
    expect(result[0].services['Nước']).toBe(20);
    expect(result[1].bed_name).toBe('Giường A');
  });

  it('should skip N/A service values', () => {
    const buf = createExcelBuffer([
      { 'Phòng (*)': 'Phòng 101', 'Giường': '', 'Điện': 100, 'Wifi': 'N/A' },
    ]);

    const result = parseInvoiceBuffer(buf);

    expect(result[0].services).toHaveProperty('Điện');
    expect(result[0].services).not.toHaveProperty('Wifi');
  });

  it('should handle non-numeric service values as NaN', () => {
    const buf = createExcelBuffer([
      { 'Phòng (*)': 'Phòng 101', 'Giường': '', 'Điện': 'abc' },
    ]);

    const result = parseInvoiceBuffer(buf);

    expect(isNaN(result[0].services['Điện'])).toBe(true);
  });

  it('should handle empty bed column', () => {
    const buf = createExcelBuffer([
      { 'Phòng (*)': 'Phòng 101', 'Giường': '' },
    ]);

    const result = parseInvoiceBuffer(buf);
    expect(result[0].bed_name).toBeUndefined();
  });
});

// =============================================
// validateParsedRows
// =============================================

describe('validateParsedRows', () => {
  it('should pass valid rows', () => {
    const rows: ParsedInvoiceRow[] = [
      { room_name: 'Phòng 101', services: { 'Điện': 150, 'Nước': 20 } },
      { room_name: 'Phòng 102', bed_name: 'Giường A', services: { 'Điện': 200 } },
    ];

    const result = validateParsedRows(rows);

    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject rows with missing room_name', () => {
    const rows: ParsedInvoiceRow[] = [
      { room_name: '', services: { 'Điện': 100 } },
    ];

    const result = validateParsedRows(rows);

    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(2); // row 2 in Excel (header is row 1)
    expect(result.errors[0].message).toContain('Thiếu tên phòng');
  });

  it('should reject rows with NaN service amounts', () => {
    const rows: ParsedInvoiceRow[] = [
      { room_name: 'Phòng 101', services: { 'Điện': NaN } },
    ];

    const result = validateParsedRows(rows);

    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('không phải số hợp lệ');
  });

  it('should reject rows with negative service amounts', () => {
    const rows: ParsedInvoiceRow[] = [
      { room_name: 'Phòng 101', services: { 'Điện': -5 } },
    ];

    const result = validateParsedRows(rows);

    expect(result.valid).toHaveLength(0);
    expect(result.errors[0].message).toContain('không được âm');
  });

  it('should separate valid and invalid rows', () => {
    const rows: ParsedInvoiceRow[] = [
      { room_name: 'Phòng 101', services: { 'Điện': 100 } },
      { room_name: '', services: { 'Điện': 200 } },
      { room_name: 'Phòng 103', services: { 'Điện': 300 } },
    ];

    const result = validateParsedRows(rows);

    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3); // second data row = Excel row 3
  });

  it('should handle empty rows array', () => {
    const result = validateParsedRows([]);

    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should report multiple errors per row', () => {
    const rows: ParsedInvoiceRow[] = [
      { room_name: '', services: { 'Điện': NaN, 'Nước': -1 } },
    ];

    const result = validateParsedRows(rows);

    expect(result.errors).toHaveLength(1);
    // Should contain all three errors in one message
    expect(result.errors[0].message).toContain('Thiếu tên phòng');
    expect(result.errors[0].message).toContain('không phải số hợp lệ');
    expect(result.errors[0].message).toContain('không được âm');
  });
});
