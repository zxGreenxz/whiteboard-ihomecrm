import { useState, useEffect } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
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
import { useCreateInvoice } from '@/hooks/useInvoices';
import { useContracts } from '@/hooks/useContracts';
import { useMeterReadings } from '@/hooks/useInvoices';
import { Receipt, Plus, Trash2, Home, Zap, Droplet } from 'lucide-react';
import { format, addMonths, startOfMonth, endOfMonth } from 'date-fns';
import { vi } from 'date-fns/locale';

interface GenerateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const invoiceItemSchema = z.object({
  type: z.string(),
  description: z.string().min(1, 'Vui lòng nhập mô tả'),
  quantity: z.number().min(0),
  unit_price: z.number().min(0),
  amount: z.number().min(0),
  service_id: z.string().optional(),
});

const generateInvoiceSchema = z.object({
  contract_id: z.string().min(1, 'Vui lòng chọn hợp đồng'),
  billing_period_start: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  billing_period_end: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  issue_date: z.string().min(1, 'Vui lòng chọn ngày phát hành'),
  due_date: z.string().min(1, 'Vui lòng chọn hạn thanh toán'),
  title: z.string().min(1, 'Vui lòng nhập tiêu đề'),
  items: z.array(invoiceItemSchema).min(1, 'Phải có ít nhất 1 khoản thu'),
  notes: z.string().optional(),
});

type GenerateInvoiceFormData = z.infer<typeof generateInvoiceSchema>;

