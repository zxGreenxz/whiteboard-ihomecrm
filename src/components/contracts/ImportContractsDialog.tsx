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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Upload, Download, FileSpreadsheet, AlertTriangle, CheckCircle } from 'lucide-react';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBulkCreateContracts } from '@/hooks/useContracts';
import { downloadContractImportTemplate, importContracts, type ContractImportRow } from '@/lib/excelHelpers';

interface ImportContractsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ImportContractsDialog = ({ open, onOpenChange }: ImportContractsDialogProps) => {
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<ContractImportRow[] | null>(null);
  const [parseErrors, setParseErrors] = useState<Array<{ row: number; message: string }>>([]);
  const [importResult, setImportResult] = useState<{
    success: number;
    failed: number;
    errors: Array<{ row: number; message: string }>;
  } | null>(null);

  const { data: buildings } = useBuildings();
  const { data: allRooms } = useRooms();
  const bulkCreateMutation = useBulkCreateContracts();

  // Filter rooms for the selected building
  const buildingRooms = allRooms?.filter(r => r.building_id === selectedBuildingId) || [];
  const selectedBuilding = buildings?.find(b => b.id === selectedBuildingId);

  const handleClose = () => {
    setSelectedBuildingId('');
    setFile(null);
    setParsedData(null);
    setParseErrors([]);
    setImportResult(null);
    onOpenChange(false);
  };

  const handleDownloadTemplate = () => {
    if (!selectedBuilding) return;
    downloadContractImportTemplate(
      selectedBuilding.name,
      buildingRooms.map(r => ({ name: r.name }))
    );
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setImportResult(null);

    try {
      const result = await importContracts(selectedFile);
      setParsedData(result.success);
      setParseErrors(result.errors);
    } catch (err: any) {
      setParseErrors([{ row: 0, message: err.message || 'Loi doc file' }]);
      setParsedData(null);
    }
  };

