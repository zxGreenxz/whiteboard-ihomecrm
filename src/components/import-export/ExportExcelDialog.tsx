// Dialog xuất Excel (Phase 9D) — UI chỉ chọn entity/format/relations và gọi
// runExportDataset. Query + phân trang + registry cột nằm ở
// hooks/exports/useExportDataset + lib/exportDatasetRegistry (0 supabase call
// trực tiếp ở đây). Lỗi export hiển thị Alert đỏ thay vì chỉ console.error.
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Download, FileSpreadsheet, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { runExportDataset, type ExportFilters } from '@/hooks/exports/useExportDataset';
import { EXPORT_DATASETS, type ExportEntity } from '@/lib/exportDatasetRegistry';

interface ExportExcelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exportType: ExportEntity;
  filters?: ExportFilters;
}

const ExportExcelDialog = ({
  open,
  onOpenChange,
  exportType,
  filters = {},
}: ExportExcelDialogProps) => {
  const [isExporting, setIsExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [includeRelations, setIncludeRelations] = useState(true);
  const [exportedCount, setExportedCount] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentConfig = EXPORT_DATASETS[exportType];

  const handleExport = async () => {
    setIsExporting(true);
    setExportedCount(null);
    setErrorMsg(null);
    try {
      const count = await runExportDataset({
        entity: exportType,
        includeRelations,
        filters,
      });
      setExportedCount(count);
    } catch (error) {
      console.error('Export error:', error);
      setErrorMsg(
        (error as Error)?.message ||
          'Xuất file thất bại — vui lòng thử lại hoặc thu hẹp bộ lọc.',
      );
    } finally {
      setIsExporting(false);
    }
  };

  const handleClose = () => {
    setExportedCount(null);
    setErrorMsg(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {currentConfig.title}
          </DialogTitle>
          <DialogDescription>{currentConfig.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Format Selection */}
          <div className="space-y-3">
            <Label>Định dạng file</Label>
            <RadioGroup
              value={exportFormat}
              onValueChange={(v) => setExportFormat(v as 'xlsx' | 'csv')}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="xlsx" id="xlsx" />
                <Label htmlFor="xlsx" className="font-normal cursor-pointer">
                  Excel (.xlsx)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="csv" id="csv" disabled />
                <Label htmlFor="csv" className="font-normal cursor-pointer text-gray-400">
                  CSV (.csv) - Sắp có
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Include Relations */}
          {EXPORT_DATASETS[exportType].relationsSelect && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="includeRelations"
                checked={includeRelations}
                onCheckedChange={(checked) => setIncludeRelations(checked as boolean)}
              />
              <Label htmlFor="includeRelations" className="font-normal cursor-pointer">
                Bao gồm thông tin liên quan (tên tòa nhà, khách hàng, v.v.)
              </Label>
            </div>
          )}

          {/* Filter Summary */}
          {Object.keys(filters).length > 0 && (
            <Alert>
              <AlertDescription>
                Đang áp dụng bộ lọc. Chỉ xuất các bản ghi phù hợp.
              </AlertDescription>
            </Alert>
          )}

          {/* Error Message — không im lặng tạo file thiếu */}
          {errorMsg && (
            <Alert className="bg-red-50 border-red-200">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800">{errorMsg}</AlertDescription>
            </Alert>
          )}

          {/* Success Message */}
          {exportedCount !== null && (
            <Alert className="bg-green-50 border-green-200">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800">
                Xuất file thành công! Đã tải xuống {exportedCount.toLocaleString('vi-VN')} dòng.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {exportedCount !== null ? 'Đóng' : 'Hủy'}
          </Button>
          <Button onClick={handleExport} disabled={isExporting}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang xuất...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Xuất file
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ExportExcelDialog;
