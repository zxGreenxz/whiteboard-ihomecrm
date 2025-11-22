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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useBuildings } from '@/hooks/useBuildings';
import { useCreateContract, type CreateContractData } from '@/hooks/useContracts';
import { useServices } from '@/hooks/useServices';
import { useTenants, useCreateTenant } from '@/hooks/useTenants';
import { useRooms } from '@/hooks/useRooms';
import { Upload, Download, FileSpreadsheet, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';

interface ImportContractsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ImportedContract {
  row: number;
  roomName: string;
  tenantName: string;
  tenantPhone: string;
  tenantEmail?: string;
  tenantIdNumber?: string;
  signedDate: string;
  startDate: string;
  endDate: string;
  startBillingDate?: string;
  rentPrice: number;
  paymentCycle: string;
  totalDeposit: number;
  depositPaid?: number;
  electricityReading?: number;
  waterReading?: number;
  notes?: string;
  status: 'valid' | 'error' | 'warning';
  errors: string[];
}

const ImportContractsDialog = ({ open, onOpenChange }: ImportContractsDialogProps) => {
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [importedData, setImportedData] = useState<ImportedContract[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importStep, setImportStep] = useState<'select' | 'preview' | 'importing'>('select');
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0, success: 0, failed: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: buildings } = useBuildings();
  const { data: services } = useServices();
  const { data: tenants } = useTenants();
  const { data: rooms } = useRooms({ building_id: selectedBuildingId });
  const createContractMutation = useCreateContract();
  const createTenantMutation = useCreateTenant();

  const handleClose = () => {
    setSelectedBuildingId('');
    setImportedData([]);
    setImportStep('select');
    setImportProgress({ current: 0, total: 0, success: 0, failed: 0 });
    onOpenChange(false);
  };

  const downloadTemplate = () => {
    // Create template workbook
    const templateData = [
      {
        'Phòng (*)': 'P101',
        'Họ tên khách (*)': 'Nguyễn Văn A',
        'Số điện thoại (*)': '0901234567',
        'Email': 'example@email.com',
        'CCCD/CMND': '001234567890',
        'Ngày ký (*)': '01/01/2024',
        'Ngày bắt đầu (*)': '01/01/2024',
        'Ngày kết thúc (*)': '31/12/2024',
        'Ngày bắt đầu tính tiền': '01/01/2024',
        'Giá thuê (*)': 5000000,
        'Chu kỳ thanh toán': '1 tháng',
        'Tiền cọc (*)': 10000000,
        'Đã đặt cọc': 5000000,
        'Chỉ số điện đầu': 0,
        'Chỉ số nước đầu': 0,
        'Ghi chú': '',
      },
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Hợp đồng');

    // Add instructions sheet
    const instructionsData = [
      ['HƯỚNG DẪN NHẬP DỮ LIỆU HỢP ĐỒNG'],
      [''],
      ['Các trường đánh dấu (*) là bắt buộc phải điền'],
      [''],
      ['1. Phòng: Tên phòng trong tòa nhà đã chọn (phải tồn tại trong hệ thống)'],
      ['2. Họ tên khách: Tên đầy đủ của khách thuê'],
      ['3. Số điện thoại: Số điện thoại của khách (10 số)'],
      ['4. Email: Địa chỉ email (tùy chọn)'],
      ['5. CCCD/CMND: Số căn cước/chứng minh (tùy chọn)'],
      ['6. Ngày ký: Định dạng DD/MM/YYYY'],
      ['7. Ngày bắt đầu: Định dạng DD/MM/YYYY'],
      ['8. Ngày kết thúc: Định dạng DD/MM/YYYY'],
      ['9. Ngày bắt đầu tính tiền: Định dạng DD/MM/YYYY (mặc định = ngày bắt đầu)'],
      ['10. Giá thuê: Số tiền (VND)'],
      ['11. Chu kỳ thanh toán: "1 tháng", "3 tháng", "6 tháng", "1 năm"'],
      ['12. Tiền cọc: Số tiền (VND)'],
      ['13. Đã đặt cọc: Số tiền đã thu (VND, tùy chọn)'],
      ['14. Chỉ số điện đầu: Số (tùy chọn)'],
      ['15. Chỉ số nước đầu: Số (tùy chọn)'],
      ['16. Ghi chú: Văn bản tự do (tùy chọn)'],
    ];
    const wsInstructions = XLSX.utils.aoa_to_sheet(instructionsData);
    XLSX.utils.book_append_sheet(wb, wsInstructions, 'Hướng dẫn');

    // Download
    XLSX.writeFile(wb, `Mau_nhap_hop_dong_${selectedBuildingId ? buildings?.find(b => b.id === selectedBuildingId)?.name : 'template'}.xlsx`);
    toast.success('Đã tải file mẫu');
  };

  const parseDate = (dateStr: string): string | null => {
    if (!dateStr) return null;

    // Handle Excel serial date
    if (typeof dateStr === 'number') {
      const date = XLSX.SSF.parse_date_code(dateStr);
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    }

    // Handle DD/MM/YYYY format
    const parts = String(dateStr).split('/');
    if (parts.length === 3) {
      const [day, month, year] = parts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // Handle YYYY-MM-DD format
    if (String(dateStr).includes('-')) {
      return String(dateStr).slice(0, 10);
    }

    return null;
  };

  const parsePaymentCycle = (cycle: string): string => {
    const cycleMap: Record<string, string> = {
      '1 tháng': 'MONTHLY',
      'hàng tháng': 'MONTHLY',
      'monthly': 'MONTHLY',
      '3 tháng': 'QUARTERLY',
      'quarterly': 'QUARTERLY',
      '6 tháng': 'SEMI_ANNUAL',
      'semi_annual': 'SEMI_ANNUAL',
      '1 năm': 'ANNUAL',
      'annual': 'ANNUAL',
    };
    return cycleMap[String(cycle).toLowerCase().trim()] || 'MONTHLY';
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!selectedBuildingId) {
      toast.error('Vui lòng chọn tòa nhà trước');
      return;
    }

    setIsProcessing(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      const importedContracts: ImportedContract[] = jsonData.map((row: any, index: number) => {
        const errors: string[] = [];

        // Validate required fields
        const roomName = String(row['Phòng (*)'] || '').trim();
        const tenantName = String(row['Họ tên khách (*)'] || '').trim();
        const tenantPhone = String(row['Số điện thoại (*)'] || '').trim();
        const signedDateRaw = row['Ngày ký (*)'];
        const startDateRaw = row['Ngày bắt đầu (*)'];
        const endDateRaw = row['Ngày kết thúc (*)'];
        const rentPrice = Number(row['Giá thuê (*)']) || 0;
        const totalDeposit = Number(row['Tiền cọc (*)']) || 0;

        if (!roomName) errors.push('Thiếu tên phòng');
        if (!tenantName) errors.push('Thiếu tên khách');
        if (!tenantPhone) errors.push('Thiếu số điện thoại');
        if (!signedDateRaw) errors.push('Thiếu ngày ký');
        if (!startDateRaw) errors.push('Thiếu ngày bắt đầu');
        if (!endDateRaw) errors.push('Thiếu ngày kết thúc');
        if (rentPrice <= 0) errors.push('Giá thuê không hợp lệ');
        if (totalDeposit < 0) errors.push('Tiền cọc không hợp lệ');

        // Validate room exists
        const room = rooms?.find(r => r.name.toLowerCase() === roomName.toLowerCase());
        if (roomName && !room) {
          errors.push(`Phòng "${roomName}" không tồn tại`);
        }
        if (room && room.status !== 'AVAILABLE') {
          errors.push(`Phòng "${roomName}" không còn trống`);
        }

        // Parse dates
        const signedDate = parseDate(signedDateRaw);
        const startDate = parseDate(startDateRaw);
        const endDate = parseDate(endDateRaw);
        const startBillingDate = parseDate(row['Ngày bắt đầu tính tiền']) || startDate;

        if (signedDateRaw && !signedDate) errors.push('Ngày ký không hợp lệ');
        if (startDateRaw && !startDate) errors.push('Ngày bắt đầu không hợp lệ');
        if (endDateRaw && !endDate) errors.push('Ngày kết thúc không hợp lệ');

        return {
          row: index + 2, // Excel row (header is row 1)
          roomName,
          tenantName,
          tenantPhone,
          tenantEmail: String(row['Email'] || '').trim() || undefined,
          tenantIdNumber: String(row['CCCD/CMND'] || '').trim() || undefined,
          signedDate: signedDate || '',
          startDate: startDate || '',
          endDate: endDate || '',
          startBillingDate: startBillingDate || undefined,
          rentPrice,
          paymentCycle: parsePaymentCycle(row['Chu kỳ thanh toán']),
          totalDeposit,
          depositPaid: Number(row['Đã đặt cọc']) || undefined,
          electricityReading: Number(row['Chỉ số điện đầu']) || undefined,
          waterReading: Number(row['Chỉ số nước đầu']) || undefined,
          notes: String(row['Ghi chú'] || '').trim() || undefined,
          status: errors.length > 0 ? 'error' : 'valid',
          errors,
        };
      });

      setImportedData(importedContracts);
      setImportStep('preview');
    } catch (error) {
      toast.error('Lỗi đọc file. Vui lòng kiểm tra định dạng file.');
      console.error('File parse error:', error);
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleImport = async () => {
    const validContracts = importedData.filter(c => c.status === 'valid');
    if (validContracts.length === 0) {
      toast.error('Không có dữ liệu hợp lệ để nhập');
      return;
    }

    setImportStep('importing');
    setImportProgress({ current: 0, total: validContracts.length, success: 0, failed: 0 });

    for (let i = 0; i < validContracts.length; i++) {
      const contract = validContracts[i];

      try {
        // Find or create tenant
        let tenantId = tenants?.find(
          t => t.phone === contract.tenantPhone || t.full_name.toLowerCase() === contract.tenantName.toLowerCase()
        )?.id;

        if (!tenantId) {
          // Create new tenant
          const newTenant = await new Promise<{ id: string }>((resolve, reject) => {
            createTenantMutation.mutate({
              full_name: contract.tenantName,
              phone: contract.tenantPhone,
              email: contract.tenantEmail,
              id_number: contract.tenantIdNumber,
            }, {
              onSuccess: (data) => resolve(data),
              onError: (error) => reject(error),
            });
          });
          tenantId = newTenant.id;
        }

        // Find room
        const room = rooms?.find(r => r.name.toLowerCase() === contract.roomName.toLowerCase());
        if (!room) throw new Error(`Phòng ${contract.roomName} không tồn tại`);

        // Get meter services
        const electricityService = services?.find(s => s.type === 'METER_READING' && s.name.toLowerCase().includes('điện'));
        const waterService = services?.find(s => s.type === 'METER_READING' && s.name.toLowerCase().includes('nước'));

        const contractServices: CreateContractData['services'] = [];
        if (electricityService && contract.electricityReading !== undefined) {
          contractServices.push({
            service_id: electricityService.id,
            unit_price: electricityService.unit_price || 0,
            initial_reading: contract.electricityReading,
          });
        }
        if (waterService && contract.waterReading !== undefined) {
          contractServices.push({
            service_id: waterService.id,
            unit_price: waterService.unit_price || 0,
            initial_reading: contract.waterReading,
          });
        }

        // Create contract
        await new Promise<void>((resolve, reject) => {
          createContractMutation.mutate({
            tenant_id: tenantId!,
            room_id: room.id,
            signed_date: contract.signedDate,
            start_date: contract.startDate,
            end_date: contract.endDate,
            start_billing_date: contract.startBillingDate,
            rent_price: contract.rentPrice,
            payment_cycle: contract.paymentCycle,
            total_deposit: contract.totalDeposit,
            deposit_paid: contract.depositPaid,
            initial_electricity_reading: contract.electricityReading,
            initial_water_reading: contract.waterReading,
            notes: contract.notes,
            services: contractServices,
          }, {
            onSuccess: () => resolve(),
            onError: (error) => reject(error),
          });
        });

        setImportProgress(prev => ({
          ...prev,
          current: i + 1,
          success: prev.success + 1,
        }));
      } catch (error) {
        console.error(`Import contract row ${contract.row} failed:`, error);
        setImportProgress(prev => ({
          ...prev,
          current: i + 1,
          failed: prev.failed + 1,
        }));
      }
    }

    toast.success(`Đã nhập ${importProgress.success} hợp đồng thành công`);
    if (importProgress.failed > 0) {
      toast.warning(`${importProgress.failed} hợp đồng nhập thất bại`);
    }
  };

  const validCount = importedData.filter(c => c.status === 'valid').length;
  const errorCount = importedData.filter(c => c.status === 'error').length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Nhập hợp đồng từ file Excel
          </DialogTitle>
          <DialogDescription>
            Tải file mẫu, điền thông tin và upload để tạo nhiều hợp đồng cùng lúc
          </DialogDescription>
        </DialogHeader>

        {importStep === 'select' && (
          <div className="space-y-6">
            {/* Building Selection */}
            <div className="space-y-2">
              <Label>Chọn tòa nhà *</Label>
              <Select value={selectedBuildingId} onValueChange={setSelectedBuildingId}>
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

            {/* Template Download */}
            <div className="border rounded-lg p-4 space-y-4">
              <h4 className="font-medium">Bước 1: Tải file mẫu</h4>
              <p className="text-sm text-gray-600">
                Tải file mẫu Excel, điền thông tin hợp đồng theo hướng dẫn
              </p>
              <Button variant="outline" onClick={downloadTemplate} disabled={!selectedBuildingId}>
                <Download className="h-4 w-4 mr-2" />
                Tải file mẫu tại đây
              </Button>
            </div>

            {/* File Upload */}
            <div className="border rounded-lg p-4 space-y-4">
              <h4 className="font-medium">Bước 2: Upload file đã điền</h4>
              <p className="text-sm text-gray-600">
                Kéo thả hoặc chọn file Excel đã điền thông tin
              </p>
              <div className="border-2 border-dashed rounded-lg p-8 text-center">
                <Upload className="h-10 w-10 mx-auto mb-4 text-gray-400" />
                <p className="text-sm text-gray-600 mb-2">
                  Kéo thả file vào đây hoặc click để chọn file
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleFileUpload}
                  className="hidden"
                  id="contract-file-input"
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!selectedBuildingId || isProcessing}
                >
                  {isProcessing ? 'Đang xử lý...' : 'Chọn file'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {importStep === 'preview' && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex gap-4">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="h-4 w-4" />
                <span>{validCount} hợp lệ</span>
              </div>
              <div className="flex items-center gap-2 text-red-600">
                <XCircle className="h-4 w-4" />
                <span>{errorCount} lỗi</span>
              </div>
            </div>

            {errorCount > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Có {errorCount} dòng dữ liệu bị lỗi. Vui lòng kiểm tra và sửa trong file Excel.
                </AlertDescription>
              </Alert>
            )}

            {/* Preview Table */}
            <div className="border rounded-lg overflow-auto max-h-96">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">Dòng</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Khách thuê</TableHead>
                    <TableHead>SĐT</TableHead>
                    <TableHead>Ngày bắt đầu</TableHead>
                    <TableHead>Ngày kết thúc</TableHead>
                    <TableHead>Giá thuê</TableHead>
                    <TableHead>Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importedData.map((contract, index) => (
                    <TableRow key={index} className={contract.status === 'error' ? 'bg-red-50' : ''}>
                      <TableCell>{contract.row}</TableCell>
                      <TableCell>{contract.roomName}</TableCell>
                      <TableCell>{contract.tenantName}</TableCell>
                      <TableCell>{contract.tenantPhone}</TableCell>
                      <TableCell>{contract.startDate}</TableCell>
                      <TableCell>{contract.endDate}</TableCell>
                      <TableCell>{contract.rentPrice.toLocaleString('vi-VN')}đ</TableCell>
                      <TableCell>
                        {contract.status === 'valid' ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : (
                          <div className="flex items-center gap-1">
                            <XCircle className="h-4 w-4 text-red-600" />
                            <span className="text-xs text-red-600">{contract.errors[0]}</span>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setImportStep('select')}>
                Quay lại
              </Button>
              <Button onClick={handleImport} disabled={validCount === 0}>
                Nhập {validCount} hợp đồng
              </Button>
            </DialogFooter>
          </div>
        )}

        {importStep === 'importing' && (
          <div className="space-y-4 py-8">
            <div className="text-center">
              <div className="text-2xl font-bold mb-2">
                {importProgress.current} / {importProgress.total}
              </div>
              <p className="text-gray-600">Đang nhập dữ liệu...</p>
            </div>

            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-green-600 h-2 rounded-full transition-all"
                style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
              />
            </div>

            <div className="flex justify-center gap-8 text-sm">
              <div className="text-green-600">Thành công: {importProgress.success}</div>
              <div className="text-red-600">Thất bại: {importProgress.failed}</div>
            </div>

            {importProgress.current === importProgress.total && (
              <DialogFooter className="pt-4">
                <Button onClick={handleClose}>Đóng</Button>
              </DialogFooter>
            )}
          </div>
        )}

        {importStep === 'select' && (
          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>
              Hủy
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ImportContractsDialog;
