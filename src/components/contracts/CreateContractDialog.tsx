import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
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
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { useServices } from '@/hooks/useServices';
import { useDeposits } from '@/hooks/useDeposits';
import { useDocumentTemplates } from '@/hooks/useDocumentTemplates';
import { Plus, Trash2, Upload } from 'lucide-react';
import { format } from 'date-fns';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';

interface CreateContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Helper to convert NaN/empty to undefined for optional numbers
const optionalNumber = z.preprocess((val) => {
  if (val === '' || val === undefined || val === null || Number.isNaN(val)) {
    return undefined;
  }
  return Number(val);
}, z.number().optional());

const contractSchema = z.object({
  // General Info
  building_id: z.string().optional(), // Helper for filtering rooms
  room_id: z.string().optional(),
  bed_id: z.string().optional(),
  rental_type: z.enum(['room', 'bed']),
  signed_date: z.string().min(1, 'Vui lòng chọn ngày ký'),
  start_date: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  end_date: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  contract_template_id: z.string().optional(),
  invoice_template_id: z.string().optional(),
  notes: z.string().optional(),

  // Customer
  tenant_id: z.string().min(1, 'Vui lòng chọn khách thuê'),

  // Rent & Deposit
  rent_price: z.number().min(0, 'Giá thuê phải >= 0'),
  payment_cycle: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']),
  start_billing_date: z.string().min(1, 'Vui lòng chọn ngày bắt đầu tính tiền'),
  total_deposit: z.number().min(0, 'Tiền cọc phải >= 0'),
  deposit_paid: optionalNumber,
  discount_months: optionalNumber,
  discount_amount_per_month: optionalNumber,

  // Services
  initial_electricity_reading: optionalNumber,
  initial_water_reading: optionalNumber,
  services: z.array(z.object({
    service_id: z.string(),
    unit_price: z.number(),
    initial_reading: z.number().optional(),
    quantity: z.number().optional(),
  })).optional(),

  // Attachments
  contract_file_url: z.string().optional(),
}).refine((data) => {
  return !!(data.room_id || data.bed_id);
}, {
  message: "Vui lòng chọn phòng hoặc giường",
  path: ["room_id"],
});

type ContractFormData = z.infer<typeof contractSchema>;

