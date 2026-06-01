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
import { CurrencyInput } from '@/components/ui/currency-input';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTerminateContract, useUnpaidInvoices } from '@/hooks/useContracts';
import { getRepresentativeName } from '@/lib/contractCustomerHelpers';
import { XCircle, AlertTriangle, FileText, Users, Wallet, Calculator } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { ContractWithRelations } from '@/hooks/useContracts';

interface TerminateContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations | null;
}

const terminateSchema = z.object({
  actual_move_out_date: z.string().min(1, 'Vui lòng chọn ngày'),
  deposit_refund: z.number().min(0).optional(),
  early_termination_fee: z.number().min(0).optional(),
  damage_fee: z.number().min(0).optional(),
  damage_description: z.string().optional(),
  cleaning_fee: z.number().min(0).optional(),
  notes: z.string().optional(),
});

type TerminateFormData = z.infer<typeof terminateSchema>;

const TerminateContractDialog = ({ open, onOpenChange, contract }: TerminateContractDialogProps) => {
  const [terminationCase, setTerminationCase] = useState<'FORFEIT' | 'MOVE_OUT'>('MOVE_OUT');

  const terminateMutation = useTerminateContract();

  // Fetch unpaid invoices for Case 2
  const { data: unpaidInvoices } = useUnpaidInvoices(
    terminationCase === 'MOVE_OUT' && open ? contract?.id : undefined
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    reset,
    setValue,
  } = useForm<TerminateFormData>({
    resolver: zodResolver(terminateSchema),
    defaultValues: {
      deposit_refund: contract?.total_deposit || 0,
      early_termination_fee: 0,
      damage_fee: 0,
      cleaning_fee: 0,
    },
  });

  const watchedMoveOutDate = watch('actual_move_out_date');
  const watchedDepositRefund = watch('deposit_refund');
  const watchedDamageFee = watch('damage_fee');
  const watchedCleaningFee = watch('cleaning_fee');
  const watchedEarlyFee = watch('early_termination_fee');

  const handleClose = () => {
    reset();
    setTerminationCase('MOVE_OUT');
    onOpenChange(false);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  // Calculate outstanding debt from unpaid invoices
  const outstandingDebt = useMemo(() => {
    if (!unpaidInvoices) return 0;
    return unpaidInvoices.reduce((sum, inv) => {
      const remaining = (inv.total_amount || 0) - (inv.paid_amount || 0);
      return sum + Math.max(remaining, 0);
    }, 0);
  }, [unpaidInvoices]);

  // Calculate prorated rent (excess rent for partial month)
  const proratedRent = useMemo(() => {
    if (!watchedMoveOutDate || !contract) return 0;
    const moveOut = new Date(watchedMoveOutDate);
    const dayOfMonth = moveOut.getDate();
    const daysInMonth = new Date(moveOut.getFullYear(), moveOut.getMonth() + 1, 0).getDate();
    if (dayOfMonth === daysInMonth) return 0; // Full month, no prorate
    const dailyRate = (contract.rent_price || 0) / daysInMonth;
    // Remaining days in the month after move-out (excess rent to refund)
    const remainingDays = daysInMonth - dayOfMonth;
    return Math.round(dailyRate * remainingDays);
  }, [watchedMoveOutDate, contract]);

  // Auto-calculated summary for Case 2
  const summary = useMemo(() => {
    const depositRefund = watchedDepositRefund || 0;
    const penalties = (watchedEarlyFee || 0) + (watchedDamageFee || 0) + (watchedCleaningFee || 0);
    const totalDeductions = outstandingDebt + penalties;
    const excessRent = proratedRent; // Rent refund for unused days
    const finalAmount = depositRefund + excessRent - totalDeductions;
    return {
      depositRefund,
      outstandingDebt,
      penalties,
      excessRent,
      totalDeductions,
      finalAmount, // positive = landlord pays tenant, negative = tenant pays more
    };
  }, [watchedDepositRefund, watchedEarlyFee, watchedDamageFee, watchedCleaningFee, outstandingDebt, proratedRent]);

  const isEarlyTermination = watchedMoveOutDate && contract
    ? new Date(watchedMoveOutDate) < new Date(contract.end_date)
    : false;

  const onSubmit = (data: TerminateFormData) => {
    if (!contract) return;

    let terminationType: string;
    if (terminationCase === 'FORFEIT') {
      terminationType = 'FORFEIT';
    } else {
      terminationType = isEarlyTermination ? 'EARLY_TENANT' : 'NORMAL';
    }

    terminateMutation.mutate(
      {
        contract_id: contract.id,
        termination_type: terminationType as any,
        actual_move_out_date: data.actual_move_out_date,
        early_termination_fee: terminationCase === 'MOVE_OUT' ? data.early_termination_fee : undefined,
        damage_fee: terminationCase === 'MOVE_OUT' ? data.damage_fee : undefined,
        damage_description: terminationCase === 'MOVE_OUT' ? data.damage_description : undefined,
        cleaning_fee: terminationCase === 'MOVE_OUT' ? data.cleaning_fee : undefined,
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
          {/* Case Selection */}
          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              className={`p-4 rounded-lg border-2 text-left transition-colors ${
                terminationCase === 'FORFEIT'
                  ? 'border-red-500 bg-red-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
              onClick={() => {
                setTerminationCase('FORFEIT');
                // Reset deposit refund to 0 for forfeit case
                setValue('deposit_refund', 0);
              }}
            >
              <div className="font-medium text-sm">Khách bỏ cọc</div>
              <div className="text-xs text-gray-500 mt-1">
                Khách không đến, mất cọc
              </div>
            </button>
            <button
              type="button"
              className={`p-4 rounded-lg border-2 text-left transition-colors ${
                terminationCase === 'MOVE_OUT'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
              onClick={() => {
                setTerminationCase('MOVE_OUT');
                // Reset deposit refund to contract deposit
                setValue('deposit_refund', contract.total_deposit || 0);
              }}
            >
              <div className="font-medium text-sm">Khách rời căn hộ</div>
              <div className="text-xs text-gray-500 mt-1">
                Trả cọc, lập hóa đơn thanh lý
              </div>
            </button>
          </div>

          {/* ============================================ */}
          {/* CASE 1: Khách bỏ cọc */}
          {/* ============================================ */}
          {terminationCase === 'FORFEIT' && (
            <>
              {/* Contract Info Summary */}
              <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Khách hàng:</span>
                  <span className="font-medium">{getRepresentativeName(contract as any)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Căn hộ:</span>
                  <span className="font-medium">
                    {contract.room ? `${contract.room.building?.name} - ${contract.room.name}` : 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Tiền cọc:</span>
                  <span className="font-medium text-red-600">{formatCurrency(contract.total_deposit || 0)}</span>
                </div>
              </div>

              {/* Ngày khách bỏ cọc */}
              <div className="space-y-2">
                <Label htmlFor="forfeit_date">Ngày khách bỏ cọc *</Label>
                <DateInput
                  value={watch('actual_move_out_date') || ''}
                  onChange={(v) => setValue('actual_move_out_date', v, { shouldValidate: true, shouldDirty: true })}
                />
                {errors.actual_move_out_date && (
                  <p className="text-sm text-red-500">{errors.actual_move_out_date.message}</p>
                )}
              </div>

              <Alert className="bg-red-50 border-red-200">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800 text-sm">
                  Tiền cọc {formatCurrency(contract.total_deposit || 0)} sẽ được ghi nhận vào doanh thu.
                </AlertDescription>
              </Alert>
            </>
          )}

          {/* ============================================ */}
          {/* CASE 2: Khách rời căn hộ */}
          {/* ============================================ */}
          {terminationCase === 'MOVE_OUT' && (
            <>
              {/* Section a: Thông tin hợp đồng */}
              <div className="border rounded-lg p-4 space-y-4">
                <h4 className="font-medium flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4" />
                  Thông tin hợp đồng
                </h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-600">Khách hàng:</span>
                    <div className="font-medium">{getRepresentativeName(contract as any)}</div>
                  </div>
                  <div>
                    <span className="text-gray-600">Căn hộ:</span>
                    <div className="font-medium">
                      {contract.room ? `${contract.room.building?.name} - ${contract.room.name}` : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-600">Ngày kết thúc HĐ:</span>
                    <div className="font-medium">
                      {format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-600">Giá thuê:</span>
                    <div className="font-medium">{formatCurrency(contract.rent_price || 0)}/tháng</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="move_out_date">Ngày chuyển đi *</Label>
                  <DateInput
                    value={watch('actual_move_out_date') || ''}
                    onChange={(v) => setValue('actual_move_out_date', v, { shouldValidate: true, shouldDirty: true })}
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
              </div>

              {/* Section b: Công nợ khách hàng */}
              <div className="border rounded-lg p-4 space-y-4">
                <h4 className="font-medium flex items-center gap-2 text-sm">
                  <Users className="h-4 w-4" />
                  Công nợ khách hàng
                </h4>
                {unpaidInvoices && unpaidInvoices.length > 0 ? (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Hóa đơn</TableHead>
                          <TableHead className="text-right">Tổng tiền</TableHead>
                          <TableHead className="text-right">Đã thanh toán</TableHead>
                          <TableHead className="text-right">Còn lại</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {unpaidInvoices.map((inv) => {
                          const remaining = (inv.total_amount || 0) - (inv.paid_amount || 0);
                          return (
                            <TableRow key={inv.id}>
                              <TableCell className="text-sm">
                                {inv.title || inv.invoice_number || inv.id.slice(0, 8)}
                              </TableCell>
                              <TableCell className="text-right text-sm">
                                {formatCurrency(inv.total_amount || 0)}
                              </TableCell>
                              <TableCell className="text-right text-sm text-green-600">
                                {formatCurrency(inv.paid_amount || 0)}
                              </TableCell>
                              <TableCell className="text-right text-sm font-medium text-red-600">
                                {formatCurrency(remaining)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <div className="flex justify-between text-sm font-medium border-t pt-2">
                      <span>Tổng công nợ:</span>
                      <span className="text-red-600">{formatCurrency(outstandingDebt)}</span>
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-gray-500 text-center py-2">
                    Không có công nợ
                  </div>
                )}
              </div>

              {/* Section c: Hoàn cọc và tiền thừa */}
              <div className="border rounded-lg p-4 space-y-4">
                <h4 className="font-medium flex items-center gap-2 text-sm">
                  <Wallet className="h-4 w-4" />
                  Hoàn cọc và tiền thừa
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Tiền cọc hoàn trả</Label>
                    <CurrencyInput
                      value={watch('deposit_refund')}
                      onChange={(v) => setValue('deposit_refund', v, { shouldValidate: true, shouldDirty: true })}
                    />
                    <p className="text-xs text-gray-500">
                      Không bao gồm các khoản phí cấn trừ
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Phí phạt chấm dứt sớm</Label>
                    <CurrencyInput
                      value={watch('early_termination_fee')}
                      onChange={(v) => setValue('early_termination_fee', v, { shouldValidate: true, shouldDirty: true })}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Tiền căn hộ thừa</Label>
                    <CurrencyInput
                      value={proratedRent}
                      readOnly
                      className="bg-gray-100"
                    />
                    <p className="text-xs text-gray-500">
                      Tự động tính theo ngày chuyển đi
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Phí hư hỏng / vệ sinh</Label>
                    <CurrencyInput
                      value={watch('damage_fee')}
                      onChange={(v) => setValue('damage_fee', v, { shouldValidate: true, shouldDirty: true })}
                      placeholder="0"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Phí vệ sinh</Label>
                  <CurrencyInput
                    value={watch('cleaning_fee')}
                    onChange={(v) => setValue('cleaning_fee', v, { shouldValidate: true, shouldDirty: true })}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Mô tả hư hỏng</Label>
                  <Textarea
                    {...register('damage_description')}
                    placeholder="Kính cửa sổ vỡ, bóng đèn hỏng, tường bẩn..."
                    rows={2}
                  />
                </div>
              </div>

              {/* Section d: Tổng hợp */}
              <div className="border-2 border-blue-200 rounded-lg p-4 space-y-3 bg-blue-50">
                <h4 className="font-bold flex items-center gap-2 text-blue-900 text-sm">
                  <Calculator className="h-4 w-4" />
                  Tổng hợp
                </h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-700">Tiền cọc hoàn trả:</span>
                    <span className="font-medium">{formatCurrency(summary.depositRefund)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-700">Tiền căn hộ thừa:</span>
                    <span className="font-medium text-green-600">+{formatCurrency(summary.excessRent)}</span>
                  </div>
                  <div className="border-t pt-2 space-y-1">
                    <p className="font-medium text-gray-700">Các khoản trừ:</p>
                    <div className="flex justify-between pl-4">
                      <span className="text-gray-600">- Công nợ chưa thanh toán:</span>
                      <span>{formatCurrency(summary.outstandingDebt)}</span>
                    </div>
                    <div className="flex justify-between pl-4">
                      <span className="text-gray-600">- Phí phạt / hư hỏng / vệ sinh:</span>
                      <span>{formatCurrency(summary.penalties)}</span>
                    </div>
                  </div>
                  <div className="border-t-2 pt-2 flex justify-between font-bold text-lg">
                    <span>
                      {summary.finalAmount >= 0
                        ? 'Chủ nhà thanh toán cho khách:'
                        : 'Khách hàng thanh toán thêm:'}
                    </span>
                    <span className={summary.finalAmount >= 0 ? 'text-green-600' : 'text-red-600'}>
                      {formatCurrency(Math.abs(summary.finalAmount))}
                    </span>
                  </div>
                </div>

                {summary.finalAmount < 0 && (
                  <Alert className="bg-red-50 border-red-200">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    <AlertDescription className="text-red-800 text-sm">
                      Khách hàng còn nợ. Cần thu thêm trước khi thanh lý.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </>
          )}

          {/* Notes (common for both cases) */}
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
              disabled={terminateMutation.isPending}
            >
              {terminateMutation.isPending
                ? 'Đang xử lý...'
                : terminationCase === 'FORFEIT'
                  ? 'Lập hóa đơn & thanh lý'
                  : 'Lập hóa đơn và Thanh lý'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default TerminateContractDialog;
