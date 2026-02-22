import { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Upload,
  FileSpreadsheet,
  Download,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import {
  parseExcelFile,
  importBuildings,
  importRooms,
  downloadImportTemplate,
  type ImportResult,
} from '@/lib/excelHelpers';

interface ImportExcelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importType: 'buildings' | 'rooms';
  onSuccess?: () => void;
}

const ImportExcelDialog = ({
  open,
  onOpenChange,
  importType,
  onSuccess,
}: ImportExcelDialogProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [previewData, setPreviewData] = useState<any[]>([]);

  const config = {
    buildings: {
      title: 'Import Tòa nhà',
      description: 'Tải lên file Excel chứa danh sách tòa nhà',
      templateName: 'Mẫu Import Tòa nhà',
      columns: ['name', 'address', 'floors', 'electricity_price', 'water_price'],
      columnLabels: ['Tên tòa nhà', 'Địa chỉ', 'Số tầng', 'Giá điện', 'Giá nước'],
    },
    rooms: {
      title: 'Import Căn hộ',
      description: 'Tải lên file Excel chứa danh sách căn hộ',
      templateName: 'Mẫu Import Căn hộ',
      columns: ['name', 'building_name', 'floor', 'room_type', 'area', 'max_occupants', 'rent_price'],
      columnLabels: ['Tên căn hộ', 'Tòa nhà', 'Tầng', 'Loại căn hộ', 'Diện tích', 'Số người tối đa', 'Giá thuê'],
    },
  };

  const currentConfig = config[importType];

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setResult(null);
    setProgress(0);

    try {
      // Parse and preview
      const headerMapping: Record<string, string> = {};
      currentConfig.columnLabels.forEach((label, idx) => {
        headerMapping[label] = currentConfig.columns[idx];
      });

      const parsed = await parseExcelFile(selectedFile, headerMapping);
      setPreviewData(parsed.slice(0, 5)); // Preview first 5 rows
    } catch (error) {
      console.error('Error parsing file:', error);
    }
  };

  const handleDownloadTemplate = () => {
    downloadImportTemplate(importType);
  };

  const handleImport = async () => {
    if (!file) return;

    setIsProcessing(true);
    setProgress(10);

    try {
      // Parse file
      const headerMapping: Record<string, string> = {};
      currentConfig.columnLabels.forEach((label, idx) => {
        headerMapping[label] = currentConfig.columns[idx];
      });

      const data = await parseExcelFile(file, headerMapping);
      setProgress(30);

      // Import data
      let importResult: ImportResult;

      if (importType === 'buildings') {
        importResult = await importBuildings(data, (p) => setProgress(30 + p * 0.7));
      } else {
        importResult = await importRooms(data, (p) => setProgress(30 + p * 0.7));
      }

      setProgress(100);
      setResult(importResult);

      if (importResult.successCount > 0 && onSuccess) {
        onSuccess();
      }
    } catch (error: any) {
      setResult({
        successCount: 0,
        errorCount: 1,
        errors: [{ row: 0, message: error.message }],
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    setFile(null);
    setResult(null);
    setPreviewData([]);
    setProgress(0);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {currentConfig.title}
          </DialogTitle>
          <DialogDescription>{currentConfig.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Download Template */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <p className="font-medium">Tải mẫu import</p>
              <p className="text-sm text-gray-500">
                Tải file mẫu Excel để điền dữ liệu đúng định dạng
              </p>
            </div>
            <Button variant="outline" onClick={handleDownloadTemplate}>
              <Download className="h-4 w-4 mr-2" />
              Tải mẫu
            </Button>
          </div>

          {/* File Upload */}
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              file ? 'border-green-300 bg-green-50' : 'border-gray-300 hover:border-primary'
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
            />

            {file ? (
              <div className="space-y-2">
                <FileSpreadsheet className="h-12 w-12 mx-auto text-green-600" />
                <p className="font-medium text-green-700">{file.name}</p>
                <p className="text-sm text-gray-500">
                  Click để chọn file khác
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="h-12 w-12 mx-auto text-gray-400" />
                <p className="font-medium">Click để chọn file Excel</p>
                <p className="text-sm text-gray-500">
                  Hỗ trợ định dạng .xlsx, .xls
                </p>
              </div>
            )}
          </div>

          {/* Preview Data */}
          {previewData.length > 0 && !result && (
            <div className="space-y-2">
              <p className="font-medium">Xem trước dữ liệu (5 dòng đầu)</p>
              <div className="border rounded-lg overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {currentConfig.columnLabels.map((label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewData.map((row, idx) => (
                      <TableRow key={idx}>
                        {currentConfig.columns.map((col) => (
                          <TableCell key={col}>
                            {row[col] || '-'}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Progress */}
          {isProcessing && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Đang xử lý...</span>
              </div>
              <Progress value={progress} />
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="space-y-3">
              {/* Summary */}
              <div className="flex gap-4">
                {result.successCount > 0 && (
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle className="h-5 w-5" />
                    <span className="font-medium">{result.successCount} thành công</span>
                  </div>
                )}
                {result.errorCount > 0 && (
                  <div className="flex items-center gap-2 text-red-600">
                    <XCircle className="h-5 w-5" />
                    <span className="font-medium">{result.errorCount} lỗi</span>
                  </div>
                )}
              </div>

              {/* Errors */}
              {result.errors.length > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <p className="font-medium mb-2">Các lỗi phát sinh:</p>
                    <ul className="list-disc list-inside space-y-1 text-sm">
                      {result.errors.slice(0, 10).map((err, idx) => (
                        <li key={idx}>
                          <Badge variant="outline" className="mr-2">
                            Dòng {err.row}
                          </Badge>
                          {err.message}
                        </li>
                      ))}
                      {result.errors.length > 10 && (
                        <li className="text-gray-500">
                          ... và {result.errors.length - 10} lỗi khác
                        </li>
                      )}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {/* Success message */}
              {result.successCount > 0 && result.errorCount === 0 && (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-800">
                    Import thành công! Đã thêm {result.successCount} bản ghi.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {result ? 'Đóng' : 'Hủy'}
          </Button>
          {!result && (
            <Button
              onClick={handleImport}
              disabled={!file || isProcessing}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Đang import...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Import
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ImportExcelDialog;
