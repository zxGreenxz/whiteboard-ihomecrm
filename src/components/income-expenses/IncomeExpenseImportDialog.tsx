import { useState, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { parseExcelFile } from '@/lib/excelHelpers';
import { type ExcelImportRow } from '@/lib/incomeExpenseValidation';
import { validateImportRows } from '@/hooks/useIncomeExpensesHelpers';
import { useImportIncomeExpenses, type ImportIncomeExpenseRow } from '@/hooks/useIncomeExpenses';
import { useBuildings } from '@/hooks/useBuildings';
import { useIncomeExpenseTypes } from '@/hooks/useIncomeExpenseTypes';
import { toast } from 'sonner';
import {
  Upload,
  Download,
  FileSpreadsheet,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import * as XLSX from 'xlsx';

interface IncomeExpenseImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedRow {
  rowIndex: number;
  data: ExcelImportRow;
  valid: boolean;
  error?: string;
}

interface ImportResult {
  successCount: number;
  errorCount: number;
  errors: Array<{ row: number; message: string }>;
}

type Step = 'upload' | 'preview' | 'result';

// Header mapping: Vietnamese Excel headers → ExcelImportRow field names
const HEADER_MAPPING: Record<string, keyof ExcelImportRow> = {
  'Loại phiếu (*)': 'type',
  'Căn hộ (*)': 'building_name',
  'Phòng': 'room_name',
  'Tên phiếu (*)': 'name',
  'Ngày (*)': 'voucher_date',
  'Hạng mục (*)': 'item_name',
  'Số tiền (*)': 'amount',
};

function downloadIncomeExpenseImportTemplate(): void {
  const sampleData = [
    {
      'Loại phiếu (*)': 'Thu',
      'Căn hộ (*)': 'Tòa nhà ABC',
      'Phòng': 'Phòng 101',
      'Tên phiếu (*)': 'Thu tiền điện tháng 1',
      'Ngày (*)': '2025-01-15',
      'Hạng mục (*)': 'Tiền điện',
      'Số tiền (*)': 500000,
    },
    {
      'Loại phiếu (*)': 'Chi',
      'Căn hộ (*)': 'Tòa nhà ABC',
      'Phòng': 'Phòng 102',
      'Tên phiếu (*)': 'Chi sửa chữa',
      'Ngày (*)': '2025-01-16',
      'Hạng mục (*)': 'Sửa chữa',
      'Số tiền (*)': 200000,
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleData);

  worksheet['!cols'] = [
    { wch: 15 },
    { wch: 20 },
    { wch: 15 },
    { wch: 25 },
    { wch: 15 },
    { wch: 20 },
    { wch: 15 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Mẫu thu chi');

  XLSX.writeFile(workbook, 'mau-nhap-thu-chi.xlsx');
}

/**
 * Normalize type value from Excel: "Thu"/"INCOME" → "INCOME", "Chi"/"EXPENSE" → "EXPENSE"
 */
function normalizeType(value: any): string {
  if (!value) return '';
  const str = String(value).trim().toLowerCase();
  if (str === 'thu' || str === 'income') return 'INCOME';
  if (str === 'chi' || str === 'expense') return 'EXPENSE';
  return String(value).trim();
}

/**
 * Normalize date value from Excel (handle serial dates and dd/MM/yyyy)
 */
function normalizeDate(value: any): string {
  if (!value) return '';
  // Excel serial date number
  if (typeof value === 'number' && value > 30000) {
    const date = new Date((value - 25569) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
  const str = String(value).trim();
  // dd/MM/yyyy → yyyy-MM-dd
  const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return str;
}

const IncomeExpenseImportDialog = ({ open, onOpenChange }: IncomeExpenseImportDialogProps) => {
  const [step, setStep] = useState<Step>('upload');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importMutation = useImportIncomeExpenses();
  const { data: buildings } = useBuildings();
  const { data: incomeTypes } = useIncomeExpenseTypes('income');
  const { data: expenseTypes } = useIncomeExpenseTypes('expense');

  const resetState = useCallback(() => {
    setStep('upload');
    setParsedRows([]);
    setFileName('');
    setIsDragging(false);
    setIsProcessing(false);
    setImportResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) resetState();
      onOpenChange(newOpen);
    },
    [onOpenChange, resetState]
  );

  const processFile = useCallback(async (file: File) => {
    const validExtensions = ['.xlsx', '.xls'];
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (!validExtensions.includes(ext)) {
      toast.error('File không đúng định dạng. Vui lòng sử dụng file Excel (.xlsx, .xls)');
      return;
    }

    setIsProcessing(true);
    setFileName(file.name);

    try {
      const rawRows = await parseExcelFile<Record<string, any>>(file, HEADER_MAPPING as any);

      // Normalize raw rows before validation
      const normalizedRows = rawRows.map((row) => ({
        ...row,
        type: normalizeType(row.type),
        voucher_date: normalizeDate(row.voucher_date),
        amount: typeof row.amount === 'number' ? row.amount : Number(row.amount) || 0,
      }));

      // Use validateImportRows helper for validation
      const { validRows, errors } = validateImportRows(normalizedRows);

      // Build a set of error row indices for quick lookup
      const errorIndices = new Set(errors.map((e) => e.row));

      const validated: ParsedRow[] = [];

      // Track which valid row to use next
      let validIdx = 0;
      for (let i = 0; i < normalizedRows.length; i++) {
        if (errorIndices.has(i)) {
          const err = errors.find((e) => e.row === i)!;
          validated.push({
            rowIndex: i + 2, // +2 for 1-indexed + header row
            data: normalizedRows[i] as ExcelImportRow,
            valid: false,
            error: err.errors.join('; '),
          });
        } else if (validIdx < validRows.length) {
          validated.push({
            rowIndex: i + 2,
            data: validRows[validIdx],
            valid: true,
          });
          validIdx++;
        }
      }

      setParsedRows(validated);
      setStep('preview');
    } catch {
      toast.error('Không thể đọc file Excel. Vui lòng kiểm tra định dạng file.');
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
      e.target.value = '';
    },
    [processFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleImport = useCallback(async () => {
    const validRows = parsedRows.filter((r) => r.valid);
    const invalidRows = parsedRows.filter((r) => !r.valid);

    if (validRows.length === 0) {
      toast.error('Không có dòng dữ liệu hợp lệ để nhập');
      return;
    }

    setIsProcessing(true);

    try {
      // Resolve building names → building IDs and item names → type IDs
      const allTypes = [...(incomeTypes || []), ...(expenseTypes || [])];
      const resolvedRows: ImportIncomeExpenseRow[] = [];
      const resolveErrors: Array<{ row: number; message: string }> = [];

      for (const row of validRows) {
        const building = buildings?.find(
          (b: any) => b.name.toLowerCase() === row.data.building_name.toLowerCase()
        );
        if (!building) {
          resolveErrors.push({
            row: row.rowIndex,
            message: `Không tìm thấy căn hộ "${row.data.building_name}"`,
          });
          continue;
        }

        const matchType = row.data.type === 'INCOME' ? 'income' : 'expense';
        const expenseType = allTypes.find(
          (t: any) =>
            t.name.toLowerCase() === row.data.item_name.toLowerCase() &&
            t.type === matchType
        );
        if (!expenseType) {
          resolveErrors.push({
            row: row.rowIndex,
            message: `Không tìm thấy hạng mục "${row.data.item_name}" (loại ${matchType})`,
          });
          continue;
        }

        resolvedRows.push({
          ...row.data,
          building_id: building.id,
          income_expense_type_id: expenseType.id,
        });
      }

      if (resolvedRows.length === 0 && resolveErrors.length > 0) {
        setImportResult({
          successCount: 0,
          errorCount: invalidRows.length + resolveErrors.length,
          errors: [
            ...invalidRows.map((r) => ({
              row: r.rowIndex,
              message: r.error || 'Dữ liệu không hợp lệ',
            })),
            ...resolveErrors,
          ],
        });
        setStep('result');
        setIsProcessing(false);
        return;
      }

      const result = await importMutation.mutateAsync(resolvedRows);

      setImportResult({
        successCount: result.successCount,
        errorCount: result.failedCount + invalidRows.length + resolveErrors.length,
        errors: [
          ...invalidRows.map((r) => ({
            row: r.rowIndex,
            message: r.error || 'Dữ liệu không hợp lệ',
          })),
          ...resolveErrors,
          ...result.errors,
        ],
      });
      setStep('result');
    } catch {
      // Error toast handled by mutation hook
    } finally {
      setIsProcessing(false);
    }
  }, [parsedRows, buildings, incomeTypes, expenseTypes, importMutation]);

  const validCount = parsedRows.filter((r) => r.valid).length;
  const invalidCount = parsedRows.filter((r) => !r.valid).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && 'Nhập dữ liệu thu chi từ Excel'}
            {step === 'preview' && 'Xem trước dữ liệu'}
            {step === 'result' && 'Kết quả nhập dữ liệu'}
          </DialogTitle>
        </DialogHeader>

        {step === 'upload' && (
          <div className="space-y-4">
            <Button
              variant="link"
              className="p-0 h-auto text-blue-600"
              onClick={() => downloadIncomeExpenseImportTemplate()}
            >
              <Download className="h-4 w-4 mr-1" />
              Tải file mẫu tại đây
            </Button>

            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                isDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleFileSelect}
              />
              {isProcessing ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Đang xử lý file...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-10 w-10 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    Kéo thả file vào đây hoặc nhấn để chọn file
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Hỗ trợ file Excel (.xlsx, .xls)
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {step === 'preview' && (
          <div className="flex flex-col gap-4 min-h-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{fileName}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-green-600">{validCount} hợp lệ</span>
                {invalidCount > 0 && (
                  <span className="text-red-600">{invalidCount} lỗi</span>
                )}
              </div>
            </div>

            <ScrollArea className="flex-1 max-h-[400px] border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Dòng</TableHead>
                    <TableHead className="w-16">Loại</TableHead>
                    <TableHead>Căn hộ</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Tên phiếu</TableHead>
                    <TableHead>Ngày</TableHead>
                    <TableHead>Hạng mục</TableHead>
                    <TableHead className="text-right">Số tiền</TableHead>
                    <TableHead className="w-20">Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.map((row) => (
                    <TableRow
                      key={row.rowIndex}
                      className={!row.valid ? 'bg-red-50' : undefined}
                    >
                      <TableCell className="font-mono text-xs">{row.rowIndex}</TableCell>
                      <TableCell>
                        {row.data.type === 'INCOME' ? (
                          <Badge variant="outline" className="text-green-600 border-green-300">Thu</Badge>
                        ) : row.data.type === 'EXPENSE' ? (
                          <Badge variant="outline" className="text-red-600 border-red-300">Chi</Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>{row.data.building_name || '—'}</TableCell>
                      <TableCell>{row.data.room_name || '—'}</TableCell>
                      <TableCell>{row.data.name || '—'}</TableCell>
                      <TableCell>{row.data.voucher_date || '—'}</TableCell>
                      <TableCell>{row.data.item_name || '—'}</TableCell>
                      <TableCell className="text-right">
                        {row.data.amount != null
                          ? Number(row.data.amount).toLocaleString('vi-VN')
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {row.valid ? (
                          <Badge variant="outline" className="text-green-600 border-green-300">OK</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">Lỗi</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {parsedRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        File không có dữ liệu
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>

            {invalidCount > 0 && (
              <div className="border border-red-200 rounded-md p-3 bg-red-50 text-sm space-y-1">
                <p className="font-medium text-red-700 flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  Chi tiết lỗi:
                </p>
                {parsedRows
                  .filter((r) => !r.valid)
                  .map((r) => (
                    <p key={r.rowIndex} className="text-red-600 ml-5">
                      Dòng {r.rowIndex}: {r.error}
                    </p>
                  ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => resetState()}>
                Chọn file khác
              </Button>
              <Button
                onClick={handleImport}
                disabled={validCount === 0 || isProcessing}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Đang nhập...
                  </>
                ) : (
                  `Nhập dữ liệu (${validCount} dòng)`
                )}
              </Button>
            </div>
          </div>
        )}

        {step === 'result' && importResult && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <p className="text-lg font-medium">Hoàn tất nhập dữ liệu</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="border rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-green-600">
                  {importResult.successCount}
                </p>
                <p className="text-sm text-muted-foreground">Bản ghi thành công</p>
              </div>
              <div className="border rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-red-600">
                  {importResult.errorCount}
                </p>
                <p className="text-sm text-muted-foreground">Bản ghi lỗi</p>
              </div>
            </div>

            {importResult.errors.length > 0 && (
              <div className="border border-red-200 rounded-md p-3 bg-red-50 text-sm space-y-1">
                <p className="font-medium text-red-700 flex items-center gap-1">
                  <XCircle className="h-4 w-4" />
                  Chi tiết lỗi:
                </p>
                {importResult.errors.map((err, idx) => (
                  <p key={idx} className="text-red-600 ml-5">
                    Dòng {err.row}: {err.message}
                  </p>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={() => handleOpenChange(false)}>Đóng</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default IncomeExpenseImportDialog;