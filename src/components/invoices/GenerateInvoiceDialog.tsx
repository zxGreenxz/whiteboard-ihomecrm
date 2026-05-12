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
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { DateInput } from '@/components/ui/date-input';
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
import type { InvoiceFormData } from '@/types/invoice';
import { useContracts } from '@/hooks/useContracts';
import { useMeterReadings } from '@/hooks/useInvoices';
import { useVehicles } from '@/hooks/useVehicles';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import MeterReadingSelector from '@/components/invoices/MeterReadingSelector';
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
  const [selectedElectricReadingId, setSelectedElectricReadingId] = useState<string>();
  const [selectedWaterReadingId, setSelectedWaterReadingId] = useState<string>();
  const [filterBuildingId, setFilterBuildingId] = useState<string>('');
  const [filterRoomId, setFilterRoomId] = useState<string>('');
  const createMutation = useCreateInvoice();
  const { data: contractsData } = useContracts();
  const allActiveContracts = (contractsData ?? []).filter((c: any) => c.status === 'ACTIVE');
  const contracts = allActiveContracts.filter((c: any) => {
    if (filterBuildingId && c.room?.building_id !== filterBuildingId) return false;
    if (filterRoomId && c.room_id !== filterRoomId) return false;
    return true;
  });
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(filterBuildingId || undefined);
  const { data: meterReadings } = useMeterReadings(selectedContractId);
  const { data: vehicles } = useVehicles({ contract_id: selectedContractId });

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

  // Derive room ID and settlement month for meter reading integration
  const contractRoomId = selectedContract?.room?.id || selectedContract?.bed?.room?.id || '';
  const billingMonth = watchedBillingStart
    ? format(new Date(watchedBillingStart), 'yyyy-MM')
    : '';

  // Get unit prices for electricity and water from contract services
  const electricityService = selectedContract?.contract_services?.find(
    (cs) => cs.service?.name?.toLowerCase().includes('điện') || cs.service?.type === 'METER_READING'
  );
  const waterService = selectedContract?.contract_services?.find(
    (cs) => cs.service?.name?.toLowerCase().includes('nước') || (cs.service?.type === 'METER_READING' && cs.service?.name?.toLowerCase().includes('nước'))
  );
  // Separate electricity vs water more precisely
  const electricityUnitPrice = selectedContract?.contract_services?.find(
    (cs) => cs.service?.name?.toLowerCase().includes('điện')
  )?.unit_price || 0;
  const waterUnitPrice = selectedContract?.contract_services?.find(
    (cs) => cs.service?.name?.toLowerCase().includes('nước')
  )?.unit_price || 0;

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
        description: `Tiền thuê căn hộ ${selectedContract.room?.name || selectedContract.bed?.name || ''}`,
        quantity: 1,
        unit_price: selectedContract.rent_price,
        amount: selectedContract.rent_price,
      });

      // Add contract services
      selectedContract.contract_services?.forEach((cs) => {
        if (cs.service?.type === 'FIXED') {
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

      // Add vehicle parking fees
      vehicles?.forEach((vehicle) => {
        if (vehicle.parking_fee && vehicle.parking_fee > 0) {
          append({
            type: 'SERVICE',
            description: `Phí gửi xe ${vehicle.license_plate || vehicle.vehicle_type}`,
            quantity: 1,
            unit_price: vehicle.parking_fee,
            amount: vehicle.parking_fee,
          });
        }
      });
    }
  }, [selectedContract, vehicles, append, fields.length]);

  const handleClose = () => {
    reset();
    setSelectedContractId('');
    setSelectedElectricReadingId(undefined);
    setSelectedWaterReadingId(undefined);
    setFilterBuildingId('');
    setFilterRoomId('');
    onOpenChange(false);
  };

  const onSubmit = (data: GenerateInvoiceFormData) => {
    if (!selectedContract) return;

    // Derive building_id, room_id, bed_id from selected contract
    const roomData = selectedContract.room as any;
    const bedData = selectedContract.bed as any;
    const buildingId = roomData?.building?.id || bedData?.room?.building?.id || '';
    const roomId = roomData?.id || bedData?.room?.id || '';
    const bedId = bedData?.id || null;

    // Derive billing_month from billing_period_start (YYYY-MM-DD → YYYY-MM)
    const billingMonth = data.billing_period_start
      ? format(new Date(data.billing_period_start), 'yyyy-MM')
      : format(new Date(), 'yyyy-MM');

    // Map old items format to new InvoiceFormData items format
    const mappedItems = data.items.map((item, index) => ({
      service_id: item.service_id || null,
      type: (item.type === 'UTILITY' ? 'SERVICE' : item.type) as any,
      description: item.description,
      unit_price: item.unit_price,
      quantity: item.quantity,
      coefficient: 1,
      sort_order: index,
    }));

    const invoiceFormData: InvoiceFormData = {
      building_id: buildingId,
      room_id: roomId,
      bed_id: bedId,
      contract_id: data.contract_id,
      billing_month: billingMonth,
      issue_date: data.issue_date,
      due_date: data.due_date,
      notes: data.notes || null,
      discount_amount: 0,
      tax_percent: 0,
      prepaid_amount: 0,
      previous_debt: 0,
      items: mappedItems,
    };

    createMutation.mutate(invoiceFormData, {
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

  // Handler for when an approved meter reading is selected (Requirement 11.1, 11.2)
  const handleMeterReadingSelect = (
    meterType: 'ELECTRICITY' | 'WATER',
    data: { readingId: string; consumption: number; amount: number; description: string }
  ) => {
    if (meterType === 'ELECTRICITY') {
      setSelectedElectricReadingId(data.readingId);
    } else {
      setSelectedWaterReadingId(data.readingId);
    }

    // Find the service_id for this meter type
    const service = selectedContract?.contract_services?.find(
      (cs) => cs.service?.name?.toLowerCase().includes(meterType === 'ELECTRICITY' ? 'điện' : 'nước')
    );

    // Remove existing item of same utility type before adding
    const existingIndex = watchedItems.findIndex(
      (item) => item.type === 'UTILITY' && item.description.toLowerCase().includes(meterType === 'ELECTRICITY' ? 'điện' : 'nước')
    );
    if (existingIndex >= 0) {
      remove(existingIndex);
    }

    append({
      type: 'UTILITY',
      description: data.description,
      quantity: data.consumption,
      unit_price: meterType === 'ELECTRICITY' ? electricityUnitPrice : waterUnitPrice,
      amount: data.amount,
      service_id: service?.service_id,
    });
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
          {/* Lọc theo Toà nhà · Phòng — thu hẹp dropdown Hợp đồng */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Toà nhà</Label>
              <Select
                value={filterBuildingId || '__all__'}
                onValueChange={(value) => {
                  const next = value === '__all__' ? '' : value;
                  setFilterBuildingId(next);
                  setFilterRoomId('');
                  setValue('contract_id', '');
                  setSelectedContractId('');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Tất cả toà nhà" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Tất cả toà nhà</SelectItem>
                  {(buildings as any[]).map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Phòng</Label>
              <Select
                value={filterRoomId || '__all__'}
                onValueChange={(value) => {
                  const next = value === '__all__' ? '' : value;
                  setFilterRoomId(next);
                  setValue('contract_id', '');
                  setSelectedContractId('');
                }}
                disabled={!filterBuildingId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={filterBuildingId ? 'Tất cả phòng' : 'Chọn toà nhà trước'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Tất cả phòng</SelectItem>
                  {(rooms as any[]).map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

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
                {contracts?.map((contract: any) => {
                  const rep = contract.contract_customers?.find((cc: any) => cc.is_representative)
                    ?? contract.contract_customers?.[0];
                  const customerName = rep?.customer?.full_name ?? contract.tenant?.full_name ?? '';
                  return (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.contract_number || contract.id.slice(0, 8)}
                      {customerName && ` - ${customerName}`}
                      {contract.room && ` - ${contract.room.name}`}
                      {contract.bed && ` - ${contract.bed.name}`}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {errors.contract_id && (
              <p className="text-sm text-red-500">{errors.contract_id.message}</p>
            )}
          </div>

          {selectedContract && (() => {
            const rep = (selectedContract as any).contract_customers?.find((cc: any) => cc.is_representative)
              ?? (selectedContract as any).contract_customers?.[0];
            const customerName = rep?.customer?.full_name ?? (selectedContract as any).tenant?.full_name ?? '—';
            return (
              <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Khách hàng:</span>
                  <span className="font-medium">{customerName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Giá thuê:</span>
                  <span className="font-medium">{formatCurrency(selectedContract.rent_price)}/tháng</span>
                </div>
              </div>
            );
          })()}

          {/* Dates Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="billing_period_start">Kỳ thanh toán từ *</Label>
              <DateInput
                value={watch('billing_period_start') || ''}
                onChange={(v) => setValue('billing_period_start', v, { shouldValidate: true, shouldDirty: true })}
              />
              {errors.billing_period_start && (
                <p className="text-sm text-red-500">{errors.billing_period_start.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="billing_period_end">Đến *</Label>
              <DateInput
                value={watch('billing_period_end') || ''}
                onChange={(v) => setValue('billing_period_end', v, { shouldValidate: true, shouldDirty: true })}
              />
              {errors.billing_period_end && (
                <p className="text-sm text-red-500">{errors.billing_period_end.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="issue_date">Ngày phát hành *</Label>
              <DateInput
                value={watch('issue_date') || ''}
                onChange={(v) => setValue('issue_date', v, { shouldValidate: true, shouldDirty: true })}
              />
              {errors.issue_date && (
                <p className="text-sm text-red-500">{errors.issue_date.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="due_date">Hạn thanh toán *</Label>
              <DateInput
                value={watch('due_date') || ''}
                onChange={(v) => setValue('due_date', v, { shouldValidate: true, shouldDirty: true })}
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

            {/* Meter Reading Selectors for Electricity/Water (Requirement 11.1, 11.2, 11.3) */}
            {selectedContract && contractRoomId && billingMonth && (
              <div className="space-y-3 p-3 bg-gray-50 rounded-md border">
                <p className="text-sm font-medium text-gray-700">Chỉ số công tơ</p>
                <MeterReadingSelector
                  roomId={contractRoomId}
                  month={billingMonth}
                  meterType="ELECTRICITY"
                  unitPrice={electricityUnitPrice}
                  selectedReadingId={selectedElectricReadingId}
                  onSelect={(data) => handleMeterReadingSelect('ELECTRICITY', data)}
                />
                <MeterReadingSelector
                  roomId={contractRoomId}
                  month={billingMonth}
                  meterType="WATER"
                  unitPrice={waterUnitPrice}
                  selectedReadingId={selectedWaterReadingId}
                  onSelect={(data) => handleMeterReadingSelect('WATER', data)}
                />
              </div>
            )}

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
                        <NumberInput
                          value={watchedItems[index]?.quantity}
                          onChange={(v) => setValue(`items.${index}.quantity`, v)}
                          onBlur={() => updateItemAmount(index)}
                          allowDecimal
                          className="w-20"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <CurrencyInput
                          value={watchedItems[index]?.unit_price}
                          onChange={(v) => setValue(`items.${index}.unit_price`, v)}
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
