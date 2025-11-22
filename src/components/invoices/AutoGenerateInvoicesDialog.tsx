import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sparkles, AlertCircle, CheckCircle2, Building2 } from 'lucide-react';
import { useAutoGenerateInvoices, type AutoGenerateInvoicesData, type InvoiceGenerationType } from '@/hooks/useInvoices';
import { useContracts } from '@/hooks/useContracts';
import { useBuildings } from '@/hooks/useBuildings';
import { format, startOfMonth, endOfMonth, addDays } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useInvoiceConfig } from '@/hooks/useSettings';

interface AutoGenerateInvoicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const autoGenerateSchema = z.object({
  billing_period_start: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  billing_period_end: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  issue_date: z.string().min(1, 'Vui lòng chọn ngày phát hành'),
  due_date: z.string().min(1, 'Vui lòng chọn hạn thanh toán'),
  building_id: z.string().optional(),
  invoice_type: z.enum(['RENT_ONLY', 'SERVICE_ONLY', 'RENT_AND_SERVICE']),
});

type AutoGenerateFormData = z.infer<typeof autoGenerateSchema>;

const AutoGenerateInvoicesDialog = ({
  open,
  onOpenChange,
}: AutoGenerateInvoicesDialogProps) => {
  const [selectedContracts, setSelectedContracts] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(true);
  const [selectedBuilding, setSelectedBuilding] = useState<string>('all');
  const [invoiceType, setInvoiceType] = useState<InvoiceGenerationType>('RENT_AND_SERVICE');

  const generateMutation = useAutoGenerateInvoices();
  const { data: contracts } = useContracts({ status: 'ACTIVE' });
  const { data: buildings } = useBuildings();
  const { data: invoiceConfig } = useInvoiceConfig();

  // Filter contracts by selected building
  const activeContracts = useMemo(() => {
    if (!contracts) return [];
    if (selectedBuilding === 'all') return contracts;

    return contracts.filter((contract) => {
      const buildingId = contract.room?.building?.id || contract.bed?.room?.building?.id;
      return buildingId === selectedBuilding;
    });
  }, [contracts, selectedBuilding]);

  // Calculate default due date based on settings
  const defaultDueDate = useMemo(() => {
    const paymentDueDays = invoiceConfig?.payment_due_days || 7;
    return addDays(new Date(), paymentDueDays).toISOString().split('T')[0];
  }, [invoiceConfig]);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
    watch,
  } = useForm<AutoGenerateFormData>({
    resolver: zodResolver(autoGenerateSchema),
    defaultValues: {
      billing_period_start: startOfMonth(new Date()).toISOString().split('T')[0],
      billing_period_end: endOfMonth(new Date()).toISOString().split('T')[0],
      issue_date: new Date().toISOString().split('T')[0],
      due_date: defaultDueDate,
      building_id: 'all',
      invoice_type: 'RENT_AND_SERVICE',
    },
  });

  const handleClose = () => {
    reset();
    setSelectedContracts([]);
    setSelectAll(true);
    setSelectedBuilding('all');
    setInvoiceType('RENT_AND_SERVICE');
    onOpenChange(false);
  };

  const handleBuildingChange = (value: string) => {
    setSelectedBuilding(value);
    setValue('building_id', value);
    // Reset contract selection when building changes
    setSelectedContracts([]);
    setSelectAll(true);
  };

  const handleInvoiceTypeChange = (value: InvoiceGenerationType) => {
    setInvoiceType(value);
    setValue('invoice_type', value);
  };

  const handleSelectAllChange = (checked: boolean) => {
    setSelectAll(checked);
    if (checked) {
      setSelectedContracts([]);
    }
  };

  const handleContractToggle = (contractId: string) => {
    setSelectAll(false);
    setSelectedContracts((prev) => {
      if (prev.includes(contractId)) {
        return prev.filter((id) => id !== contractId);
      } else {
        return [...prev, contractId];
      }
    });
  };

  const onSubmit = (data: AutoGenerateFormData) => {
    const contractIds = selectAll
      ? activeContracts.map(c => c.id)
      : selectedContracts.length > 0 ? selectedContracts : undefined;

    if (!contractIds || contractIds.length === 0) {
      alert('Vui lòng chọn ít nhất 1 hợp đồng hoặc chọn "Tất cả hợp đồng"');
      return;
    }

    generateMutation.mutate(
      {
        billing_period_start: data.billing_period_start,
        billing_period_end: data.billing_period_end,
        issue_date: data.issue_date,
        due_date: data.due_date,
        contract_ids: contractIds,
        building_id: selectedBuilding === 'all' ? undefined : selectedBuilding,
        invoice_type: invoiceType,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      }
    );
  };

  const targetContractsCount = selectAll ? activeContracts.length : selectedContracts.length;

  // Get invoice type description
  const getInvoiceTypeDescription = () => {
    switch (invoiceType) {
      case 'RENT_ONLY':
        return 'Chỉ tạo tiền thuê nhà';
      case 'SERVICE_ONLY':
        return 'Chỉ tạo tiền dịch vụ (điện, nước, phí cố định...)';
      case 'RENT_AND_SERVICE':
        return 'Tạo đầy đủ tiền thuê và dịch vụ';
      default:
        return '';
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            Tạo hóa đơn tự động
          </DialogTitle>
          <DialogDescription>
            Tạo hóa đơn hàng loạt cho các hợp đồng đang hoạt động
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Building Selection */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Tòa nhà
            </Label>
            <Select value={selectedBuilding} onValueChange={handleBuildingChange}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn tòa nhà" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả tòa nhà</SelectItem>
                {buildings?.map((building) => (
                  <SelectItem key={building.id} value={building.id}>
                    {building.name} ({building.code || building.id.slice(0, 6)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Invoice Type Selection */}
          <div className="space-y-3">
            <Label>Hình thức tạo hóa đơn *</Label>
            <RadioGroup
              value={invoiceType}
              onValueChange={(value) => handleInvoiceTypeChange(value as InvoiceGenerationType)}
              className="grid grid-cols-1 gap-2"
            >
              <div className="flex items-center space-x-3 rounded-md border p-3 hover:bg-gray-50">
                <RadioGroupItem value="RENT_ONLY" id="rent_only" />
                <Label htmlFor="rent_only" className="flex-1 cursor-pointer">
                  <div className="font-medium">Chỉ tiền nhà</div>
                  <div className="text-xs text-gray-500">Hệ thống chỉ sinh hóa đơn tiền thuê nhà</div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 rounded-md border p-3 hover:bg-gray-50">
                <RadioGroupItem value="SERVICE_ONLY" id="service_only" />
                <Label htmlFor="service_only" className="flex-1 cursor-pointer">
                  <div className="font-medium">Chỉ tiền dịch vụ</div>
                  <div className="text-xs text-gray-500">Hệ thống chỉ sinh hóa đơn tiền dịch vụ (điện, nước, phí cố định...)</div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 rounded-md border p-3 hover:bg-gray-50 bg-blue-50 border-blue-200">
                <RadioGroupItem value="RENT_AND_SERVICE" id="rent_and_service" />
                <Label htmlFor="rent_and_service" className="flex-1 cursor-pointer">
                  <div className="font-medium">Tiền nhà & Dịch vụ</div>
                  <div className="text-xs text-gray-500">Hệ thống sinh hóa đơn gồm cả tiền thuê nhà và tiền dịch vụ</div>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Date Inputs */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="billing_period_start">Kỳ thanh toán từ *</Label>
              <Input
                id="billing_period_start"
                type="date"
                {...register('billing_period_start')}
              />
              {errors.billing_period_start && (
                <p className="text-sm text-red-500">{errors.billing_period_start.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="billing_period_end">Đến *</Label>
              <Input
                id="billing_period_end"
                type="date"
                {...register('billing_period_end')}
              />
              {errors.billing_period_end && (
                <p className="text-sm text-red-500">{errors.billing_period_end.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="issue_date">Ngày lập *</Label>
              <Input
                id="issue_date"
                type="date"
                {...register('issue_date')}
              />
              {errors.issue_date && (
                <p className="text-sm text-red-500">{errors.issue_date.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="due_date">Hạn thanh toán *</Label>
              <Input
                id="due_date"
                type="date"
                {...register('due_date')}
              />
              {errors.due_date && (
                <p className="text-sm text-red-500">{errors.due_date.message}</p>
              )}
              <p className="text-xs text-gray-500">
                Mặc định: {invoiceConfig?.payment_due_days || 7} ngày sau ngày lập
              </p>
            </div>
          </div>

          {/* Contract Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Chọn hợp đồng</Label>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="select_all"
                  checked={selectAll}
                  onCheckedChange={handleSelectAllChange}
                />
                <label
                  htmlFor="select_all"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                >
                  Tất cả hợp đồng ({activeContracts.length})
                </label>
              </div>
            </div>

            {!selectAll && (
              <div className="border rounded-md p-4 max-h-64 overflow-y-auto space-y-2">
                {activeContracts.length === 0 ? (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      Không có hợp đồng nào đang hoạt động.
                    </AlertDescription>
                  </Alert>
                ) : (
                  activeContracts.map((contract) => (
                    <div key={contract.id} className="flex items-center space-x-2 p-2 hover:bg-gray-50 rounded">
                      <Checkbox
                        id={`contract_${contract.id}`}
                        checked={selectedContracts.includes(contract.id)}
                        onCheckedChange={() => handleContractToggle(contract.id)}
                      />
                      <label
                        htmlFor={`contract_${contract.id}`}
                        className="text-sm flex-1 cursor-pointer"
                      >
                        <div className="font-medium">
                          {contract.contract_number || contract.id.slice(0, 8)}
                        </div>
                        <div className="text-xs text-gray-600">
                          {contract.tenant?.full_name} - {contract.room?.name || contract.bed?.name}
                        </div>
                      </label>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Summary */}
          <Alert className="bg-blue-50 border-blue-200">
            <CheckCircle2 className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-900">
              <div>
                Sẽ tạo hóa đơn cho <strong>{targetContractsCount}</strong> hợp đồng
                {selectedBuilding !== 'all' && buildings?.find(b => b.id === selectedBuilding) && (
                  <> trong tòa <strong>{buildings.find(b => b.id === selectedBuilding)?.name}</strong></>
                )}
              </div>
              <div className="text-sm mt-1">
                Loại hóa đơn: <strong>{getInvoiceTypeDescription()}</strong>
              </div>
            </AlertDescription>
          </Alert>

          {/* Warning */}
          <Alert className="bg-yellow-50 border-yellow-200">
            <AlertCircle className="h-4 w-4 text-yellow-600" />
            <AlertDescription className="text-yellow-900 text-sm">
              <strong>Lưu ý:</strong> Hóa đơn sẽ tự động tính toán:
              <ul className="list-disc list-inside mt-1 ml-2">
                {(invoiceType === 'RENT_ONLY' || invoiceType === 'RENT_AND_SERVICE') && (
                  <li>Tiền thuê theo chu kỳ thanh toán</li>
                )}
                {(invoiceType === 'SERVICE_ONLY' || invoiceType === 'RENT_AND_SERVICE') && (
                  <>
                    <li>Dịch vụ cố định từ hợp đồng</li>
                    <li>Điện/nước từ chỉ số công tơ gần nhất</li>
                  </>
                )}
                <li>Công nợ tồn đọng (nếu bật trong cài đặt)</li>
              </ul>
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              disabled={generateMutation.isPending || targetContractsCount === 0}
            >
              <Sparkles className="h-4 w-4 mr-2" />
              {generateMutation.isPending ? 'Đang tạo...' : `Tạo ${targetContractsCount} hóa đơn`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default AutoGenerateInvoicesDialog;