const GenerateInvoiceDialog = ({ open, onOpenChange }: GenerateInvoiceDialogProps) => {
  const [selectedContractId, setSelectedContractId] = useState<string>('');
  const createMutation = useCreateInvoice();
  const { data: contracts } = useContracts({ status: 'ACTIVE' });
  const { data: meterReadings } = useMeterReadings(selectedContractId);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    control,
    reset,
  } = useForm<GenerateInvoiceFormData>({
    resolver: zodResolver(generateInvoiceSchema),
    defaultValues: {
      issue_date: new Date().toISOString().split('T')[0],
      due_date: addMonths(new Date(), 1).toISOString().split('T')[0],
      billing_period_start: startOfMonth(new Date()).toISOString().split('T')[0],
      billing_period_end: endOfMonth(new Date()).toISOString().split('T')[0],
      items: [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'items',
  });

  const watchedContractId = watch('contract_id');
  const watchedItems = watch('items');
  const watchedBillingStart = watch('billing_period_start');
  const watchedBillingEnd = watch('billing_period_end');

  const selectedContract = contracts?.find((c) => c.id === watchedContractId);

  // Auto-generate title when contract or dates change
  useEffect(() => {
    if (selectedContract && watchedBillingStart && watchedBillingEnd) {
      const title = `Hóa đơn ${selectedContract.contract_number || 'HĐ'} - ${format(new Date(watchedBillingStart), 'MM/yyyy', { locale: vi })}`;
      setValue('title', title);
    }
  }, [selectedContract, watchedBillingStart, watchedBillingEnd, setValue]);

  // Auto-add rent when contract selected
  useEffect(() => {
    if (selectedContract && fields.length === 0) {
      append({
        type: 'RENT',
        description: `Tiền thuê phòng ${selectedContract.room?.name || selectedContract.bed?.name || ''}`,
        quantity: 1,
        unit_price: selectedContract.rent_price,
        amount: selectedContract.rent_price,
      });

      // Add contract services
      selectedContract.contract_services?.forEach((cs) => {
        if (cs.service?.billing_type === 'FIXED') {
          append({
            type: 'SERVICE',
            description: cs.service.name,
            quantity: 1,
            unit_price: cs.unit_price || 0,
            amount: cs.unit_price || 0,
            service_id: cs.service_id,
          });
        }
      });
    }
  }, [selectedContract, append, fields.length]);

  const handleClose = () => {
    reset();
    setSelectedContractId('');
    onOpenChange(false);
  };

  const onSubmit = (data: GenerateInvoiceFormData) => {
    createMutation.mutate(data, {
      onSuccess: () => {
        handleClose();
      },
    });
  };

  const addCustomItem = () => {
    append({
      type: 'OTHER',
      description: '',
      quantity: 1,
      unit_price: 0,
      amount: 0,
    });
  };

  const addUtilityFromMeter = () => {
    if (!selectedContract || !meterReadings) return;

    const latestElectric = meterReadings
      .filter((r) => r.meter_type === 'ELECTRIC')
      .sort((a, b) => new Date(b.reading_date).getTime() - new Date(a.reading_date).getTime())[0];

    if (latestElectric) {
      const usage = latestElectric.current_reading - latestElectric.previous_reading;
      const service = selectedContract.contract_services?.find((cs) => cs.service_id === latestElectric.service_id);
      const unitPrice = service?.unit_price || 0;

      append({
        type: 'UTILITY',
        description: `Điện (${latestElectric.previous_reading} → ${latestElectric.current_reading})`,
        quantity: usage,
        unit_price: unitPrice,
        amount: usage * unitPrice,
        service_id: latestElectric.service_id,
      });
    }

    const latestWater = meterReadings
      .filter((r) => r.meter_type === 'WATER')
      .sort((a, b) => new Date(b.reading_date).getTime() - new Date(a.reading_date).getTime())[0];

    if (latestWater) {
      const usage = latestWater.current_reading - latestWater.previous_reading;
      const service = selectedContract.contract_services?.find((cs) => cs.service_id === latestWater.service_id);
      const unitPrice = service?.unit_price || 0;

      append({
        type: 'UTILITY',
        description: `Nước (${latestWater.previous_reading} → ${latestWater.current_reading})`,
        quantity: usage,
        unit_price: unitPrice,
        amount: usage * unitPrice,
        service_id: latestWater.service_id,
      });
    }
  };

  const updateItemAmount = (index: number) => {
    const item = watchedItems[index];
    if (item) {
      const newAmount = item.quantity * item.unit_price;
      setValue(`items.${index}.amount`, newAmount);
    }
  };

  const totalAmount = watchedItems.reduce((sum, item) => sum + (item.amount || 0), 0);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Tạo hóa đơn mới
          </DialogTitle>
          <DialogDescription>
            Tạo hóa đơn thanh toán cho hợp đồng
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Contract Selection */}
          <div className="space-y-2">
            <Label>Hợp đồng *</Label>
            <Select
              value={watchedContractId}
              onValueChange={(value) => {
                setValue('contract_id', value);
                setSelectedContractId(value);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn hợp đồng..." />
              </SelectTrigger>
              <SelectContent>
                {contracts?.map((contract) => (
                  <SelectItem key={contract.id} value={contract.id}>
                    {contract.contract_number || contract.id.slice(0, 8)} - {contract.tenant?.full_name}
                    {contract.room && ` - ${contract.room.name}`}
                    {contract.bed && ` - ${contract.bed.name}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.contract_id && (
              <p className="text-sm text-red-500">{errors.contract_id.message}</p>
            )}
          </div>

          {selectedContract && (
            <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Khách thuê:</span>
                <span className="font-medium">{selectedContract.tenant?.full_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Giá thuê:</span>
                <span className="font-medium">{formatCurrency(selectedContract.rent_price)}/tháng</span>
              </div>
            </div>
          )}

          {/* Dates Grid */}
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

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Tiêu đề hóa đơn *</Label>
            <Input
              id="title"
              {...register('title')}
              placeholder="VD: Hóa đơn tháng 11/2024"
            />
            {errors.title && (
              <p className="text-sm text-red-500">{errors.title.message}</p>
            )}
          </div>

          {/* Invoice Items */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Các khoản thu *</Label>
              <div className="flex gap-2">
                {meterReadings && meterReadings.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addUtilityFromMeter}
                  >
                    <Zap className="h-4 w-4 mr-2" />
                    Thêm điện/nước từ chỉ số
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addCustomItem}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Thêm khoản thu
                </Button>
              </div>
            </div>

            <div className="border rounded-md">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Loại</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Mô tả</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">SL</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Đơn giá</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-700">Thành tiền</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <tr key={field.id} className="border-t">
                      <td className="px-4 py-2">
                        <Select
                          value={watchedItems[index]?.type}
                          onValueChange={(value) => setValue(`items.${index}.type`, value)}
                        >
                          <SelectTrigger className="w-[120px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="RENT">
                              <div className="flex items-center gap-2">
                                <Home className="h-4 w-4" />
                                Tiền thuê
                              </div>
                            </SelectItem>
                            <SelectItem value="UTILITY">
                              <div className="flex items-center gap-2">
                                <Zap className="h-4 w-4" />
                                Điện/Nước
                              </div>
                            </SelectItem>
                            <SelectItem value="SERVICE">Dịch vụ</SelectItem>
                            <SelectItem value="OTHER">Khác</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          {...register(`items.${index}.description`)}
                          placeholder="Mô tả"
                          className="min-w-[200px]"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          type="number"
                          step="0.01"
                          {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                          onBlur={() => updateItemAmount(index)}
                          className="w-20"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          type="number"
                          {...register(`items.${index}.unit_price`, { valueAsNumber: true })}
                          onBlur={() => updateItemAmount(index)}
                          className="w-32"
                        />
                      </td>
                      <td className="px-4 py-2 font-medium">
                        {formatCurrency(watchedItems[index]?.amount || 0)}
                      </td>
                      <td className="px-4 py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => remove(index)}
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {errors.items && (
              <p className="text-sm text-red-500">{errors.items.message}</p>
            )}
          </div>

          {/* Total */}
          <div className="bg-blue-50 border border-blue-200 p-4 rounded-md">
            <div className="flex items-center justify-between">
              <span className="text-lg font-medium text-blue-900">Tổng cộng:</span>
              <span className="text-2xl font-bold text-blue-900">{formatCurrency(totalAmount)}</span>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              {...register('notes')}
              placeholder="Ghi chú về hóa đơn..."
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
              disabled={createMutation.isPending || fields.length === 0}
            >
              {createMutation.isPending ? 'Đang tạo...' : 'Tạo hóa đơn'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default GenerateInvoiceDialog;
