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
import {
  downloadMeterReadingImportTemplate,
  parseMeterReadingExcel,
} from '@/lib/excelHelpers';
import { excelImportRowSchema, type ExcelImportRow } from '@/lib/meterReadingValidation';
import { useImportMeterReadings } from '@/hooks/useMeterReadings';
import { toast } from 'sonner';
import { Upload, Download, FileSpreadsheet, Loader2, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

interface MeterReadingImportDialogProps {
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

const MeterReadingImportDialog = ({ open, onOpenChange }: MeterReadingImportDialogProps) => {
  const [step, setStep] = useState<Step>('upload');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importMutation = useImportMeterReadings();

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
      const rawRows = await parseMeterReadingExcel(file);

      const validated: ParsedRow[] = rawRows.map((row, index) => {
        const result = excelImportRowSchema.safeParse(row);
        if (result.success) {
          return { rowIndex: index + 2, data: result.data, valid: true };
        }
        const errorMsg = result.error.issues.map((i) => i.message).join('; ');
        return {
          rowIndex: index + 2,
          data: row as ExcelImportRow,
          valid: false,
          error: errorMsg,
        };
      });

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
      // Reset input so the same file can be re-selected
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
      await importMutation.mutateAsync({
        readings: validRows.map((r) => ({
          meter_code: r.data.meter_code,
          reading_date: r.data.reading_date,
          current_reading: r.data.current_reading,
          notes: r.data.notes,
        })),
      });

      setImportResult({
        successCount: validRows.length,
        errorCount: invalidRows.length,
        errors: invalidRows.map((r) => ({
          row: r.rowIndex,
          message: r.error || 'Dữ liệu không hợp lệ',
        })),
      });
      setStep('result');
    } catch {
      // Error toast is handled by the mutation hook
    } finally {
      setIsProcessing(false);
    }
  }, [parsedRows, importMutation]);

  const validCount = parsedRows.filter((r) => r.valid).length;
  const invalidCount = parsedRows.filter((r) => !r.valid).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && 'Nhập dữ liệu chỉ số từ Excel'}
            {step === 'preview' && 'Xem trước dữ liệu'}
            {step === 'result' && 'Kết quả nhập dữ liệu'}
          </DialogTitle>
        </DialogHeader>

        {step === 'upload' && (
          <div className="space-y-4">
            <Button
              variant="link"
              className="p-0 h-auto text-blue-600"
              onClick={() => downloadMeterReadingImportTemplate()}
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
                <span className="text-green-600">
                  {validCount} hợp lệ
                </span>
                {invalidCount > 0 && (
                  <span className="text-red-600">
                    {invalidCount} lỗi
                  </span>
                )}
              </div>
            </div>

            <ScrollArea className="flex-1 max-h-[400px] border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Dòng</TableHead>
                    <TableHead>Mã công tơ</TableHead>
                    <TableHead>Ngày chốt</TableHead>
                    <TableHead className="text-right">Chỉ số mới</TableHead>
                    <TableHead>Ghi chú</TableHead>
                    <TableHead className="w-24">Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.map((row) => (
                    <TableRow
                      key={row.rowIndex}
                      className={!row.valid ? 'bg-red-50' : undefined}
                    >
                      <TableCell className="font-mono text-xs">
                        {row.rowIndex}
                      </TableCell>
                      <TableCell>{row.data.meter_code || '—'}</TableCell>
                      <TableCell>{row.data.reading_date || '—'}</TableCell>
                      <TableCell className="text-right">
                        {row.data.current_reading ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.data.notes || '—'}
                      </TableCell>
                      <TableCell>
                        {row.valid ? (
                          <Badge variant="outline" className="text-green-600 border-green-300">
                            OK
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">
                            Lỗi
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {parsedRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        File không có dữ liệu
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>

            {/* Show validation errors detail */}
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
              <Button variant="outline" onClick={() => { resetState(); }}>
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
              <Button onClick={() => handleOpenChange(false)}>
                Đóng
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default MeterReadingImportDialog;
