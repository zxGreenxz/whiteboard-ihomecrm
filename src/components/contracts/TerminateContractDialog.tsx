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
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTerminateContract, useEstimateTerminationCosts } from '@/hooks/useContracts';
import { XCircle, AlertTriangle, DollarSign, Receipt, FileText, Banknote } from 'lucide-react';
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
  notice_violation_fee: z.number().min(0).optional(),
  damage_fee: z.number().min(0).optional(),
  damage_description: z.string().optional(),
  cleaning_fee: z.number().min(0).optional(),
  other_fees: z.number().min(0).optional(),
  other_fees_description: z.string().optional(),
  deposit_refund: z.number().min(0).optional(),
  excess_rent_refund: z.number().min(0).optional(),
  notes: z.string().optional(),
});

type TerminateFormData = z.infer<typeof terminateSchema>;

const TerminateContractDialog = ({ open, onOpenChange, contract }: TerminateContractDialogProps) => {
  const [terminationMode, setTerminationMode] = useState<'forfeit' | 'checkout'>('checkout');
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
      notice_violation_fee: 0,
      damage_fee: 0,
      cleaning_fee: 0,
      other_fees: 0,
      deposit_refund: 0,
      excess_rent_refund: 0,
    },
  });

  const watchedMoveOutDate = watch('actual_move_out_date');
  const watchedDamageFee = watch('damage_fee');
  const watchedCleaningFee = watch('cleaning_fee');
  const watchedEarlyFee = watch('early_termination_fee');
  const watchedNoticeFee = watch('notice_violation_fee');
  const watchedOtherFees = watch('other_fees');
  const watchedDepositRefund = watch('deposit_refund');
  const watchedExcessRentRefund = watch('excess_rent_refund');

  // Calculate totals
  const totalDeductions = (watchedEarlyFee || 0) + (watchedNoticeFee || 0) +
    (watchedDamageFee || 0) + (watchedCleaningFee || 0) + (watchedOtherFees || 0);
  const totalRefunds = (watchedDepositRefund || 0) + (watchedExcessRentRefund || 0);
  const netAmount = totalRefunds - totalDeductions;

  useEffect(() => {
    if (contract && terminationMode === 'checkout') {
      setValue('deposit_refund', contract.total_deposit);
    }
  }, [contract, terminationMode, setValue]);

  const handleClose = () => {
    reset();
    setShowPreview(false);
    setCostEstimate(null);
    setTerminationMode('checkout');
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

    const termType = terminationMode === 'forfeit' ? 'FORFEIT' : data.termination_type;

    terminateMutation.mutate(
      {
        contract_id: contract.id,
        termination_type: termType,
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

  // Mock outstanding debt (in real app, this would come from unpaid invoices)
  const outstandingDebt = 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-600" />
            Thanh lý hợp đồng
          </DialogTitle>
          <DialogDescription>
            Hợp đồng: {contract.contract_number || contract.id.slice(0, 8)} - {contract.tenant?.full_name}
          </DialogDescription>
        </DialogHeader>

        {/* Termination Mode Selection */}
        <div className="flex gap-4 mb-4">
          <label className="flex items-center gap-2 cursor-pointer p-3 border rounded-lg flex-1 hover:bg-gray-50">
            <Checkbox
              checked={terminationMode === 'forfeit'}
              onCheckedChange={() => {
                setTerminationMode('forfeit');
                setValue('termination_type', 'FORFEIT');
              }}
            />
            <div>
              <div className="font-medium">Khách bỏ cọc</div>
              <div className="text-sm text-gray-500">Khách không thuê nữa, mất tiền cọc</div>
            </div>
          </label>
          <label className="flex items-center gap-2 cursor-pointer p-3 border rounded-lg flex-1 hover:bg-gray-50">
            <Checkbox
              checked={terminationMode === 'checkout'}
              onCheckedChange={() => {
                setTerminationMode('checkout');
                setValue('termination_type', 'NORMAL');
              }}
            />
            <div>
              <div className="font-medium">Khách rời phòng</div>
              <div className="text-sm text-gray-500">Thanh lý và trả cọc cho khách</div>
            </div>
          </label>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* FORFEIT MODE */}
          {terminationMode === 'forfeit' && (
            <div className="space-y-4">
              <Alert className="bg-orange-50 border-orange-200">
                <AlertTriangle className="h-4 w-4 text-orange-600" />
                <AlertDescription className="text-orange-800">
                  Khi xác nhận "Khách bỏ cọc", toàn bộ tiền cọc {formatCurrency(contract.total_deposit)} sẽ
                  được chuyển thành doanh thu và hợp đồng sẽ được thanh lý.
                </AlertDescription>
              </Alert>

              {/* Basic Info */}
              <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Khách thuê:</span>
                  <span className="font-medium">{contract.tenant?.full_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Tiền cọc:</span>
                  <span className="font-medium text-green-600">{formatCurrency(contract.total_deposit)}</span>
                </div>
              </div>

              {/* Move Out Date */}
              <div className="space-y-2">
                <Label htmlFor="forfeit_date">Ngày bỏ cọc *</Label>
                <Input
                  id="forfeit_date"
                  type="date"
                  {...register('actual_move_out_date')}
                  defaultValue={new Date().toISOString().split('T')[0]}
                />
                {errors.actual_move_out_date && (
                  <p className="text-sm text-red-500">{errors.actual_move_out_date.message}</p>
                )}
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="forfeit_notes">Ghi chú</Label>
                <Textarea
                  id="forfeit_notes"
                  {...register('notes')}
                  placeholder="Lý do bỏ cọc, ghi chú..."
                  rows={3}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Hủy
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={terminateMutation.isPending}
                >
                  {terminateMutation.isPending ? 'Đang xử lý...' : 'Lập hóa đơn & thanh lý'}
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* CHECKOUT MODE */}
          {terminationMode === 'checkout' && (
            <div className="space-y-4">
              {/* Section 1: Contract Info */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Thông tin hợp đồng
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Khách thuê:</span>
                      <span className="font-medium">{contract.tenant?.full_name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Phòng:</span>
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
                      <span className="text-gray-600">Tiền thuê:</span>
                      <span className="font-medium">{formatCurrency(contract.rent_price)}</span>
                    </div>
                  </div>

                  <div className="space-y-2 pt-2 border-t">
                    <Label htmlFor="checkout_date">Ngày chuyển đi *</Label>
                    <Input
                      id="checkout_date"
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
                          Chấm dứt sớm {Math.ceil((new Date(contract.end_date).getTime() - new Date(watchedMoveOutDate).getTime()) / (1000 * 60 * 60 * 24))} ngày trước hạn.
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Section 2: Outstanding Debt */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Receipt className="h-4 w-4" />
                    Công nợ khách hàng
                  </CardTitle>
                  <CardDescription>Các hóa đơn chưa thanh toán</CardDescription>
                </CardHeader>
                <CardContent>
                  {outstandingDebt > 0 ? (
                    <div className="flex justify-between items-center p-3 bg-red-50 rounded-md">
                      <span className="text-red-800">Tổng công nợ:</span>
                      <span className="font-bold text-red-600">{formatCurrency(outstandingDebt)}</span>
                    </div>
                  ) : (
                    <div className="text-center py-4 text-gray-500">
                      Không có công nợ
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Section 3: Refunds */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Banknote className="h-4 w-4" />
                    Hoàn cọc và tiền thừa
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="deposit_refund">Hoàn tiền cọc (VND)</Label>
                      <Input
                        id="deposit_refund"
                        type="number"
                        {...register('deposit_refund', { valueAsNumber: true })}
                        placeholder="0"
                      />
                      <p className="text-xs text-gray-500">
                        Tiền cọc ban đầu: {formatCurrency(contract.total_deposit)}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="excess_rent_refund">Tiền phòng thừa (VND)</Label>
                      <Input
                        id="excess_rent_refund"
                        type="number"
                        {...register('excess_rent_refund', { valueAsNumber: true })}
                        placeholder="0"
                      />
                      <p className="text-xs text-gray-500">
                        Nếu khách đã trả trước
                      </p>
                    </div>
                  </div>

                  {/* Fees */}
                  <div className="pt-3 border-t space-y-3">
                    <h4 className="font-medium text-sm">Các khoản trừ/phí phạt</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="early_fee">Phí chấm dứt sớm</Label>
                        <Input
                          id="early_fee"
                          type="number"
                          {...register('early_termination_fee', { valueAsNumber: true })}
                          placeholder="0"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="notice_fee">Phí vi phạm báo trước</Label>
                        <Input
                          id="notice_fee"
                          type="number"
                          {...register('notice_violation_fee', { valueAsNumber: true })}
                          placeholder="0"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="damage_fee">Phí hư hỏng</Label>
                        <Input
                          id="damage_fee"
                          type="number"
                          {...register('damage_fee', { valueAsNumber: true })}
                          placeholder="0"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="cleaning_fee">Phí vệ sinh</Label>
                        <Input
                          id="cleaning_fee"
                          type="number"
                          {...register('cleaning_fee', { valueAsNumber: true })}
                          placeholder="0"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="other_fees">Phí khác</Label>
                      <Input
                        id="other_fees"
                        type="number"
                        {...register('other_fees', { valueAsNumber: true })}
                        placeholder="0"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="damage_description">Mô tả hư hỏng/phí khác</Label>
                      <Textarea
                        id="damage_description"
                        {...register('damage_description')}
                        placeholder="Mô tả chi tiết các hư hỏng hoặc phí phát sinh..."
                        rows={2}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Section 4: Summary */}
              <Card className="border-2 border-blue-200 bg-blue-50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Tổng hợp
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Hoàn cọc:</span>
                      <span className="text-green-600">+{formatCurrency(watchedDepositRefund || 0)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tiền thừa:</span>
                      <span className="text-green-600">+{formatCurrency(watchedExcessRentRefund || 0)}</span>
                    </div>
                    {outstandingDebt > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Công nợ:</span>
                        <span className="text-red-600">-{formatCurrency(outstandingDebt)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-600">Phí phạt/hư hỏng:</span>
                      <span className="text-red-600">-{formatCurrency(totalDeductions)}</span>
                    </div>
                  </div>

                  <div className="border-t-2 pt-3 flex justify-between font-bold text-lg">
                    <span>
                      {netAmount >= 0 ? 'Chủ nhà trả cho khách:' : 'Khách phải trả thêm:'}
                    </span>
                    <span className={netAmount >= 0 ? 'text-green-600' : 'text-red-600'}>
                      {formatCurrency(Math.abs(netAmount))}
                    </span>
                  </div>

                  {netAmount < 0 && (
                    <Alert className="bg-red-100 border-red-300">
                      <AlertTriangle className="h-4 w-4 text-red-600" />
                      <AlertDescription className="text-red-800 text-sm">
                        Khách thuê cần thanh toán thêm {formatCurrency(Math.abs(netAmount))} trước khi thanh lý.
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>

              {/* Termination Type Selection */}
              <div className="space-y-2">
                <Label>Loại thanh lý</Label>
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
                  </SelectContent>
                </Select>
              </div>

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
                <Button type="button" variant="outline" onClick={handleClose}>
                  Hủy
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={terminateMutation.isPending || !watchedMoveOutDate}
                >
                  {terminateMutation.isPending ? 'Đang xử lý...' : 'Lập hóa đơn & Thanh lý'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default TerminateContractDialog;
