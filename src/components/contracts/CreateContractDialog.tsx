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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useCreateContract } from '@/hooks/useContracts';
import { useTenants } from '@/hooks/useTenants';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { useServices } from '@/hooks/useServices';
import { useDeposits } from '@/hooks/useDeposits';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { format } from 'date-fns';

interface CreateContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const contractSchema = z.object({
  tenant_id: z.string().min(1, 'Vui lòng chọn khách thuê'),
  rental_type: z.enum(['room', 'bed']),
  room_id: z.string().optional(),
  bed_id: z.string().optional(),
  signed_date: z.string().min(1, 'Vui lòng chọn ngày ký'),
  start_date: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  end_date: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  rent_price: z.number().min(0, 'Giá thuê phải >= 0'),
  payment_cycle: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']),
  total_deposit: z.number().min(0, 'Tiền cọc phải >= 0'),
  deposit_paid: z.number().min(0).optional(),
  initial_electricity_reading: z.number().optional(),
  initial_water_reading: z.number().optional(),
  notes: z.string().optional(),
  services: z.array(z.object({
    service_id: z.string(),
    unit_price: z.number(),
    initial_reading: z.number().optional(),
  })).optional(),
});

type ContractFormData = z.infer<typeof contractSchema>;

const CreateContractDialog = ({ open, onOpenChange }: CreateContractDialogProps) => {
  const [step, setStep] = useState(1);
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');
  const [rentalType, setRentalType] = useState<'room' | 'bed'>('room');
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [selectedBedId, setSelectedBedId] = useState<string>('');
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());

  const createContractMutation = useCreateContract();
  const { data: tenants } = useTenants();
  const { data: rooms } = useRooms({ status: 'AVAILABLE' });
  const { data: beds } = useBeds({ status: 'AVAILABLE' });
  const { data: services } = useServices();
  const { data: deposits } = useDeposits({
    tenant_id: selectedTenantId,
    status: 'CONFIRMED',
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<ContractFormData>({
    resolver: zodResolver(contractSchema),
    defaultValues: {
      payment_cycle: 'MONTHLY',
      rental_type: 'room',
    },
  });

  const watchedValues = watch();

  const handleClose = () => {
    reset();
    setStep(1);
    setSelectedTenantId('');
    setSelectedRoomId('');
    setSelectedBedId('');
    setSelectedServices(new Set());
    onOpenChange(false);
  };

  const onSubmit = (data: ContractFormData) => {
    const servicesData = Array.from(selectedServices).map(serviceId => {
      const service = services?.find(s => s.id === serviceId);
      return {
        service_id: serviceId,
        unit_price: service?.unit_price || 0,
        initial_reading: service?.type === 'METER_READING' ? 0 : undefined,
      };
    });

    createContractMutation.mutate(
      {
        ...data,
        services: servicesData,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      }
    );
  };

  const nextStep = () => setStep(prev => Math.min(prev + 1, 4));
  const prevStep = () => setStep(prev => Math.max(prev - 1, 1));

  // Auto-fill deposit paid from deposits table
  const totalDepositPaid = deposits?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;

  // Auto-fill rent price from selected room/bed
  const selectedRoom = rooms?.find(r => r.id === selectedRoomId);
  const selectedBed = beds?.find(b => b.id === selectedBedId);
  const autoRentPrice = rentalType === 'room' ? selectedRoom?.rent_price : selectedBed?.rent_price;
  const autoDeposit = rentalType === 'room' ? selectedRoom?.deposit_amount : selectedBed?.deposit_amount;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Tạo hợp đồng mới - Bước {step}/4
          </DialogTitle>
          <DialogDescription>
            {step === 1 && 'Chọn hoặc tạo khách thuê'}
            {step === 2 && 'Chọn phòng hoặc giường'}
            {step === 3 && 'Nhập thông tin hợp đồng'}
            {step === 4 && 'Chọn dịch vụ'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)}>
          {/* Step 1: Select Tenant */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Chọn khách thuê *</Label>
                <Select
                  value={selectedTenantId}
                  onValueChange={(value) => {
                    setSelectedTenantId(value);
                    setValue('tenant_id', value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn khách thuê..." />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants?.map((tenant) => (
                      <SelectItem key={tenant.id} value={tenant.id}>
                        {tenant.full_name} - {tenant.phone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.tenant_id && (
                  <p className="text-sm text-red-500">{errors.tenant_id.message}</p>
                )}
              </div>

              {selectedTenantId && totalDepositPaid > 0 && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-md">
                  <p className="text-sm font-medium text-blue-900">
                    Tiền cọc đã có: {totalDepositPaid.toLocaleString('vi-VN')} VND
                  </p>
                  <p className="text-xs text-blue-700 mt-1">
                    Số tiền này sẽ được tự động trừ vào tiền cọc hợp đồng
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Select Room/Bed */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Loại thuê *</Label>
                <Select
                  value={rentalType}
                  onValueChange={(value: 'room' | 'bed') => {
                    setRentalType(value);
                    setValue('rental_type', value);
                    setSelectedRoomId('');
                    setSelectedBedId('');
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="room">Thuê nguyên phòng</SelectItem>
                    <SelectItem value="bed">Thuê giường (KTX/Sleepbox)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {rentalType === 'room' && (
                <div className="space-y-2">
                  <Label>Chọn phòng *</Label>
                  <Select
                    value={selectedRoomId}
                    onValueChange={(value) => {
                      setSelectedRoomId(value);
                      setValue('room_id', value);
                      setValue('bed_id', undefined);
                      // Auto-fill rent price
                      const room = rooms?.find(r => r.id === value);
                      if (room) {
                        setValue('rent_price', room.rent_price || 0);
                        setValue('total_deposit', room.deposit_amount || 0);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn phòng trống..." />
                    </SelectTrigger>
                    <SelectContent>
                      {rooms?.map((room) => (
                        <SelectItem key={room.id} value={room.id}>
                          {room.building?.name} - {room.name} ({room.rent_price?.toLocaleString('vi-VN')} VND/tháng)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!watchedValues.room_id && (
                    <p className="text-sm text-red-500">Vui lòng chọn phòng</p>
                  )}
                </div>
              )}

              {rentalType === 'bed' && (
                <div className="space-y-2">
                  <Label>Chọn giường *</Label>
                  <Select
                    value={selectedBedId}
                    onValueChange={(value) => {
                      setSelectedBedId(value);
                      setValue('bed_id', value);
                      setValue('room_id', undefined);
                      // Auto-fill rent price
                      const bed = beds?.find(b => b.id === value);
                      if (bed) {
                        setValue('rent_price', bed.rent_price || 0);
                        setValue('total_deposit', bed.deposit_amount || 0);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn giường trống..." />
                    </SelectTrigger>
                    <SelectContent>
                      {beds?.map((bed) => (
                        <SelectItem key={bed.id} value={bed.id}>
                          {bed.room?.building?.name} - {bed.room?.name} - {bed.name} ({bed.rent_price?.toLocaleString('vi-VN')} VND/tháng)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!watchedValues.bed_id && (
                    <p className="text-sm text-red-500">Vui lòng chọn giường</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Contract Details */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="signed_date">Ngày ký *</Label>
                  <Input
                    id="signed_date"
                    type="date"
                    {...register('signed_date')}
                    defaultValue={format(new Date(), 'yyyy-MM-dd')}
                  />
                  {errors.signed_date && (
                    <p className="text-sm text-red-500">{errors.signed_date.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="start_date">Ngày bắt đầu *</Label>
                  <Input
                    id="start_date"
                    type="date"
                    {...register('start_date')}
                  />
                  {errors.start_date && (
                    <p className="text-sm text-red-500">{errors.start_date.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end_date">Ngày kết thúc *</Label>
                  <Input
                    id="end_date"
                    type="date"
                    {...register('end_date')}
                  />
                  {errors.end_date && (
                    <p className="text-sm text-red-500">{errors.end_date.message}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rent_price">Giá thuê (VND/tháng) *</Label>
                  <Input
                    id="rent_price"
                    type="number"
                    {...register('rent_price', { valueAsNumber: true })}
                    defaultValue={autoRentPrice}
                  />
                  {errors.rent_price && (
                    <p className="text-sm text-red-500">{errors.rent_price.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="payment_cycle">Chu kỳ thanh toán *</Label>
                  <Select
                    defaultValue="MONTHLY"
                    onValueChange={(value) => setValue('payment_cycle', value as any)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MONTHLY">Hàng tháng</SelectItem>
                      <SelectItem value="QUARTERLY">3 tháng</SelectItem>
                      <SelectItem value="SEMI_ANNUAL">6 tháng</SelectItem>
                      <SelectItem value="ANNUAL">1 năm</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="total_deposit">Tổng tiền cọc (VND) *</Label>
                  <Input
                    id="total_deposit"
                    type="number"
                    {...register('total_deposit', { valueAsNumber: true })}
                    defaultValue={autoDeposit}
                  />
                  {errors.total_deposit && (
                    <p className="text-sm text-red-500">{errors.total_deposit.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="deposit_paid">Đã cọc trước (VND)</Label>
                  <Input
                    id="deposit_paid"
                    type="number"
                    {...register('deposit_paid', { valueAsNumber: true })}
                    defaultValue={totalDepositPaid}
                    disabled
                  />
                  <p className="text-xs text-gray-500">Tự động tính từ tiền cọc giữ chỗ</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="initial_electricity_reading">Chỉ số điện ban đầu</Label>
                  <Input
                    id="initial_electricity_reading"
                    type="number"
                    {...register('initial_electricity_reading', { valueAsNumber: true })}
                    placeholder="0"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="initial_water_reading">Chỉ số nước ban đầu</Label>
                  <Input
                    id="initial_water_reading"
                    type="number"
                    {...register('initial_water_reading', { valueAsNumber: true })}
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Ghi chú</Label>
                <Textarea
                  id="notes"
                  {...register('notes')}
                  placeholder="Ghi chú về hợp đồng..."
                  rows={3}
                />
              </div>
            </div>
          )}

          {/* Step 4: Select Services */}
          {step === 4 && (
            <div className="space-y-4">
              <div className="border rounded-md p-4 space-y-3 max-h-96 overflow-y-auto">
                {services?.map((service) => (
                  <div key={service.id} className="flex items-start space-x-3">
                    <Checkbox
                      id={service.id}
                      checked={selectedServices.has(service.id)}
                      onCheckedChange={(checked) => {
                        const newSet = new Set(selectedServices);
                        if (checked) {
                          newSet.add(service.id);
                        } else {
                          newSet.delete(service.id);
                        }
                        setSelectedServices(newSet);
                      }}
                    />
                    <div className="flex-1">
                      <label
                        htmlFor={service.id}
                        className="text-sm font-medium cursor-pointer"
                      >
                        {service.name}
                        {service.is_mandatory && (
                          <span className="text-red-500 ml-1">*</span>
                        )}
                      </label>
                      <p className="text-xs text-gray-500">
                        {service.unit_price?.toLocaleString('vi-VN')} VND
                        {service.unit && ` / ${service.unit}`}
                        {' • '}
                        {service.type === 'FIXED' && 'Cố định'}
                        {service.type === 'PER_PERSON' && 'Theo người'}
                        {service.type === 'PER_ROOM' && 'Theo phòng'}
                        {service.type === 'METER_READING' && 'Theo công tơ'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-xs text-gray-500">
                * Dịch vụ bắt buộc sẽ được tự động chọn
              </p>
            </div>
          )}

          <DialogFooter className="gap-2">
            {step > 1 && (
              <Button type="button" variant="outline" onClick={prevStep}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                Quay lại
              </Button>
            )}

            {step < 4 ? (
              <Button
                type="button"
                onClick={nextStep}
                disabled={
                  (step === 1 && !selectedTenantId) ||
                  (step === 2 && rentalType === 'room' && !selectedRoomId) ||
                  (step === 2 && rentalType === 'bed' && !selectedBedId)
                }
              >
                Tiếp theo
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={createContractMutation.isPending}
              >
                {createContractMutation.isPending ? 'Đang tạo...' : 'Tạo hợp đồng'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateContractDialog;