  const handleImport = () => {
    if (!parsedData || parsedData.length === 0 || !selectedBuildingId) return;

    bulkCreateMutation.mutate(
      {
        building_id: selectedBuildingId,
        contracts: parsedData,
      },
      {
        onSuccess: (result) => {
          setImportResult(result);
          if (result.success > 0 && result.failed === 0) {
            // Auto-close after successful import
            setTimeout(() => handleClose(), 2000);
          }
        },
      }
    );
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files?.[0];
    if (!droppedFile) return;

    setFile(droppedFile);
    setImportResult(null);

    try {
      const result = await importContracts(droppedFile);
      setParsedData(result.success);
      setParseErrors(result.errors);
    } catch (err: any) {
      setParseErrors([{ row: 0, message: err.message || 'Loi doc file' }]);
      setParsedData(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Nhập hợp đồng từ file Excel
          </DialogTitle>
          <DialogDescription>
            Tạo hàng loạt hợp đồng từ file dữ liệu mẫu
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Step 1: Select Building */}
          <div className="space-y-2">
            <Label>Chọn tòa nhà bạn muốn lập hợp đồng *</Label>
            <Select
              value={selectedBuildingId}
              onValueChange={(value) => {
                setSelectedBuildingId(value);
                // Reset file and data when building changes
                setFile(null);
                setParsedData(null);
                setParseErrors([]);
                setImportResult(null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn tòa nhà..." />
              </SelectTrigger>
              <SelectContent>
                {buildings?.map((building) => (
                  <SelectItem key={building.id} value={building.id}>
                    {building.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Step 2: Download Template */}
          {selectedBuildingId && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleDownloadTemplate}
                  disabled={buildingRooms.length === 0}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Tải file mẫu tại đây
                </Button>
                <span className="text-sm text-gray-500">
                  ({buildingRooms.length} phòng trong tòa nhà)
                </span>
              </div>

              <div className="text-xs text-gray-500 space-y-1">
                <p>* Những mục đánh dấu (*) là những mục bắt buộc phải điền thông tin.</p>
                <p>* Bôi đen toàn bộ bảng → Định dạng file đưa về dạng "Text" trước khi nhập dữ liệu</p>
                <p>* Hãy xem ví dụ mẫu trước khi nhập dữ liệu để đảm bảo tính chính xác.</p>
              </div>
            </div>
          )}

          {/* Step 3: Upload File */}
          {selectedBuildingId && (
            <div className="space-y-2">
              <Label>Tải file dữ liệu lên</Label>
              <div
                className="relative border-2 border-dashed rounded-md p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-gray-50 transition-colors"
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
              >
                <Upload className="h-8 w-8 text-gray-400 mb-2" />
                <p className="text-sm text-gray-600">
                  {file ? file.name : 'Kéo thả file hoặc click để chọn'}
                </p>
                {file && (
                  <p className="text-xs text-green-600 mt-1">
                    File đã chọn: {file.name} ({Math.round(file.size / 1024)} KB)
                  </p>
                )}
                <Input
                  type="file"
                  accept=".xlsx,.xls"
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  onChange={handleFileChange}
                />
              </div>
            </div>
          )}

          {/* Parse Errors */}
          {parseErrors.length > 0 && (
            <Alert className="bg-red-50 border-red-200">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800">
                <p className="font-medium mb-1">Lỗi khi đọc file:</p>
                <ul className="list-disc list-inside text-sm">
                  {parseErrors.map((err, i) => (
                    <li key={i}>
                      {err.row > 0 ? `Dòng ${err.row}: ` : ''}{err.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Preview Data */}
          {parsedData && parsedData.length > 0 && (
            <div className="space-y-2">
              <Label>Xem trước dữ liệu ({parsedData.length} hợp đồng)</Label>
              <div className="border rounded-md overflow-x-auto max-h-60">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">STT</TableHead>
                      <TableHead className="text-xs">Phòng</TableHead>
                      <TableHead className="text-xs">Khách thuê</TableHead>
                      <TableHead className="text-xs">SĐT</TableHead>
                      <TableHead className="text-xs">Bắt đầu</TableHead>
                      <TableHead className="text-xs">Kết thúc</TableHead>
                      <TableHead className="text-xs text-right">Tiền thuê</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsedData.slice(0, 10).map((row, index) => (
                      <TableRow key={index}>
                        <TableCell className="text-xs">{index + 1}</TableCell>
                        <TableCell className="text-xs font-medium">{row.room_name}</TableCell>
                        <TableCell className="text-xs">{row.tenant_name}</TableCell>
                        <TableCell className="text-xs">{row.tenant_phone}</TableCell>
                        <TableCell className="text-xs">{row.start_date}</TableCell>
                        <TableCell className="text-xs">{row.end_date}</TableCell>
                        <TableCell className="text-xs text-right">
                          {row.rent_price.toLocaleString('vi-VN')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {parsedData.length > 10 && (
                  <div className="p-2 text-center text-xs text-gray-500">
                    ... và {parsedData.length - 10} hợp đồng khác
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Import Result */}
          {importResult && (
            <Alert className={importResult.success > 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}>
              {importResult.success > 0 ? (
                <CheckCircle className="h-4 w-4 text-green-600" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-red-600" />
              )}
              <AlertDescription>
                <p className="font-medium">
                  {importResult.success > 0
                    ? `Dữ liệu đã được TẠO thành công! (${importResult.success} hợp đồng)`
                    : 'Nhập dữ liệu thất bại'}
                </p>
                {importResult.failed > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-medium text-red-800">{importResult.failed} lỗi:</p>
                    <ul className="list-disc list-inside text-sm">
                      {importResult.errors.map((err, i) => (
                        <li key={i}>Dòng {err.row}: {err.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={handleClose}>
            {importResult && importResult.success > 0 ? 'Đóng' : 'Hủy'}
          </Button>
          <Button
            onClick={handleImport}
            disabled={
              !parsedData ||
              parsedData.length === 0 ||
              !selectedBuildingId ||
              bulkCreateMutation.isPending ||
              (importResult !== null && importResult.success > 0)
            }
          >
            {bulkCreateMutation.isPending ? 'Đang nhập dữ liệu...' : 'Nhập dữ liệu'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ImportContractsDialog;
