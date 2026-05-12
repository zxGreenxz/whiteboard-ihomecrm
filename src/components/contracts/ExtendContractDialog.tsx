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
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useExtendContract } from '@/hooks/useContracts';
import { getRepresentativeName } from '@/lib/contractCustomerHelpers';
import { RefreshCw } from 'lucide-react';
import { format, addMonths } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { ContractWithRelations } from '@/hooks/useContracts';

interface ExtendContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations | null;
}

const extendSchema = z.object({
  extension_months: z.number().min(1, 'Số tháng phải >= 1').max(60, 'Số tháng <= 60'),
  new_rent_price: z.number().min(0).optional(),
  notes: z.string().optional(),
});

type ExtendFormData = z.infer<typeof extendSchema>;

const ExtendContractDialog = ({ open, onOpenChange, contract }: ExtendContractDialogProps) => {
  const extendMutation = useExtendContract();

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
    reset,
  } = useForm<ExtendFormData>({
    resolver: zodResolver(extendSchema),
    defaultValues: {
      extension_months: 12,
      new_rent_price: contract?.rent_price || 0,
    },
  });

  const watchedMonths = watch('extension_months');
  const watchedNewPrice = watch('new_rent_price');

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const onSubmit = (data: ExtendFormData) => {
    if (!contract) return;

    extendMutation.mutate(
      {
        contract_id: contract.id,
        extension_months: data.extension_months,
        new_rent_price: data.new_rent_price !== contract.rent_price ? data.new_rent_price : undefined,
        notes: data.notes,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      }
    );
  };

  if (!contract) return null;

  const currentEndDate = new Date(contract.end_date);
  const newEndDate = watchedMonths ? addMonths(currentEndDate, watchedMonths) : currentEndDate;
  const priceChanged = watchedNewPrice && watchedNewPrice !== contract.rent_price;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Gia hạn hợp đồng
          </DialogTitle>
          <DialogDescription>
            Hợp đồng: {contract.contract_number || contract.id.slice(0, 8)}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Current Contract Info */}
          <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Khách hàng:</span>
              <span className="font-medium">{getRepresentativeName(contract as any)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Căn hộ/Giường:</span>
              <span className="font-medium">
                {contract.room ? contract.room.name : contract.bed?.name}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Ngày kết thúc hiện tại:</span>
              <span className="font-medium">
                {format(currentEndDate, 'dd/MM/yyyy', { locale: vi })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Giá thuê hiện tại:</span>
              <span className="font-medium">
                {contract.rent_price.toLocaleString('vi-VN')} VND/tháng
              </span>
            </div>
          </div>

          {/* Extension Months */}
          <div className="space-y-2">
            <Label htmlFor="extension_months">Số tháng gia hạn *</Label>
            <NumberInput
              id="extension_months"
              value={watch('extension_months')}
              onChange={(v) => setValue('extension_months', v, { shouldValidate: true, shouldDirty: true })}
              min={1}
              max={60}
            />
            {errors.extension_months && (
              <p className="text-sm text-red-500">{errors.extension_months.message}</p>
            )}
          </div>

          {/* New End Date Preview */}
          <div className="bg-blue-50 border border-blue-200 p-4 rounded-md">
            <p className="text-sm font-medium text-blue-900">
              Ngày kết thúc mới: {format(newEndDate, 'dd/MM/yyyy', { locale: vi })}
            </p>
            <p className="text-xs text-blue-700 mt-1">
              Thời hạn: {watchedMonths || 0} tháng ({format(newEndDate, 'dd MMMM yyyy', { locale: vi })})
            </p>
          </div>

          {/* New Rent Price (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="new_rent_price">Giá thuê mới (VND/tháng)</Label>
            <CurrencyInput
              id="new_rent_price"
              value={watch('new_rent_price')}
              onChange={(v) => setValue('new_rent_price', v, { shouldValidate: true, shouldDirty: true })}
              placeholder={contract.rent_price.toString()}
            />
            <p className="text-xs text-gray-500">
              Để trống nếu giữ nguyên giá hiện tại
            </p>
            {priceChanged && (
              <p className="text-sm text-orange-600">
                ⚠️ Giá thuê sẽ thay đổi từ {contract.rent_price.toLocaleString('vi-VN')} VND
                → {watchedNewPrice?.toLocaleString('vi-VN')} VND
              </p>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              {...register('notes')}
              placeholder="Lý do gia hạn, điều khoản mới..."
              rows={3}
            />
          </div>

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
              disabled={extendMutation.isPending}
            >
              {extendMutation.isPending ? 'Đang xử lý...' : 'Tạo yêu cầu gia hạn'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default ExtendContractDialog;
