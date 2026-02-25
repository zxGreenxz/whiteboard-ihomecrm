/**
 * VehicleImportExportDialog
 * Dialog for importing vehicles from Excel and exporting vehicle list.
 * Requirements: 10.1, 10.2, 10.3, 10.5
 */

import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  downloadVehicleImportTemplate,
  parseVehicleExcel,
  type VehicleImportResult,
} from '@/lib/vehicleExcelHelpers';
import type { VehicleImportRow } from '@/types/vehicle';
import { Download, Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

// =============================================
// Props
// =============================================

interface VehicleImportExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (validRows: VehicleImportRow[]) => void;
}

// =============================================
// Component
// =============================================

export function VehicleImportExportDialog({
  open,
  onOpenChange,
  onImport,
}: VehicleImportExportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseResult, setParseResult] = useState<VehicleImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // ---- handlers ----

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setParseResult(null);
    setParseError(null);
  }

  function handleSelectFile() {
    fileInputRef.current?.click();
  }

  async function handleParse() {
    if (!selectedFile) return;
    setIsParsing(true);
    setParseResult(null);
    setParseError(null);
    try {
      const result = await parseVehicleExcel(selectedFile);
      setParseResult(result);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setIsParsing(false);
    }
  }

  function handleConfirmImport() {
    if (!parseResult) return;
    onImport(parseResult.validRows);
    handleClose();
  }

  function handleClose() {
    onOpenChange(false);
    // Reset state after dialog closes
    setTimeout(() => {
      setSelectedFile(null);
      setParseResult(null);
      setParseError(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }, 200);
  }

  // ---- derived ----

  const hasResult = parseResult !== null;
  const validCount = parseResult?.validRows.length ?? 0;
  const errorCount = parseResult?.errors.length ?? 0;
  const canConfirm = hasResult && validCount > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nhập / Xuất dữ liệu phương tiện</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="import">
          <TabsList className="w-full">
            <TabsTrigger value="import" className="flex-1">
              Nhập dữ liệu
            </TabsTrigger>
            <TabsTrigger value="export" className="flex-1">
              Xuất dữ liệu
            </TabsTrigger>
          </TabsList>

          {/* ── Import Tab ── */}
          <TabsContent value="import" className="space-y-4 pt-2">
            {/* Step 1: Download template */}
            <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/40">
              <div>
                <p className="text-sm font-medium">Bước 1: Tải file mẫu</p>
                <p className="text-xs text-muted-foreground">
                  Điền dữ liệu vào file mẫu trước khi nhập
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={downloadVehicleImportTemplate}
              >
                <Download className="mr-2 h-4 w-4" />
                Tải file mẫu
              </Button>
            </div>

            {/* Step 2: Upload file */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Bước 2: Chọn file Excel</p>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Upload zone */}
              <div
                onClick={handleSelectFile}
                className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/30 p-8 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
              >
                <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
                {selectedFile ? (
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(selectedFile.size / 1024).toFixed(1)} KB — Nhấn để đổi file
                    </p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">
                      Nhấn để chọn file hoặc kéo thả vào đây
                    </p>
                    <p className="text-xs text-muted-foreground">Hỗ trợ .xlsx, .xls</p>
                  </div>
                )}
              </div>
            </div>

            {/* Parse button */}
            <Button
              onClick={handleParse}
              disabled={!selectedFile || isParsing}
              className="w-full"
            >
              {isParsing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Đang xử lý...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Nhập dữ liệu
                </>
              )}
            </Button>

            {/* Parse error */}
            {parseError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{parseError}</AlertDescription>
              </Alert>
            )}

            {/* Parse result summary */}
            {hasResult && (
              <div className="space-y-3">
                {errorCount === 0 ? (
                  <Alert className="border-green-200 bg-green-50 text-green-800">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription>
                      {validCount} dòng hợp lệ, sẵn sàng nhập
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      {validCount} dòng hợp lệ, {errorCount} dòng lỗi
                    </AlertDescription>
                  </Alert>
                )}

                {/* Error table */}
                {errorCount > 0 && (
                  <div className="rounded-md border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-20">Dòng</TableHead>
                          <TableHead>Lỗi</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parseResult!.errors.map((err) => (
                          <TableRow key={err.row}>
                            <TableCell className="font-medium">{err.row}</TableCell>
                            <TableCell className="text-destructive text-sm">
                              {err.message}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {/* Confirm import button */}
                {canConfirm && (
                  <Button onClick={handleConfirmImport} className="w-full">
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Xác nhận nhập ({validCount} dòng)
                  </Button>
                )}
              </div>
            )}
          </TabsContent>

          {/* ── Export Tab ── */}
          <TabsContent value="export" className="pt-2">
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <FileSpreadsheet className="h-12 w-12 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Xuất danh sách phương tiện</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Xuất dữ liệu theo bộ lọc hiện tại từ trang danh sách
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Sử dụng nút <strong>Xuất</strong> trên thanh công cụ để xuất dữ liệu theo bộ lọc hiện tại.
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
