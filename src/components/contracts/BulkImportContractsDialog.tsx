import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Download, Upload, FileSpreadsheet, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { generateContractExcelTemplate } from '@/utils/contractExcelTemplate';
import { parseContractExcel, ParseResult } from '@/utils/contractExcelParser';
import { useBulkImportContracts, BulkImportResult } from '@/hooks/useContracts';
import { toast } from 'sonner';

interface BulkImportContractsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'upload' | 'preview' | 'importing' | 'result';

const BulkImportContractsDialog = ({ open, onOpenChange }: BulkImportContractsDialogProps) => {
  const [step, setStep] = useState<Step>('upload');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);

  const bulkImportMutation = useBulkImportContracts();

  const handleClose = () => {
    setStep('upload');
    setSelectedFile(null);
    setParseResult(null);
    setImportResult(null);
    onOpenChange(false);
  };

  const handleDownloadTemplate = () => {
    generateContractExcelTemplate();
    toast.success('Template đã được tải xuống');
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);

    // Parse Excel file
    const result = await parseContractExcel(file);
    setParseResult(result);

    if (result.success && result.data.length > 0) {
      setStep('preview');
    } else if (result.errors.length > 0) {
      setStep('preview'); // Show errors
    }
  };

  const handleImport = async () => {
    if (!parseResult || parseResult.data.length === 0) return;

    setStep('importing');

    try {
      const result = await bulkImportMutation.mutateAsync(parseResult.data);
      setImportResult(result);
      setStep('result');
    } catch (error) {
      toast.error('Import thất bại: ' + (error instanceof Error ? error.message : 'Unknown error'));
      setStep('preview');
    }
  };

  const renderUploadStep = () => (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Bước 1: Tải template Excel</h3>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={handleDownloadTemplate}
        >
          <Download className="h-4 w-4 mr-2" />
          Tải template mẫu
        </Button>
        <p className="text-xs text-gray-500">
          Tải file Excel template và điền thông tin hợp đồng theo mẫu
        </p>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Bước 2: Upload file đã điền</h3>
        <div className="relative border-2 border-dashed rounded-md p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-gray-50 transition-colors">
          <FileSpreadsheet className="h-12 w-12 text-gray-400 mb-3" />
          <p className="text-sm text-gray-600 mb-1">
            {selectedFile ? selectedFile.name : 'Kéo thả file Excel hoặc click để chọn'}
          </p>
          <p className="text-xs text-gray-400">Hỗ trợ file .xlsx, .xls</p>
          <Input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            id="excel-file-upload"
            onChange={handleFileChange}
          />
          <label htmlFor="excel-file-upload" className="absolute inset-0 cursor-pointer"></label>
        </div>
      </div>

      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="text-xs">
          <strong>Lưu ý:</strong> Trước khi import, hãy đảm bảo:
          <ul className="list-disc list-inside mt-1 space-y-1">
            <li>Tòa nhà, phòng, giường đã tồn tại trong hệ thống</li>
            <li>Phòng/giường có trạng thái AVAILABLE (trống)</li>
            <li>Các dịch vụ (Điện, Nước, etc) đã được tạo trước</li>
            <li>Ngày tháng đúng định dạng dd-mm-yyyy</li>
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  );

  const renderPreviewStep = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-medium">Xem trước dữ liệu</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setStep('upload');
            setSelectedFile(null);
            setParseResult(null);
          }}
        >
          Chọn file khác
        </Button>
      </div>

      {parseResult && parseResult.errors.length > 0 && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Tìm thấy {parseResult.errors.length} lỗi:</strong>
            <ul className="list-disc list-inside mt-2 space-y-1 max-h-40 overflow-y-auto">
              {parseResult.errors.map((err, idx) => (
                <li key={idx}>
                  Dòng {err.row}: {err.message}
                  {err.column && ` (Cột ${err.column})`}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {parseResult && parseResult.data.length > 0 && (
        <>
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Tìm thấy {parseResult.data.length} hợp đồng hợp lệ</strong>
            </AlertDescription>
          </Alert>

          <div className="border rounded-md max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="p-2 text-left font-medium text-gray-500">Dòng</th>
                  <th className="p-2 text-left font-medium text-gray-500">Căn hộ</th>
                  <th className="p-2 text-left font-medium text-gray-500">Phòng</th>
                  <th className="p-2 text-left font-medium text-gray-500">Khách hàng</th>
                  <th className="p-2 text-left font-medium text-gray-500">Tiền thuê</th>
                  <th className="p-2 text-left font-medium text-gray-500">Ngày bắt đầu</th>
                </tr>
              </thead>
              <tbody>
                {parseResult.data.map((row) => (
                  <tr key={row.rowIndex} className="border-t hover:bg-gray-50">
                    <td className="p-2">{row.rowIndex}</td>
                    <td className="p-2">{row.building}</td>
                    <td className="p-2">{row.room} {row.bed && `- ${row.bed}`}</td>
                    <td className="p-2">{row.tenant_name}</td>
                    <td className="p-2">{row.rent_price.toLocaleString('vi-VN')} đ</td>
                    <td className="p-2">{row.start_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );

  const renderImportingStep = () => (
    <div className="space-y-6 py-8">
      <div className="text-center space-y-4">
        <Upload className="h-12 w-12 text-green-600 mx-auto animate-pulse" />
        <h3 className="text-lg font-medium">Đang import hợp đồng...</h3>
        <p className="text-sm text-gray-500">Vui lòng đợi, quá trình này có thể mất vài phút</p>
      </div>
      <Progress value={undefined} className="w-full" />
    </div>
  );

  const renderResultStep = () => (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        {importResult && importResult.failed === 0 ? (
          <>
            <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto" />
            <h3 className="text-lg font-medium">Import thành công!</h3>
            <p className="text-sm text-gray-600">
              Đã tạo <strong>{importResult.success}</strong> hợp đồng
            </p>
          </>
        ) : (
          <>
            <AlertCircle className="h-16 w-16 text-yellow-600 mx-auto" />
            <h3 className="text-lg font-medium">Import hoàn tất với một số lỗi</h3>
            <div className="space-y-2">
              <p className="text-sm text-green-600">
                Thành công: <strong>{importResult?.success}</strong>
              </p>
              <p className="text-sm text-red-600">
                Thất bại: <strong>{importResult?.failed}</strong>
              </p>
            </div>
          </>
        )}
      </div>

      {importResult && importResult.errors.length > 0 && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Chi tiết lỗi:</strong>
            <ul className="list-disc list-inside mt-2 space-y-1 max-h-60 overflow-y-auto">
              {importResult.errors.map((err, idx) => (
                <li key={idx}>
                  Dòng {err.row}: {err.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl text-green-700 uppercase">
            Import hợp đồng từ Excel
          </DialogTitle>
        </DialogHeader>

        <div className="py-4">
          {step === 'upload' && renderUploadStep()}
          {step === 'preview' && renderPreviewStep()}
          {step === 'importing' && renderImportingStep()}
          {step === 'result' && renderResultStep()}
        </div>

        <DialogFooter className="gap-2">
          {step === 'upload' && (
            <Button type="button" variant="outline" onClick={handleClose}>
              Đóng
            </Button>
          )}

          {step === 'preview' && (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                Hủy
              </Button>
              <Button
                type="button"
                className="bg-green-600 hover:bg-green-700"
                onClick={handleImport}
                disabled={!parseResult || parseResult.data.length === 0}
              >
                <Upload className="h-4 w-4 mr-2" />
                Import {parseResult?.data.length || 0} hợp đồng
              </Button>
            </>
          )}

          {step === 'result' && (
            <Button type="button" className="bg-green-600 hover:bg-green-700" onClick={handleClose}>
              Hoàn tất
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkImportContractsDialog;
