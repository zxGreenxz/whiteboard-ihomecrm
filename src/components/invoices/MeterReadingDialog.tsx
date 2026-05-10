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
import { useRecordMeterReading, useMeterReadings } from '@/hooks/useInvoices';
import { useContracts } from '@/hooks/useContracts';
import { getRepresentativeName } from '@/lib/contractCustomerHelpers';
import { Gauge, Zap, Droplet } from 'lucide-react';

interface MeterReadingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const meterReadingSchema = z.object({
  contract_id: z.string().min(1, 'Vui lòng chọn hợp đồng'),
  service_id: z.string().min(1, 'Vui lòng chọn dịch vụ'),
  meter_type: z.enum(['ELECTRIC', 'WATER', 'GAS', 'OTHER']),
  reading_date: z.string().min(1, 'Vui lòng chọn ngày ghi'),
  previous_reading: z.number().min(0, 'Chỉ số cũ >= 0'),
  current_reading: z.number().min(0, 'Chỉ số mới >= 0'),
  notes: z.string().optional(),
});

type MeterReadingFormData = z.infer<typeof meterReadingSchema>;

const MeterReadingDialog = ({ open, onOpenChange }: MeterReadingDialogProps) => {
  const [selectedContractId, setSelectedContractId] = useState<string>('');
  const [selectedServiceId, setSelectedServiceId] = useState<string>('');

  const recordMutation = useRecordMeterReading();
  const { data: contractsData } = useContracts();
  const contracts = (contractsData ?? []).filter((c: any) => c.status === 'ACTIVE');
  const { data: previousReadings } = useMeterReadings(selectedContractId);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<MeterReadingFormData>({
    resolver: zodResolver(meterReadingSchema),
    defaultValues: {
      meter_type: 'ELECTRIC',
      previous_reading: 0,
      current_reading: 0,
      reading_date: new Date().toISOString().split('T')[0],
    },
  });

  const watchedContractId = watch('contract_id');
  const watchedServiceId = watch('service_id');
  const watchedMeterType = watch('meter_type');
  const watchedPreviousReading = watch('previous_reading');
  const watchedCurrentReading = watch('current_reading');

  const selectedContract = contracts?.find((c) => c.id === watchedContractId);

  // Auto-fill previous reading from last meter reading
  useEffect(() => {
    if (watchedContractId && watchedServiceId && previousReadings) {
      const lastReading = previousReadings
        .filter((r) => r.service_id === watchedServiceId)
        .sort((a, b) => new Date(b.reading_date).getTime() - new Date(a.reading_date).getTime())[0];

      if (lastReading) {
        setValue('previous_reading', lastReading.current_reading);
      }
    }
  }, [watchedContractId, watchedServiceId, previousReadings, setValue]);

  const handleClose = () => {
    reset();
    setSelectedContractId('');
    setSelectedServiceId('');
    onOpenChange(false);
  };

  const onSubmit = (data: MeterReadingFormData) => {
    if (data.current_reading < data.previous_reading) {
      alert('Chỉ số mới phải lớn hơn hoặc bằng chỉ số cũ!');
      return;
    }

    recordMutation.mutate(data, {
      onSuccess: () => {
        handleClose();
      },
    });
  };

  const usage = watchedCurrentReading - watchedPreviousReading;

  const getMeterIcon = (type: string) => {
    switch (type) {
      case 'ELECTRIC':
        return <Zap className="h-4 w-4 text-yellow-600" />;
      case 'WATER':
        return <Droplet className="h-4 w-4 text-blue-600" />;
      default:
        return <Gauge className="h-4 w-4 text-gray-600" />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="h-5 w-5" />
            Ghi nhận chỉ số công tơ
          </DialogTitle>
          <DialogDescription>
            Ghi lại chỉ số điện, nước để tính toán hóa đơn
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
                setValue('service_id', ''); // Reset service when contract changes
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn hợp đồng đang hoạt động..." />
              </SelectTrigger>
              <SelectContent>
                {contracts?.map((contract) => (
                  <SelectItem key={contract.id} value={contract.id}>
                    {contract.contract_number || contract.id.slice(0, 8)} - {getRepresentativeName(contract as any, '')}
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

          {/* Service Selection */}
          {selectedContract && selectedContract.contract_services && selectedContract.contract_services.length > 0 && (
            <div className="space-y-2">
              <Label>Dịch vụ *</Label>
              <Select
                value={watchedServiceId}
                onValueChange={(value) => {
                  setValue('service_id', value);
                  setSelectedServiceId(value);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn dịch vụ..." />
                </SelectTrigger>
                <SelectContent>
                  {selectedContract.contract_services.map((cs) => (
                    <SelectItem key={cs.service_id} value={cs.service_id}>
                      {cs.service?.name} ({cs.unit_price?.toLocaleString('vi-VN')} VND/{cs.service?.unit})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.service_id && (
                <p className="text-sm text-red-500">{errors.service_id.message}</p>
              )}
            </div>
          )}

          {/* Meter Type */}
          <div className="space-y-2">
            <Label>Loại công tơ *</Label>
            <Select
              value={watchedMeterType}
              onValueChange={(value) => setValue('meter_type', value as any)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ELECTRIC">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-yellow-600" />
                    Điện
                  </div>
                </SelectItem>
                <SelectItem value="WATER">
                  <div className="flex items-center gap-2">
                    <Droplet className="h-4 w-4 text-blue-600" />
                    Nước
                  </div>
                </SelectItem>
                <SelectItem value="GAS">Ga</SelectItem>
                <SelectItem value="OTHER">Khác</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Reading Date */}
          <div className="space-y-2">
            <Label htmlFor="reading_date">Ngày ghi chỉ số *</Label>
            <Input
              id="reading_date"
              type="date"
              {...register('reading_date')}
            />
            {errors.reading_date && (
              <p className="text-sm text-red-500">{errors.reading_date.message}</p>
            )}
          </div>

          {/* Readings Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="previous_reading">Chỉ số cũ *</Label>
              <Input
                id="previous_reading"
                type="number"
                step="0.01"
                {...register('previous_reading', { valueAsNumber: true })}
                placeholder="0"
              />
              {errors.previous_reading && (
                <p className="text-sm text-red-500">{errors.previous_reading.message}</p>
              )}
              <p className="text-xs text-gray-500">
                Tự động lấy từ lần ghi trước
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="current_reading">Chỉ số mới *</Label>
              <Input
                id="current_reading"
                type="number"
                step="0.01"
                {...register('current_reading', { valueAsNumber: true })}
                placeholder="0"
              />
              {errors.current_reading && (
                <p className="text-sm text-red-500">{errors.current_reading.message}</p>
              )}
            </div>
          </div>

          {/* Usage Calculation */}
          {watchedCurrentReading >= watchedPreviousReading && (
            <div className="bg-blue-50 border border-blue-200 p-4 rounded-md">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-blue-900 flex items-center gap-2">
                  {getMeterIcon(watchedMeterType)}
                  Mức tiêu thụ:
                </span>
                <span className="text-2xl font-bold text-blue-900">
                  {usage.toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-blue-700 mt-1">
                = {watchedCurrentReading} - {watchedPreviousReading}
              </p>
            </div>
          )}

          {watchedCurrentReading < watchedPreviousReading && watchedCurrentReading > 0 && (
            <div className="bg-red-50 border border-red-200 p-3 rounded-md">
              <p className="text-sm text-red-800">
                ⚠️ Chỉ số mới phải lớn hơn hoặc bằng chỉ số cũ!
              </p>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              {...register('notes')}
              placeholder="Ghi chú về chỉ số (nếu có)..."
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
              disabled={recordMutation.isPending || watchedCurrentReading < watchedPreviousReading}
            >
              {recordMutation.isPending ? 'Đang lưu...' : 'Ghi nhận chỉ số'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default MeterReadingDialog;
