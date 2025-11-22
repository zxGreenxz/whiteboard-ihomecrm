import { useState, useEffect } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTerminateContract, useEstimateTerminationCosts } from '@/hooks/useContracts';
import { XCircle, AlertTriangle, DollarSign } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { ContractWithRelations } from '@/hooks/useContracts';

interface TerminateContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations | null;
}

const terminateSchema = z.object({
  termination_type: z.enum(['NORMAL', 'EARLY_TENANT', 'EARLY_OWNER', 'BREACH', 'FORFEIT']),
  actual_move_out_date: z.string().min(1, 'Vui lòng chọn ngày chuyển đi'),
  early_termination_fee: z.number().min(0).optional(),
  damage_fee: z.number().min(0).optional(),
  damage_description: z.string().optional(),
  cleaning_fee: z.number().min(0).optional(),
  notes: z.string().optional(),
});

type TerminateFormData = z.infer<typeof terminateSchema>;

const TerminateContractDialog = ({ open, onOpenChange, contract }: TerminateContractDialogProps) => {
  const [showPreview, setShowPreview] = useState(false);
  const [costEstimate, setCostEstimate] = useState<any>(null);

  const terminateMutation = useTerminateContract();
  const estimateMutation = useEstimateTerminationCosts();

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<TerminateFormData>({
    resolver: zodResolver(terminateSchema),
    defaultValues: {
      termination_type: 'NORMAL',
      early_termination_fee: 0,
      damage_fee: 0,
      cleaning_fee: 0,
    },
  });

  const watchedMoveOutDate = watch('actual_move_out_date');
  const watchedDamageFee = watch('damage_fee');
  const watchedCleaningFee = watch('cleaning_fee');
  const watchedEarlyFee = watch('early_termination_fee');
  const watchedTerminationType = watch('termination_type');

  const handleClose = () => {
    reset();
    setShowPreview(false);
    setCostEstimate(null);
    onOpenChange(false);
  };

  const handlePreview = () => {
    if (!contract || !watchedMoveOutDate) return;

    estimateMutation.mutate(
      {
        contract_id: contract.id,
        move_out_date: watchedMoveOutDate,
        damage_fee: watchedDamageFee || 0,
        cleaning_fee: watchedCleaningFee || 0,
        early_termination_fee: watchedEarlyFee || 0,
      },
      {
        onSuccess: (data) => {
          setCostEstimate(data);
          setShowPreview(true);
        },
      }
    );
  };

  const onSubmit = (data: TerminateFormData) => {
    if (!contract) return;

    terminateMutation.mutate(
      {
        contract_id: contract.id,
        termination_type: data.termination_type,
        actual_move_out_date: data.actual_move_out_date,
        early_termination_fee: data.early_termination_fee,
        damage_fee: data.damage_fee,
        damage_description: data.damage_description,
        cleaning_fee: data.cleaning_fee,
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

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const isEarlyTermination = watchedMoveOutDate && new Date(watchedMoveOutDate) < new Date(contract.end_date);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-600" />
            Thanh lý hợp đồng
          </DialogTitle>
          <DialogDescription>
            Hợp đồng: {contract.contract_number || contract.id.slice(0, 8)}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Current Contract Info */}
          <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Khách thuê:</span>
              <span className="font-medium">{contract.tenant?.full_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Phòng/Giường:</span>
              <span className="font-medium">
                {contract.room ? `${contract.room.building?.name} - ${contract.room.name}` : ''}
                {contract.bed ? `${contract.bed.room?.building?.name} - ${contract.bed.room?.name} - ${contract.bed.name}` : ''}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Ngày kết thúc HĐ:</span>
              <span className="font-medium">
                {format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Tiền cọc:</span>
              <span className="font-medium">{formatCurrency(contract.total_deposit)}</span>
            </div>
          </div>

          {/* Termination Type */}
          <div className="space-y-2">
            <Label>Loại thanh lý *</Label>
            <Select
              defaultValue="NORMAL"
              onValueChange={(value) => setValue('termination_type', value as any)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NORMAL">Hết hạn bình thường</SelectItem>
                <SelectItem value="EARLY_TENANT">Khách rời sớm</SelectItem>
                <SelectItem value="EARLY_OWNER">Chủ nhà chấm dứt sớm</SelectItem>
                <SelectItem value="BREACH">Vi phạm hợp đồng</SelectItem>
                <SelectItem value="FORFEIT">Bỏ cọc</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Move Out Date */}
          <div className="space-y-2">
            <Label htmlFor="actual_move_out_date">Ngày chuyển đi thực tế *</Label>
            <Input
              id="actual_move_out_date"
              type="date"
              {...register('actual_move_out_date')}
            />
            {errors.actual_move_out_date && (
              <p className="text-sm text-red-500">{errors.actual_move_out_date.message}</p>
            )}
            {isEarlyTermination && (
              <Alert className="bg-orange-50 border-orange-200">
                <AlertTriangle className="h-4 w-4 text-orange-600" />
                <AlertDescription className="text-orange-800 text-sm">
                  Chấm dứt sớm {Math.ceil((new Date(contract.end_date).getTime() - new Date(watchedMoveOutDate).getTime()) / (1000 * 60 * 60 * 24))} ngày
                  trước hạn. Có thể áp dụng phí phạt.
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* Fees Section */}
          <div className="border rounded-md p-4 space-y-4">
            <h4 className="font-medium flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Các khoản phí
            </h4>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="early_termination_fee">Phí chấm dứt sớm (VND)</Label>
                <Input
                  id="early_termination_fee"
                  type="number"
                  {...register('early_termination_fee', { valueAsNumber: true })}
                  placeholder="0"
                />
                <p className="text-xs text-gray-500">
                  Phí phạt nếu khách rời trước hạn
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cleaning_fee">Phí vệ sinh (VND)</Label>
                <Input
                  id="cleaning_fee"
                  type="number"
                  {...register('cleaning_fee', { valueAsNumber: true })}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="damage_fee">Phí hư hỏng/Sửa chữa (VND)</Label>
              <Input
                id="damage_fee"
                type="number"
                {...register('damage_fee', { valueAsNumber: true })}
                placeholder="0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="damage_description">Mô tả hư hỏng</Label>
              <Textarea
                id="damage_description"
                {...register('damage_description')}
                placeholder="Kính cửa sổ vỡ, bóng đèn hỏng, tường bẩn..."
                rows={3}
              />
            </div>
          </div>

          {/* Preview Button */}
          <Button
            type="button"
            variant="outline"
            onClick={handlePreview}
            disabled={!watchedMoveOutDate || estimateMutation.isPending}
            className="w-full"
          >
            {estimateMutation.isPending ? 'Đang tính toán...' : 'Xem dự tính chi phí'}
          </Button>

          {/* Cost Estimate Preview */}
          {showPreview && costEstimate && (
            <div className="border-2 border-blue-200 rounded-md p-4 space-y-3 bg-blue-50">
              <h4 className="font-bold text-blue-900">Dự tính thanh toán</h4>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-700">Tiền cọc ban đầu:</span>
                  <span className="font-medium">{formatCurrency(costEstimate[0]?.total_deposit || 0)}</span>
                </div>

                <div className="border-t pt-2 space-y-1">
                  <p className="font-medium text-gray-700">Các khoản trừ:</p>
                  <div className="flex justify-between pl-4">
                    <span className="text-gray-600">- Công nợ cũ:</span>
                    <span>{formatCurrency(costEstimate[0]?.outstanding_debt || 0)}</span>
                  </div>
                  <div className="flex justify-between pl-4">
                    <span className="text-gray-600">- Tiền phòng ngày lẻ:</span>
                    <span>{formatCurrency(costEstimate[0]?.prorated_rent || 0)}</span>
                  </div>
                  <div className="flex justify-between pl-4">
                    <span className="text-gray-600">- Dịch vụ ngày lẻ:</span>
                    <span>{formatCurrency(costEstimate[0]?.prorated_services || 0)}</span>
                  </div>
                  <div className="flex justify-between pl-4">
                    <span className="text-gray-600">- Phí phạt/hư hỏng:</span>
                    <span>{formatCurrency(costEstimate[0]?.total_fees || 0)}</span>
                  </div>
                </div>

                <div className="border-t-2 pt-2 flex justify-between font-bold text-lg">
                  <span>
                    {(costEstimate[0]?.refund_amount || 0) >= 0 ? 'Hoàn trả khách:' : 'Khách phải trả thêm:'}
                  </span>
                  <span className={(costEstimate[0]?.refund_amount || 0) >= 0 ? 'text-green-600' : 'text-red-600'}>
                    {formatCurrency(Math.abs(costEstimate[0]?.refund_amount || 0))}
                  </span>
                </div>
              </div>

              {(costEstimate[0]?.refund_amount || 0) < 0 && (
                <Alert className="bg-red-50 border-red-200">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  <AlertDescription className="text-red-800 text-sm">
                    Khách thuê còn nợ. Cần thu thêm trước khi thanh lý.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              {...register('notes')}
              placeholder="Ghi chú về quá trình thanh lý..."
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
              variant="destructive"
              disabled={terminateMutation.isPending || !showPreview}
            >
              {terminateMutation.isPending ? 'Đang xử lý...' : 'Tạo yêu cầu thanh lý'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default TerminateContractDialog;
