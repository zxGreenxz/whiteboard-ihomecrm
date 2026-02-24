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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sparkles, Building2 } from 'lucide-react';
import {
  useAutoGenerateInvoicesRPC,
  type AutoGenerateInvoicesRPCData,
} from '@/hooks/useInvoicePayments';
import { useBuildings } from '@/hooks/useBuildings';
import { format } from 'date-fns';

interface AutoGenerateInvoicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type InvoiceType = AutoGenerateInvoicesRPCData['invoice_type'];

const AutoGenerateInvoicesDialog = ({
  open,
  onOpenChange,
}: AutoGenerateInvoicesDialogProps) => {
  const currentMonth = format(new Date(), 'yyyy-MM');
  const [billingMonth, setBillingMonth] = useState(currentMonth);
  const [buildingId, setBuildingId] = useState('');
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('both');

  const generateMutation = useAutoGenerateInvoicesRPC();
  const { data: buildings } = useBuildings();

  const handleClose = () => {
    setBillingMonth(currentMonth);
    setBuildingId('');
    setInvoiceType('both');
    onOpenChange(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!buildingId || !billingMonth) return;

    generateMutation.mutate(
      {
        building_id: buildingId,
        billing_month: billingMonth,
        invoice_type: invoiceType,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      },
    );
  };

  const selectedBuilding = buildings?.find((b) => b.id === buildingId);
  const isValid = !!buildingId && !!billingMonth;

  const invoiceTypeLabel: Record<InvoiceType, string> = {
    rent_only: 'Chỉ tiền nhà',
    service_only: 'Chỉ tiền dịch vụ',
    both: 'Tiền nhà & Dịch vụ',
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            Tạo nhiều hoá đơn
          </DialogTitle>
          <DialogDescription>
            Sinh hoá đơn tự động cho toàn bộ hợp đồng hiệu lực trong toà nhà
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Kỳ thanh toán */}
          <div className="space-y-2">
            <Label htmlFor="billing_month">Kỳ thanh toán *</Label>
            <Input
              id="billing_month"
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
              Toà nhà *
            </Label>
            <Select value={buildingId} onValueChange={setBuildingId}>
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

          {/* Hình thức */}
          <div className="space-y-3">
            <Label>Hình thức tạo hoá đơn</Label>
            <RadioGroup
              value={invoiceType}
              onValueChange={(v) => setInvoiceType(v as InvoiceType)}
              className="grid grid-cols-1 gap-2"
            >
              <div className="flex items-center space-x-3 rounded-md border p-3 hover:bg-gray-50">
                <RadioGroupItem value="rent_only" id="rent_only" />
                <Label htmlFor="rent_only" className="flex-1 cursor-pointer">
                  <div className="font-medium">Chỉ tiền nhà</div>
                  <div className="text-xs text-gray-500">Chỉ sinh hoá đơn tiền thuê nhà</div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 rounded-md border p-3 hover:bg-gray-50">
                <RadioGroupItem value="service_only" id="service_only" />
                <Label htmlFor="service_only" className="flex-1 cursor-pointer">
                  <div className="font-medium">Chỉ tiền dịch vụ</div>
                  <div className="text-xs text-gray-500">Chỉ sinh hoá đơn tiền dịch vụ</div>
                </Label>
              </div>
              <div className="flex items-center space-x-3 rounded-md border p-3 hover:bg-gray-50 bg-blue-50 border-blue-200">
                <RadioGroupItem value="both" id="both" />
                <Label htmlFor="both" className="flex-1 cursor-pointer">
                  <div className="font-medium">Tiền nhà & Dịch vụ</div>
                  <div className="text-xs text-gray-500">Sinh hoá đơn gồm cả tiền thuê và dịch vụ</div>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Summary */}
          {isValid && (
            <Alert className="bg-blue-50 border-blue-200">
              <AlertDescription className="text-blue-900 text-sm">
                Sinh hoá đơn <strong>{invoiceTypeLabel[invoiceType]}</strong> cho toà{' '}
                <strong>{selectedBuilding?.name}</strong>, kỳ{' '}
                <strong>{billingMonth}</strong>.
                Hệ thống sẽ tự động bỏ qua hợp đồng đã có hoá đơn trong kỳ này.
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Huỷ
            </Button>
            <Button
              type="submit"
              disabled={generateMutation.isPending || !isValid}
            >
              <Sparkles className="h-4 w-4 mr-2" />
              {generateMutation.isPending ? 'Đang tạo...' : 'Lưu'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default AutoGenerateInvoicesDialog;
