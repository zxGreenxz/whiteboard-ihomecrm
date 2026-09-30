import {FinancialWorkflowError} from './financialWorkflowError';
export interface MeterReadingImportRowResult {
  reading_id: string | null;
  reading_code: string | null;
  success: boolean;
  error_message: string | null;
}

export class MeterReadingImportUnknownError extends FinancialWorkflowError {
  constructor(readonly confirmedIds: string[] = []) {
    super('Chưa xác nhận được đầy đủ kết quả nhập chỉ số. Đối chiếu danh sách chỉ số trước khi nhập lại file để tránh trùng.',confirmedIds.length?'partial':'unknown',[...new Set(confirmedIds)].map(id=>({id,label:'Chỉ số đã nhận mã'})));
  }
}

export function parseMeterReadingImportResult(raw: unknown, expectedCount: number): MeterReadingImportRowResult[] {
  const confirmedIds = Array.isArray(raw)
    ? raw.filter(row => row && typeof row === 'object' && row.success === true && typeof row.reading_id === 'string' && row.reading_id)
      .map(row => row.reading_id as string)
    : [];
  if (!Array.isArray(raw) || new Set(confirmedIds).size!==confirmedIds.length || raw.length !== expectedCount || raw.some(row =>
    !row || typeof row !== 'object' || typeof row.success !== 'boolean' ||
    (row.success && (typeof row.reading_id !== 'string' || !row.reading_id)) ||
    (!row.success && row.reading_id != null))) {
    throw new MeterReadingImportUnknownError(confirmedIds);
  }
  return raw.map(row => ({
    reading_id: row.success ? row.reading_id : null,
    reading_code: typeof row.reading_code === 'string' ? row.reading_code : null,
    success: row.success,
    error_message: row.success ? null :
      typeof row.error_message === 'string' && row.error_message.startsWith('Không tìm thấy công tơ với mã: ')
        ? row.error_message
        : 'Không nhập được dòng này. Kiểm tra công tơ, ngày và chỉ số trước khi thử lại.',
  }));
}
