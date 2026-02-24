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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Upload,
  FileSpreadsheet,
  Download,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Building2,
  Loader2,
} from 'lucide-react';
import {
  useImportInvoicesFromExcel,
  type ImportInvoicesResult,
} from '@/hooks/useInvoicePayments';
import { generateInvoiceTemplate } from '@/lib/invoiceExcelHelpers';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useServices } from '@/hooks/useServices';
import { format } from 'date-fns';

interface ImportExcelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ImportExcelDialog = ({ open, onOpenChange }: ImportExcelDialogProps) => {
  const currentMonth = format(new Date(), 'yyyy-MM');
  const [billingMonth, setBillingMonth] = useState(currentMonth);
  const [buildingId, setBuildingId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportInvoicesResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importMutation = useImportInvoicesFromExcel();
  const { data: buildings } = useBuildings();
  const { data: rooms } = useRooms(buildingId || undefined);
  const { data: services } = useServices();

  const handleClose = () => {
    setBillingMonth(currentMonth);
    setBuildingId('');
    setFile(null);
    setResult(null);
    onOpenChange(false);
  };

  const handleDownloadTemplate = () => {
    if (!buildingId) return;

    const building = buildings?.find((b) => b.id === buildingId);
    if (!building) return;

    const templateRooms = (rooms || []).map((r: any) => ({
      id: r.id,
      name: r.name,
      bed_names: r.beds?.map((b: any) => b.name) || [],
      active_service_ids: [],
    }));

    const templateServices = (services || []).map((s: any) => ({
      id: s.id,
      name: s.name,
    }));

    const blob = generateInvoiceTemplate(
      { id: building.id, name: building.name },
      templateRooms,
      templateServices,
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Mau_hoa_don_${building.name}_${billingMonth}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setResult(null);
    }
  };

  const handleImport = () => {
    if (!file || !buildingId || !billingMonth) return;

    importMutation.mutate(
      { file, buildingId, billingMonth },
      {
        onSuccess: (data) => {
          setResult(data);
        },
      },
    );
  };

  const isValid = !!buildingId && !!billingMonth;
  const canImport = isValid && !!file && !importMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-blue-600" />
            Chi tiết nhập dữ liệu
          </DialogTitle>
          <DialogDescription>
            Nhập hoá đơn hàng loạt từ file Excel cho toà nhà
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Kỳ thanh toán */}
          <div className="space-y-2">
            <Label htmlFor="import_billing_month">Chọn tháng *</Label>
            <Input
              id="import_billing_month"
              type="month"
              value={billingMonth}
              onChange={(e) => setBillingMonth(e.target.value)}
              required
            />
          </div>

          {/* Toà nhà */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Chọn toà nhà *
            </Label>
            <Select value={buildingId} onValueChange={(v) => { setBuildingId(v); setFile(null); setResult(null); }}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn toà nhà" />
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

          {/* Download template */}
          {isValid && (
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <p className="text-sm font-medium">File mẫu</p>
                <p className="text-xs text-gray-500">
                  Tải file mẫu Excel để điền dữ liệu
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
                <Download className="h-4 w-4 mr-1" />
                Tải file mẫu tại đây
              </Button>
            </div>
          )}

          {/* File upload */}
          <div className="space-y-2">
            <Label>Upload file Excel</Label>
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
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
                <div className="space-y-1">
                  <FileSpreadsheet className="h-8 w-8 mx-auto text-green-600" />
                  <p className="text-sm font-medium text-green-700">{file.name}</p>
                  <p className="text-xs text-gray-500">Click để chọn file khác</p>
                </div>
              ) : (
                <div className="space-y-1">
                  <Upload className="h-8 w-8 mx-auto text-gray-400" />
                  <p className="text-sm font-medium">Click để chọn file Excel</p>
                  <p className="text-xs text-gray-500">Hỗ trợ .xlsx, .xls</p>
                </div>
              )}
            </div>
          </div>

          {/* Import results */}
          {result && (
            <div className="space-y-3">
              <div className="flex gap-4">
                {result.created > 0 && (
                  <div className="flex items-center gap-1 text-green-600">
                    <CheckCircle className="h-4 w-4" />
                    <span className="text-sm font-medium">{result.created} thành công</span>
                  </div>
                )}
                {result.errors.length > 0 && (
                  <div className="flex items-center gap-1 text-red-600">
                    <XCircle className="h-4 w-4" />
                    <span className="text-sm font-medium">{result.errors.length} lỗi</span>
                  </div>
                )}
              </div>

              {result.errors.length > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <p className="font-medium mb-1 text-sm">Chi tiết lỗi:</p>
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      {result.errors.slice(0, 10).map((err, idx) => (
                        <li key={idx}>
                          <Badge variant="outline" className="mr-1 text-xs">
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

              {result.created > 0 && result.errors.length === 0 && (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-800 text-sm">
                    Dữ liệu đã được TẠO thành công! Đã tạo {result.created} hoá đơn.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {result ? 'Đóng' : 'Huỷ'}
          </Button>
          {!result && (
            <Button onClick={handleImport} disabled={!canImport}>
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Đang nhập...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-1" />
                  Nhập dữ liệu
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
