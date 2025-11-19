import { useState } from 'react';
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
import { Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAutoGenerateInvoices, type AutoGenerateInvoicesData } from '@/hooks/useInvoices';
import { useContracts } from '@/hooks/useContracts';
import { format, startOfMonth, endOfMonth, addMonths } from 'date-fns';
import { vi } from 'date-fns/locale';

interface AutoGenerateInvoicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const autoGenerateSchema = z.object({
  billing_period_start: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  billing_period_end: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  issue_date: z.string().min(1, 'Vui lòng chọn ngày phát hành'),
  due_date: z.string().min(1, 'Vui lòng chọn hạn thanh toán'),
});

type AutoGenerateFormData = z.infer<typeof autoGenerateSchema>;

const AutoGenerateInvoicesDialog = ({
  open,
  onOpenChange,
}: AutoGenerateInvoicesDialogProps) => {
  const [selectedContracts, setSelectedContracts] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(true);

  const generateMutation = useAutoGenerateInvoices();
  const { data: contracts } = useContracts({ status: 'ACTIVE' });

  const activeContracts = contracts || [];

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<AutoGenerateFormData>({
    resolver: zodResolver(autoGenerateSchema),
    defaultValues: {
      billing_period_start: startOfMonth(new Date()).toISOString().split('T')[0],
      billing_period_end: endOfMonth(new Date()).toISOString().split('T')[0],
      issue_date: new Date().toISOString().split('T')[0],
      due_date: addMonths(new Date(), 1).toISOString().split('T')[0],
    },
  });

  const handleClose = () => {
    reset();
    setSelectedContracts([]);
    setSelectAll(true);
    onOpenChange(false);
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
    const contractIds = selectAll ? undefined : selectedContracts.length > 0 ? selectedContracts : undefined;

    if (!selectAll && selectedContracts.length === 0) {
      alert('Vui lòng chọn ít nhất 1 hợp đồng hoặc chọn "Tất cả hợp đồng"');
      return;
    }

    generateMutation.mutate(
      {
        ...data,
        contract_ids: contractIds,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      }
    );
  };

  const targetContractsCount = selectAll ? activeContracts.length : selectedContracts.length;

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
              <Label htmlFor="issue_date">Ngày phát hành *</Label>
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
              Sẽ tạo hóa đơn cho <strong>{targetContractsCount}</strong> hợp đồng
              {selectAll && ' (tất cả hợp đồng đang hoạt động)'}
            </AlertDescription>
          </Alert>

          {/* Warning */}
          <Alert className="bg-yellow-50 border-yellow-200">
            <AlertCircle className="h-4 w-4 text-yellow-600" />
            <AlertDescription className="text-yellow-900 text-sm">
              <strong>Lưu ý:</strong> Hóa đơn sẽ tự động tính toán:
              <ul className="list-disc list-inside mt-1 ml-2">
                <li>Tiền thuê theo chu kỳ thanh toán</li>
                <li>Dịch vụ cố định từ hợp đồng</li>
                <li>Điện/nước từ chỉ số công tơ gần nhất</li>
                <li>Công nợ tồn đọng (nếu có)</li>
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
