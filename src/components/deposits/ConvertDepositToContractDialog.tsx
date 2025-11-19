import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConvertDepositToContract, type DepositWithRelations } from '@/hooks/useDeposits';
import { Card } from '@/components/ui/card';
import { format, addMonths } from 'date-fns';

// =============================================
// Validation Schema
// =============================================

const convertSchema = z.object({
  start_date: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  end_date: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  monthly_rent: z.string().min(1, 'Vui lòng nhập tiền thuê'),
  deposit_amount: z.string().min(1, 'Vui lòng nhập tiền đặt cọc'),
  payment_day: z.string().min(1, 'Vui lòng nhập ngày thanh toán'),
  contract_type: z.string().min(1, 'Vui lòng chọn loại hợp đồng'),
  notes: z.string().optional(),
});

type ConvertFormData = z.infer<typeof convertSchema>;

// =============================================
// Component
// =============================================

interface ConvertDepositToContractDialogProps {
  deposit: DepositWithRelations;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ConvertDepositToContractDialog({
  deposit,
  open,
  onOpenChange,
}: ConvertDepositToContractDialogProps) {
  // Hooks
  const convertDeposit = useConvertDepositToContract();

  // Form
  const form = useForm<ConvertFormData>({
    resolver: zodResolver(convertSchema),
    defaultValues: {
      start_date: format(new Date(), 'yyyy-MM-dd'),
      end_date: format(addMonths(new Date(), 12), 'yyyy-MM-dd'),
      monthly_rent: '',
      deposit_amount: deposit.amount.toString(),
      payment_day: '5',
      contract_type: 'LONG_TERM',
      notes: '',
    },
  });

  // =============================================
  // Handlers
  // =============================================

  const onSubmit = async (data: ConvertFormData) => {
    await convertDeposit.mutateAsync({
      depositId: deposit.id,
      contractData: {
        start_date: data.start_date,
        end_date: data.end_date,
        monthly_rent: parseFloat(data.monthly_rent),
        deposit_amount: parseFloat(data.deposit_amount),
        payment_day: parseInt(data.payment_day),
        contract_type: data.contract_type,
        notes: data.notes || undefined,
      },
    });

    onOpenChange(false);
  };

  // =============================================
  // Render
  // =============================================

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chuyển đặt cọc thành hợp đồng</DialogTitle>
          <DialogDescription>
            Tạo hợp đồng chính thức cho khách hàng <strong>{deposit.tenant?.full_name}</strong>.
            Phòng/giường sẽ được chuyển sang trạng thái "Đang sử dụng".
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Deposit Summary */}
            <Card className="p-4 bg-blue-50 border-blue-200">
              <h3 className="font-semibold text-blue-900 mb-2">Thông tin đặt cọc</h3>
              <div className="grid grid-cols-2 gap-4 text-sm text-blue-800">
                <div>
                  <span className="font-medium">Khách hàng:</span> {deposit.tenant?.full_name}
                </div>
                <div>
                  <span className="font-medium">Số điện thoại:</span> {deposit.tenant?.phone}
                </div>
                {deposit.room && (
                  <>
                    <div>
                      <span className="font-medium">Tòa nhà:</span> {deposit.room.building.name}
                    </div>
                    <div>
                      <span className="font-medium">Phòng:</span> {deposit.room.name}
                    </div>
                  </>
                )}
                {deposit.bed && (
                  <>
                    <div>
                      <span className="font-medium">Tòa nhà:</span> {deposit.bed.room.building.name}
                    </div>
                    <div>
                      <span className="font-medium">Phòng:</span> {deposit.bed.room.name}
                    </div>
                    <div>
                      <span className="font-medium">Giường:</span> {deposit.bed.name}
                    </div>
                  </>
                )}
                <div>
                  <span className="font-medium">Tiền cọc:</span>{' '}
                  {new Intl.NumberFormat('vi-VN').format(deposit.amount)}₫
                </div>
              </div>
            </Card>

            {/* Contract Duration */}
            <Card className="p-4 space-y-4">
              <h3 className="font-semibold">Thời hạn hợp đồng</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="start_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ngày bắt đầu *</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="end_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ngày kết thúc *</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="contract_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại hợp đồng *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn loại hợp đồng" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="LONG_TERM">Dài hạn (≥ 6 tháng)</SelectItem>
                        <SelectItem value="SHORT_TERM">Ngắn hạn (< 6 tháng)</SelectItem>
                        <SelectItem value="MONTHLY">Theo tháng</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </Card>

            {/* Financial Details */}
            <Card className="p-4 space-y-4">
              <h3 className="font-semibold">Thông tin thanh toán</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="monthly_rent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tiền thuê hàng tháng (VNĐ) *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="3000000"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="deposit_amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tiền đặt cọc (VNĐ) *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Đã lấy từ số tiền đặt cọc hiện tại
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="payment_day"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày thanh toán hàng tháng *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {[1, 5, 10, 15, 20, 25, 30].map((day) => (
                          <SelectItem key={day} value={day.toString()}>
                            Ngày {day} hàng tháng
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </Card>

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Thêm ghi chú về hợp đồng..."
                      className="min-h-[100px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={convertDeposit.isPending}>
                {convertDeposit.isPending ? 'Đang tạo...' : 'Tạo hợp đồng'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
