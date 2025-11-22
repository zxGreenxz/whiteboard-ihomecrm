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
import { useContracts } from '@/hooks/useContracts';
import { useCreateInvoice } from '@/hooks/useInvoices';
import { useServices } from '@/hooks/useServices';
import { Upload, Download, FileSpreadsheet, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { format, startOfMonth, endOfMonth } from 'date-fns';

interface ImportInvoicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ImportedInvoice {
  row: number;
  roomName: string;
  contractNumber?: string;
  tenantName?: string;
  billingMonth: string;
  rentAmount: number;
  electricityPrev?: number;
  electricityCurr?: number;
  electricityUsage?: number;
  electricityAmount?: number;
  waterPrev?: number;
  waterCurr?: number;
  waterUsage?: number;
  waterAmount?: number;
  serviceAmounts: Record<string, number>;
  otherFees?: number;
  otherFeesDesc?: string;
  discount?: number;
  notes?: string;
  status: 'valid' | 'error' | 'warning';
  errors: string[];
  contractId?: string;
}

const ImportInvoicesDialog = ({ open, onOpenChange }: ImportInvoicesDialogProps) => {
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [selectedMonth, setSelectedMonth] = useState<string>(format(new Date(), 'yyyy-MM'));
  const [importedData, setImportedData] = useState<ImportedInvoice[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importStep, setImportStep] = useState<'select' | 'preview' | 'importing'>('select');
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0, success: 0, failed: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: buildings } = useBuildings();
  const { data: contracts } = useContracts({ status: 'ACTIVE' });
  const { data: services } = useServices();
  const createInvoiceMutation = useCreateInvoice();

  // Filter contracts by building
  const buildingContracts = contracts?.filter(c => {
    if (!selectedBuildingId) return true;
    const buildingId = c.room?.building?.id || c.bed?.room?.building?.id;
    return buildingId === selectedBuildingId;
  });

  const handleClose = () => {
    setSelectedBuildingId('');
    setSelectedMonth(format(new Date(), 'yyyy-MM'));
    setImportedData([]);
    setImportStep('select');
    setImportProgress({ current: 0, total: 0, success: 0, failed: 0 });
    onOpenChange(false);
  };

  const downloadTemplate = () => {
    if (!selectedBuildingId || !buildingContracts) {
      toast.error('Vui lòng chọn tòa nhà trước');
      return;
    }

    // Get service columns
    const fixedServices = services?.filter(s => s.type === 'FIXED') || [];
    const meterServices = services?.filter(s => s.type === 'METER_READING') || [];
    const electricityService = meterServices.find(s => s.name.toLowerCase().includes('điện'));
    const waterService = meterServices.find(s => s.name.toLowerCase().includes('nước'));

    // Create template with contract data
    const templateData = buildingContracts.map(contract => {
      const roomName = contract.room?.name || contract.bed?.room?.name || '';
      const row: Record<string, any> = {
        'Phòng (*)': roomName,
        'Mã HĐ': contract.contract_number || '',
        'Khách thuê': contract.tenant?.full_name || '',
        'Tiền thuê (*)': contract.rent_price,
      };

      // Add electricity columns
      if (electricityService) {
        const initialReading = contract.contract_services?.find(
          cs => cs.service_id === electricityService.id
        )?.initial_reading || 0;
        row['Điện - CS đầu'] = initialReading;
        row['Điện - CS cuối (*)'] = '';
        row['Điện - Số lượng'] = '';
        row['Điện - Thành tiền'] = '';
      }

      // Add water columns
      if (waterService) {
        const initialReading = contract.contract_services?.find(
          cs => cs.service_id === waterService.id
        )?.initial_reading || 0;
        row['Nước - CS đầu'] = initialReading;
        row['Nước - CS cuối (*)'] = '';
        row['Nước - Số lượng'] = '';
        row['Nước - Thành tiền'] = '';
      }

      // Add fixed services
      fixedServices.forEach(service => {
        const contractService = contract.contract_services?.find(cs => cs.service_id === service.id);
        if (contractService) {
          row[`${service.name} (SL)`] = 1;
        } else {
          row[`${service.name} (SL)`] = 'N/A';
        }
      });

      row['Phí khác'] = 0;
      row['Mô tả phí khác'] = '';
      row['Giảm giá'] = 0;
      row['Ghi chú'] = '';

      return row;
    });

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Hóa đơn');

    // Add instructions
    const instructionsData = [
      ['HƯỚNG DẪN NHẬP DỮ LIỆU HÓA ĐƠN'],
      [''],
      ['Các trường đánh dấu (*) là bắt buộc phải điền'],
      ['Các ô màu vàng là dịch vụ phòng đang sử dụng'],
      ['Các ô N/A là dịch vụ phòng không sử dụng - không cần điền'],
      [''],
      ['1. Phòng: Không thay đổi'],
      ['2. Mã HĐ: Tham khảo - không thay đổi'],
      ['3. Khách thuê: Tham khảo - không thay đổi'],
      ['4. Tiền thuê: Có thể điều chỉnh nếu cần'],
      ['5. Điện/Nước - CS đầu: Chỉ số đầu kỳ (tự động từ kỳ trước)'],
      ['6. Điện/Nước - CS cuối: Nhập chỉ số cuối kỳ thực tế'],
      ['7. Dịch vụ (SL): Nhập số lượng sử dụng'],
      ['8. Phí khác: Các khoản phí phát sinh'],
      ['9. Giảm giá: Số tiền giảm'],
    ];
    const wsInstructions = XLSX.utils.aoa_to_sheet(instructionsData);
    XLSX.utils.book_append_sheet(wb, wsInstructions, 'Hướng dẫn');

    const building = buildings?.find(b => b.id === selectedBuildingId);
    XLSX.writeFile(wb, `Hoa_don_${building?.name || 'template'}_${selectedMonth}.xlsx`);
    toast.success('Đã tải file mẫu');
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

      const electricityService = services?.find(s => s.type === 'METER_READING' && s.name.toLowerCase().includes('điện'));
      const waterService = services?.find(s => s.type === 'METER_READING' && s.name.toLowerCase().includes('nước'));
      const fixedServices = services?.filter(s => s.type === 'FIXED') || [];

      const importedInvoices: ImportedInvoice[] = jsonData.map((row: any, index: number) => {
        const errors: string[] = [];

        const roomName = String(row['Phòng (*)'] || '').trim();
        const rentAmount = Number(row['Tiền thuê (*)']) || 0;

        // Find matching contract
        const contract = buildingContracts?.find(c => {
          const cRoomName = c.room?.name || c.bed?.room?.name || '';
          return cRoomName.toLowerCase() === roomName.toLowerCase();
        });

        if (!roomName) errors.push('Thiếu tên phòng');
        if (!contract) errors.push(`Không tìm thấy hợp đồng cho phòng "${roomName}"`);
        if (rentAmount <= 0) errors.push('Tiền thuê không hợp lệ');

        // Parse electricity
        let electricityPrev: number | undefined;
        let electricityCurr: number | undefined;
        let electricityUsage: number | undefined;
        let electricityAmount: number | undefined;

        if (electricityService) {
          electricityPrev = Number(row['Điện - CS đầu']) || 0;
          electricityCurr = Number(row['Điện - CS cuối (*)']);
          if (!isNaN(electricityCurr) && electricityCurr >= electricityPrev) {
            electricityUsage = electricityCurr - electricityPrev;
            const unitPrice = contract?.contract_services?.find(
              cs => cs.service_id === electricityService.id
            )?.unit_price || electricityService.unit_price || 0;
            electricityAmount = electricityUsage * unitPrice;
          } else if (row['Điện - CS cuối (*)'] !== undefined && row['Điện - CS cuối (*)'] !== '') {
            errors.push('Chỉ số điện cuối phải >= chỉ số đầu');
          }
        }

        // Parse water
        let waterPrev: number | undefined;
        let waterCurr: number | undefined;
        let waterUsage: number | undefined;
        let waterAmount: number | undefined;

        if (waterService) {
          waterPrev = Number(row['Nước - CS đầu']) || 0;
          waterCurr = Number(row['Nước - CS cuối (*)']);
          if (!isNaN(waterCurr) && waterCurr >= waterPrev) {
            waterUsage = waterCurr - waterPrev;
            const unitPrice = contract?.contract_services?.find(
              cs => cs.service_id === waterService.id
            )?.unit_price || waterService.unit_price || 0;
            waterAmount = waterUsage * unitPrice;
          } else if (row['Nước - CS cuối (*)'] !== undefined && row['Nước - CS cuối (*)'] !== '') {
            errors.push('Chỉ số nước cuối phải >= chỉ số đầu');
          }
        }

        // Parse fixed services
        const serviceAmounts: Record<string, number> = {};
        fixedServices.forEach(service => {
          const colName = `${service.name} (SL)`;
          const quantity = row[colName];
          if (quantity && quantity !== 'N/A') {
            const qty = Number(quantity) || 0;
            const unitPrice = contract?.contract_services?.find(
              cs => cs.service_id === service.id
            )?.unit_price || service.unit_price || 0;
            serviceAmounts[service.id] = qty * unitPrice;
          }
        });

        return {
          row: index + 2,
          roomName,
          contractNumber: contract?.contract_number,
          tenantName: contract?.tenant?.full_name,
          billingMonth: selectedMonth,
          rentAmount,
          electricityPrev,
          electricityCurr,
          electricityUsage,
          electricityAmount,
          waterPrev,
          waterCurr,
          waterUsage,
          waterAmount,
          serviceAmounts,
          otherFees: Number(row['Phí khác']) || 0,
          otherFeesDesc: String(row['Mô tả phí khác'] || '').trim(),
          discount: Number(row['Giảm giá']) || 0,
          notes: String(row['Ghi chú'] || '').trim(),
          status: errors.length > 0 ? 'error' : 'valid',
          errors,
          contractId: contract?.id,
        };
      });

      setImportedData(importedInvoices);
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
    const validInvoices = importedData.filter(i => i.status === 'valid' && i.contractId);
    if (validInvoices.length === 0) {
      toast.error('Không có dữ liệu hợp lệ để nhập');
      return;
    }

    const electricityService = services?.find(s => s.type === 'METER_READING' && s.name.toLowerCase().includes('điện'));
    const waterService = services?.find(s => s.type === 'METER_READING' && s.name.toLowerCase().includes('nước'));
    const fixedServices = services?.filter(s => s.type === 'FIXED') || [];

    setImportStep('importing');
    setImportProgress({ current: 0, total: validInvoices.length, success: 0, failed: 0 });

    const [year, month] = selectedMonth.split('-').map(Number);
    const billingStart = startOfMonth(new Date(year, month - 1)).toISOString().split('T')[0];
    const billingEnd = endOfMonth(new Date(year, month - 1)).toISOString().split('T')[0];

    for (let i = 0; i < validInvoices.length; i++) {
      const invoice = validInvoices[i];

      try {
        const items: Array<{
          type: string;
          description: string;
          quantity: number;
          unit_price: number;
          amount: number;
          service_id?: string;
        }> = [];

        // Rent item
        items.push({
          type: 'RENT',
          description: `Tiền thuê phòng ${invoice.roomName}`,
          quantity: 1,
          unit_price: invoice.rentAmount,
          amount: invoice.rentAmount,
        });

        // Electricity item
        if (electricityService && invoice.electricityUsage !== undefined && invoice.electricityAmount) {
          const contract = buildingContracts?.find(c => c.id === invoice.contractId);
          const unitPrice = contract?.contract_services?.find(
            cs => cs.service_id === electricityService.id
          )?.unit_price || electricityService.unit_price || 0;

          items.push({
            type: 'METER_READING',
            description: `Điện (${invoice.electricityPrev} → ${invoice.electricityCurr})`,
            quantity: invoice.electricityUsage,
            unit_price: unitPrice,
            amount: invoice.electricityAmount,
            service_id: electricityService.id,
          });
        }

        // Water item
        if (waterService && invoice.waterUsage !== undefined && invoice.waterAmount) {
          const contract = buildingContracts?.find(c => c.id === invoice.contractId);
          const unitPrice = contract?.contract_services?.find(
            cs => cs.service_id === waterService.id
          )?.unit_price || waterService.unit_price || 0;

          items.push({
            type: 'METER_READING',
            description: `Nước (${invoice.waterPrev} → ${invoice.waterCurr})`,
            quantity: invoice.waterUsage,
            unit_price: unitPrice,
            amount: invoice.waterAmount,
            service_id: waterService.id,
          });
        }

        // Fixed service items
        Object.entries(invoice.serviceAmounts).forEach(([serviceId, amount]) => {
          const service = fixedServices.find(s => s.id === serviceId);
          if (service && amount > 0) {
            items.push({
              type: 'SERVICE',
              description: service.name,
              quantity: 1,
              unit_price: amount,
              amount: amount,
              service_id: serviceId,
            });
          }
        });

        // Other fees
        if (invoice.otherFees && invoice.otherFees > 0) {
          items.push({
            type: 'OTHER',
            description: invoice.otherFeesDesc || 'Phí khác',
            quantity: 1,
            unit_price: invoice.otherFees,
            amount: invoice.otherFees,
          });
        }

        await new Promise<void>((resolve, reject) => {
          createInvoiceMutation.mutate({
            contract_id: invoice.contractId!,
            billing_period_start: billingStart,
            billing_period_end: billingEnd,
            issue_date: new Date().toISOString().split('T')[0],
            due_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            title: `Hóa đơn ${invoice.roomName} - ${selectedMonth}`,
            items,
            notes: invoice.notes,
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
        console.error(`Import invoice row ${invoice.row} failed:`, error);
        setImportProgress(prev => ({
          ...prev,
          current: i + 1,
          failed: prev.failed + 1,
        }));
      }
    }

    toast.success(`Đã tạo ${importProgress.success} hóa đơn thành công`);
    if (importProgress.failed > 0) {
      toast.warning(`${importProgress.failed} hóa đơn tạo thất bại`);
    }
  };

  const validCount = importedData.filter(i => i.status === 'valid').length;
  const errorCount = importedData.filter(i => i.status === 'error').length;
  const totalAmount = importedData
    .filter(i => i.status === 'valid')
    .reduce((sum, i) => {
      return sum + i.rentAmount + (i.electricityAmount || 0) + (i.waterAmount || 0) +
        Object.values(i.serviceAmounts).reduce((a, b) => a + b, 0) +
        (i.otherFees || 0) - (i.discount || 0);
    }, 0);

  // Generate month options
  const monthOptions = [];
  for (let i = -3; i <= 3; i++) {
    const date = new Date();
    date.setMonth(date.getMonth() + i);
    monthOptions.push({
      value: format(date, 'yyyy-MM'),
      label: format(date, 'MM/yyyy'),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Nhập hóa đơn từ file Excel
          </DialogTitle>
          <DialogDescription>
            Tải file mẫu, điền thông tin chỉ số và upload để tạo nhiều hóa đơn cùng lúc
          </DialogDescription>
        </DialogHeader>

        {importStep === 'select' && (
          <div className="space-y-6">
            {/* Selection */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Kỳ thanh toán *</Label>
                <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {monthOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        Tháng {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Tòa nhà *</Label>
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
            </div>

            {/* Template Download */}
            <div className="border rounded-lg p-4 space-y-4">
              <h4 className="font-medium">Bước 1: Tải file mẫu</h4>
              <p className="text-sm text-gray-600">
                File mẫu sẽ chứa sẵn thông tin các hợp đồng đang hoạt động và chỉ số đầu kỳ
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
                Điền chỉ số cuối kỳ điện/nước và các thông tin khác, sau đó upload
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
                  id="invoice-file-input"
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
            <div className="flex gap-4 items-center">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="h-4 w-4" />
                <span>{validCount} hợp lệ</span>
              </div>
              <div className="flex items-center gap-2 text-red-600">
                <XCircle className="h-4 w-4" />
                <span>{errorCount} lỗi</span>
              </div>
              <div className="ml-auto text-lg font-bold">
                Tổng: {totalAmount.toLocaleString('vi-VN')}đ
              </div>
            </div>

            {errorCount > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Có {errorCount} dòng dữ liệu bị lỗi. Chỉ các dòng hợp lệ sẽ được nhập.
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
                    <TableHead>Tiền thuê</TableHead>
                    <TableHead>Điện</TableHead>
                    <TableHead>Nước</TableHead>
                    <TableHead>Tổng</TableHead>
                    <TableHead>Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importedData.map((invoice, index) => {
                    const total = invoice.rentAmount + (invoice.electricityAmount || 0) +
                      (invoice.waterAmount || 0) + Object.values(invoice.serviceAmounts).reduce((a, b) => a + b, 0) +
                      (invoice.otherFees || 0) - (invoice.discount || 0);

                    return (
                      <TableRow key={index} className={invoice.status === 'error' ? 'bg-red-50' : ''}>
                        <TableCell>{invoice.row}</TableCell>
                        <TableCell>{invoice.roomName}</TableCell>
                        <TableCell>{invoice.tenantName}</TableCell>
                        <TableCell>{invoice.rentAmount.toLocaleString('vi-VN')}</TableCell>
                        <TableCell>
                          {invoice.electricityUsage !== undefined
                            ? `${invoice.electricityUsage} kWh = ${(invoice.electricityAmount || 0).toLocaleString('vi-VN')}`
                            : '-'}
                        </TableCell>
                        <TableCell>
                          {invoice.waterUsage !== undefined
                            ? `${invoice.waterUsage} m³ = ${(invoice.waterAmount || 0).toLocaleString('vi-VN')}`
                            : '-'}
                        </TableCell>
                        <TableCell className="font-medium">{total.toLocaleString('vi-VN')}</TableCell>
                        <TableCell>
                          {invoice.status === 'valid' ? (
                            <CheckCircle className="h-4 w-4 text-green-600" />
                          ) : (
                            <div className="flex items-center gap-1">
                              <XCircle className="h-4 w-4 text-red-600" />
                              <span className="text-xs text-red-600 truncate max-w-32" title={invoice.errors.join(', ')}>
                                {invoice.errors[0]}
                              </span>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setImportStep('select')}>
                Quay lại
              </Button>
              <Button onClick={handleImport} disabled={validCount === 0}>
                Tạo {validCount} hóa đơn
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
              <p className="text-gray-600">Đang tạo hóa đơn...</p>
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

export default ImportInvoicesDialog;