const CreateContractDialog = ({ open, onOpenChange }: CreateContractDialogProps) => {
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');
  const [rentalType, setRentalType] = useState<'room' | 'bed'>('room');
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [selectedBedId, setSelectedBedId] = useState<string>('');
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [contractFile, setContractFile] = useState<File | null>(null);

  const createContractMutation = useCreateContract();
  const { data: tenants } = useTenants();
  const { data: buildings } = useBuildings();
  const { data: allRooms } = useRooms(); // Load all rooms
  const { data: allBeds } = useBeds(); // Load all beds
  const { data: services } = useServices();
  const { data: deposits } = useDeposits({
    tenant_id: selectedTenantId,
    status: 'CONFIRMED',
  });
  const { data: contractTemplates } = useDocumentTemplates('CONTRACT_NEW');
  const { data: invoiceTemplates } = useDocumentTemplates('INVOICE');

  // Filter rooms and beds based on building selection and availability
  const availableRooms = allRooms?.filter(room =>
    (!selectedBuildingId || room.building_id === selectedBuildingId) &&
    room.status === 'AVAILABLE'
  );

  const availableBeds = allBeds?.filter(bed =>
    bed.status === 'AVAILABLE' &&
    (!selectedBuildingId || bed.room?.building_id === selectedBuildingId)
  );

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
      signed_date: format(new Date(), 'yyyy-MM-dd'),
      start_date: format(new Date(), 'yyyy-MM-dd'),
      start_billing_date: format(new Date(), 'yyyy-MM-dd'),
      end_date: format(new Date(new Date().setFullYear(new Date().getFullYear() + 1)), 'yyyy-MM-dd'),
      discount_months: 0,
      discount_amount_per_month: 0,
    },
  });

  const watchedValues = watch();

  // Auto-select mandatory services
  useEffect(() => {
    if (services) {
      const mandatoryServices = services.filter(s => s.is_mandatory).map(s => s.id);
      const newSet = new Set(selectedServices);
      mandatoryServices.forEach(id => newSet.add(id));
      if (newSet.size !== selectedServices.size) {
        setSelectedServices(newSet);
      }
    }
  }, [services]);

  const handleClose = () => {
    reset();
    setSelectedTenantId('');
    setSelectedBuildingId('');
    setSelectedRoomId('');
    setSelectedBedId('');
    setSelectedServices(new Set());
    setContractFile(null);
    onOpenChange(false);
  };

  const onSubmit = async (data: ContractFormData) => {
    console.log("Submitting contract data:", data);
    const servicesData = Array.from(selectedServices).map(serviceId => {
      const service = services?.find(s => s.id === serviceId);
      return {
        service_id: serviceId,
        unit_price: service?.unit_price || 0,
        initial_reading: service?.type === 'METER_READING' ?
          (service.name.toLowerCase().includes('điện') ? data.initial_electricity_reading :
            service.name.toLowerCase().includes('nước') ? data.initial_water_reading : 0)
          : undefined,
      };
    });

    // Handle discounts
    const discounts = [];
    if (data.discount_months && data.discount_amount_per_month) {
      for (let i = 1; i <= data.discount_months; i++) {
        discounts.push({
          month: i,
          amount: data.discount_amount_per_month,
          reason: 'Khuyến mãi hợp đồng mới'
        });
      }
    }

    // Handle file upload (mock for now as we don't have direct upload in useCreateContract yet, 
    // but we added contract_file_url to the type)
    let fileUrl = undefined;
    if (contractFile) {
      // In a real app, we would upload here. For now, we'll skip or simulate.
      // We can't easily upload without a proper hook exposed.
      // We'll just log it.
      console.log('File to upload:', contractFile);
    }

    // Remove helper fields that are not in DB schema
    // building_id: helper for filtering rooms
    // rental_type: UI helper (room/bed)
    // discount_months, discount_amount_per_month: converted to discounts array above
    // start_billing_date: not yet in DB schema
    const {
      building_id,
      rental_type,
      discount_months,
      discount_amount_per_month,
      start_billing_date,
      ...contractData
    } = data;

    createContractMutation.mutate(
      {
        ...contractData,
        services: servicesData,
        discounts,
        contract_file_url: fileUrl,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      }
    );
  };

  // Auto-fill deposit paid from deposits table
  const totalDepositPaid = deposits?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;

  // Auto-fill rent price from selected room/bed
  const selectedRoom = availableRooms?.find(r => r.id === selectedRoomId);
  const selectedBed = availableBeds?.find(b => b.id === selectedBedId);
  const autoRentPrice = rentalType === 'room' ? selectedRoom?.rent_price : selectedBed?.rent_price;
  const autoDeposit = rentalType === 'room' ? selectedRoom?.deposit_amount : selectedBed?.deposit_amount;

  // Update form values when room/bed changes
  useEffect(() => {
    if (autoRentPrice !== undefined) setValue('rent_price', autoRentPrice);
    if (autoDeposit !== undefined) setValue('total_deposit', autoDeposit);
  }, [autoRentPrice, autoDeposit, setValue]);

  useEffect(() => {
    if (totalDepositPaid > 0) setValue('deposit_paid', totalDepositPaid);
  }, [totalDepositPaid, setValue]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="p-6 pb-2">
          <DialogTitle className="text-xl text-green-700 uppercase">Hợp đồng</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit, (errors) => { console.log("Form validation errors:", errors); })} className="space-y-6 p-6 pt-2">

          {/* 1. THÔNG TIN CHUNG */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900">1. THÔNG TIN CHUNG</h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Tòa nhà *</Label>
                <Select
                  value={selectedBuildingId}
                  onValueChange={(value) => {
                    setSelectedBuildingId(value);
                    setValue('building_id', value);
                    // Reset room/bed selection when building changes
                    setSelectedRoomId('');
                    setSelectedBedId('');
                    setValue('room_id', undefined);
                    setValue('bed_id', undefined);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn tòa nhà..." />
                  </SelectTrigger>
                  <SelectContent>
                    {buildings?.map((building) => (
                      <SelectItem key={building.id} value={building.id}>
                        {building.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Phòng *</Label>
                <Select
                  value={selectedRoomId}
                  onValueChange={(value) => {
                    setSelectedRoomId(value);
                    setValue('room_id', value);
                    setValue('bed_id', undefined);
                    setSelectedBedId('');
                    setRentalType('room');
                    setValue('rental_type', 'room');
                    // Auto-set building from room
                    const room = availableRooms?.find(r => r.id === value);
                    if (room && !selectedBuildingId) {
                      setSelectedBuildingId(room.building_id);
                      setValue('building_id', room.building_id);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn phòng..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRooms?.map((room) => (
                      <SelectItem key={room.id} value={room.id}>
                        {room.building?.name} - {room.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Giường</Label>
                <Select
                  value={selectedBedId}
                  onValueChange={(value) => {
                    setSelectedBedId(value);
                    setValue('bed_id', value);
                    setValue('room_id', undefined);
                    setSelectedRoomId('');
                    setRentalType('bed');
                    // Auto-set building from bed
                    const bed = availableBeds?.find(b => b.id === value);
                    if (bed?.room) {
                      setSelectedBuildingId(bed.room.building_id);
                      setValue('building_id', bed.room.building_id);
                    }
                  }}
                  disabled={!!selectedRoomId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn giường..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBeds?.map((bed) => (
                      <SelectItem key={bed.id} value={bed.id}>
                        {bed.room?.building?.name} - {bed.room?.name} - {bed.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Ngày ký *</Label>
                <Input type="date" {...register('signed_date')} />
                {errors.signed_date && <p className="text-xs text-red-500">{errors.signed_date.message}</p>}
              </div>

              <div className="space-y-2">
                <Label>Ngày bắt đầu *</Label>
                <Input type="date" {...register('start_date')} />
                {errors.start_date && <p className="text-xs text-red-500">{errors.start_date.message}</p>}
              </div>

              <div className="space-y-2">
                <Label>Hạn hợp đồng *</Label>
                <Input type="date" {...register('end_date')} />
                {errors.end_date && <p className="text-xs text-red-500">{errors.end_date.message}</p>}
              </div>

              <div className="space-y-2">
                <Label>Mẫu hợp đồng thuê</Label>
                <Select onValueChange={(val) => setValue('contract_template_id', val)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn mẫu..." />
                  </SelectTrigger>
                  <SelectContent>
                    {contractTemplates?.map(t => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Mẫu in hóa đơn</Label>
                <Select onValueChange={(val) => setValue('invoice_template_id', val)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn mẫu..." />
                  </SelectTrigger>
                  <SelectContent>
                    {invoiceTemplates?.map(t => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Ghi chú</Label>
              <Textarea {...register('notes')} placeholder="Khuyến mãi, mã đề xuất, lưu ý" />
            </div>
          </div>

          <Separator />

          {/* 2. KHÁCH HÀNG */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-medium text-gray-900">2. KHÁCH HÀNG</h3>
              <Button type="button" size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => {
                // Focus on tenant select or show toast
                const select = document.getElementById('tenant-select-trigger');
                if (select) select.click();
                else toast.info('Vui lòng chọn khách hàng từ danh sách bên dưới');
              }}>
                <Plus className="h-4 w-4 mr-1" />
                Thêm khách hàng
              </Button>
            </div>

            <div className="border rounded-md">
              <div className="grid grid-cols-12 gap-4 p-3 bg-gray-50 border-b text-sm font-medium text-gray-500">
                <div className="col-span-1">Thao tác</div>
                <div className="col-span-4">Khách hàng</div>
                <div className="col-span-3">Ngày vào</div>
                <div className="col-span-4">Đại diện</div>
              </div>

              {selectedTenantId ? (
                <div className="grid grid-cols-12 gap-4 p-3 items-center text-sm">
                  <div className="col-span-1">
                    <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-red-500" onClick={() => {
                      setSelectedTenantId('');
                      setValue('tenant_id', '');
                    }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="col-span-4 font-medium">
                    {tenants?.find(t => t.id === selectedTenantId)?.full_name}
                  </div>
                  <div className="col-span-3">
                    {watchedValues.start_date}
                  </div>
                  <div className="col-span-4">
                    <Checkbox checked disabled />
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500 text-sm">
                  Danh sách trống
                </div>
              )}
            </div>

            {!selectedTenantId && (
              <div className="max-w-md">
                <Label>Chọn khách thuê từ danh sách *</Label>
                <Select
                  value={selectedTenantId}
                  onValueChange={(value) => {
                    setSelectedTenantId(value);
                    setValue('tenant_id', value);
                  }}
                >
                  <SelectTrigger id="tenant-select-trigger">
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
                {errors.tenant_id && <p className="text-xs text-red-500 mt-1">{errors.tenant_id.message}</p>}
              </div>
            )}
          </div>

          <Separator />

          {/* 3. TIỀN THUÊ & TIỀN CỌC */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900">3. TIỀN THUÊ & TIỀN CỌC</h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Tiền thuê *</Label>
                <Input type="number" {...register('rent_price', { valueAsNumber: true })} />
              </div>
              <div className="space-y-2">
                <Label>Chu kỳ thanh toán *</Label>
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
              <div className="space-y-2">
                <Label>Ngày bắt đầu tính tiền *</Label>
                <Input type="date" {...register('start_billing_date')} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Tiền cọc *</Label>
                <Input type="number" {...register('total_deposit', { valueAsNumber: true })} />
              </div>
              <div className="space-y-2">
                <Label>Đã đặt cọc</Label>
                <Input type="number" {...register('deposit_paid', { valueAsNumber: true })} disabled />
              </div>
              <div className="space-y-2">
                <Label>Tiền cọc phải đóng</Label>
                <Input
                  value={(watchedValues.total_deposit || 0) - (watchedValues.deposit_paid || 0)}
                  disabled
                  className="bg-gray-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Số tháng giảm</Label>
                <Input type="number" {...register('discount_months', { valueAsNumber: true })} />
              </div>
              <div className="space-y-2">
                <Label>Số tiền giảm mỗi tháng</Label>
                <Input type="number" {...register('discount_amount_per_month', { valueAsNumber: true })} />
              </div>
            </div>
          </div>

          <Separator />

          {/* 4. TIỀN PHÍ DỊCH VỤ */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-medium text-gray-900">4. TIỀN PHÍ DỊCH VỤ</h3>
              <Button type="button" size="sm" className="bg-green-600 hover:bg-green-700">
                <Plus className="h-4 w-4 mr-1" />
                Thêm dịch vụ
              </Button>
            </div>

            <div className="border rounded-md overflow-hidden">
              <div className="grid grid-cols-12 gap-2 p-3 bg-gray-50 border-b text-sm font-medium text-gray-500">
                <div className="col-span-1">Thao tác</div>
                <div className="col-span-3">Dịch vụ</div>
                <div className="col-span-2">Công tơ</div>
                <div className="col-span-2">Chỉ số đầu</div>
                <div className="col-span-2">Số lượng</div>
                <div className="col-span-2">Ngày tính phí</div>
              </div>

              <div className="max-h-60 overflow-y-auto p-2 space-y-2">
                {services?.map((service) => (
                  <div key={service.id} className="grid grid-cols-12 gap-2 items-center text-sm">
                    <div className="col-span-1">
                      <Checkbox
                        checked={selectedServices.has(service.id)}
                        onCheckedChange={(checked) => {
                          const newSet = new Set(selectedServices);
                          if (checked) newSet.add(service.id);
                          else newSet.delete(service.id);
                          setSelectedServices(newSet);
                        }}
                      />
                    </div>
                    <div className="col-span-3 font-medium">{service.name}</div>
                    <div className="col-span-2 text-xs text-gray-500">{service.type === 'METER_READING' ? 'Có' : 'Không'}</div>
                    <div className="col-span-2">
                      {service.type === 'METER_READING' && selectedServices.has(service.id) && (
                        <Input
                          type="number"
                          className="h-8 text-xs"
                          placeholder="0"
                          {...register(
                            service.name.toLowerCase().includes('điện') ? 'initial_electricity_reading' : 'initial_water_reading',
                            { valueAsNumber: true }
                          )}
                        />
                      )}
                    </div>
                    <div className="col-span-2">
                      <Input type="number" className="h-8 text-xs" defaultValue={1} disabled={service.type === 'METER_READING'} />
                    </div>
                    <div className="col-span-2 text-xs">
                      {watchedValues.start_billing_date}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Separator />

          {/* 5. ĐÍNH KÈM HỢP ĐỒNG */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900">5. ĐÍNH KÈM HỢP ĐỒNG</h3>
            <div className="space-y-2">
              <Label>Tệp đính kèm</Label>
              <div className="relative border-2 border-dashed rounded-md p-6 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-gray-50 transition-colors">
                <Upload className="h-8 w-8 text-gray-400 mb-2" />
                <p className="text-sm text-gray-600">Kéo thả file hoặc click để chọn</p>
                <Input
                  type="file"
                  className="hidden"
                  id="file-upload"
                  onChange={(e) => setContractFile(e.target.files?.[0] || null)}
                />
                <label htmlFor="file-upload" className="absolute inset-0 cursor-pointer"></label>
                {contractFile && (
                  <p className="text-sm font-medium text-green-600 mt-2">{contractFile.name}</p>
                )}
              </div>
            </div>
          </div>

          <Separator />

          {/* 6. BÀN GIAO TÀI SẢN */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900">6. BÀN GIAO TÀI SẢN</h3>
            <div className="border rounded-md p-8 text-center text-gray-500 text-sm">
              Không có dữ liệu
            </div>
          </div>

          <DialogFooter className="gap-2 pt-4">
            <Button type="button" variant="outline" onClick={handleClose}>
              Hủy
            </Button>
            <Button type="submit" className="bg-green-600 hover:bg-green-700" disabled={createContractMutation.isPending}>
              {createContractMutation.isPending ? 'Đang lưu...' : 'Lưu'}
            </Button>
          </DialogFooter>
        </form >
      </DialogContent >
    </Dialog >
  );
};

export default CreateContractDialog;
