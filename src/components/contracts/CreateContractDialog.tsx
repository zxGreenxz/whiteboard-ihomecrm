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
import { Checkbox } from '@/components/ui/checkbox';
import { useCreateContract, useUploadContractFile } from '@/hooks/useContracts';
import { useTenantsLegacy } from '@/hooks/useTenants';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useServices } from '@/hooks/useServices';
import { useDeposits } from '@/hooks/useDeposits';
import { useDocumentTemplates } from '@/hooks/useDocumentTemplates';
import { useAssets, useCreateAssetHandover } from '@/hooks/useAssets';
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
  rental_type: z.enum(['room']).default('room'),
  signed_date: z.string().min(1, 'Vui lòng chọn ngày ký'),
  start_date: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  end_date: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  contract_template_id: z.string().optional(),
  invoice_template_id: z.string().optional(),
  notes: z.string().optional(),

  // Customer - representative tenant (đại diện)
  tenant_id: z.string().min(1, 'Vui lòng chọn khách hàng'),

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
  return !!data.room_id;
}, {
  message: "Vui lòng chọn căn hộ",
  path: ["room_id"],
});

interface SelectedTenant {
  tenant_id: string;
  is_representative: boolean;
}

type ContractFormData = z.infer<typeof contractSchema>;

const CreateContractDialog = ({ open, onOpenChange }: CreateContractDialogProps) => {
  const [selectedTenants, setSelectedTenants] = useState<SelectedTenant[]>([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [showTenantSelect, setShowTenantSelect] = useState(false);
  const [selectedAssets, setSelectedAssets] = useState<Array<{
    asset_id: string;
    asset_name: string;
    quantity: number;
    condition: string;
    notes: string;
  }>>([]);

  const createContractMutation = useCreateContract();
  const createAssetHandoverMutation = useCreateAssetHandover();
  const uploadFileMutation = useUploadContractFile();
  const { data: tenants } = useTenantsLegacy();
  const { data: buildings } = useBuildings();
  const { data: allRooms } = useRooms(); // Load all rooms
  const { data: services } = useServices();
  const representativeTenantId = selectedTenants.find(t => t.is_representative)?.tenant_id || '';
  const { data: deposits } = useDeposits({
    tenant_id: representativeTenantId,
    status: 'CONFIRMED',
  });
  const { data: contractTemplates } = useDocumentTemplates('CONTRACT_NEW');
  const { data: invoiceTemplates } = useDocumentTemplates('INVOICE');

  const { data: assets } = useAssets({
    room_id: selectedRoomId || undefined,
  });

  // Filter rooms based on building selection and availability
  const availableRooms = allRooms?.filter(room =>
    (!selectedBuildingId || room.building_id === selectedBuildingId) &&
    room.status === 'AVAILABLE'
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
    setSelectedTenants([]);
    setSelectedBuildingId('');
    setSelectedRoomId('');
    setSelectedServices(new Set());
    setContractFile(null);
    setSelectedAssets([]);
    setShowTenantSelect(false);
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

    // Handle file upload
    let fileUrl = undefined;
    if (contractFile) {
      try {
        setIsUploadingFile(true);
        const uploadResult = await uploadFileMutation.mutateAsync({
          file: contractFile,
        });
        fileUrl = uploadResult.url;
        setIsUploadingFile(false);
      } catch (error) {
        setIsUploadingFile(false);
        toast.error('Có lỗi xảy ra khi tải file lên. Hợp đồng sẽ được tạo không có file đính kèm.');
        // Continue without file
      }
    }

    // Remove helper fields that are not in DB schema
    // building_id: helper for filtering rooms
    // rental_type: UI helper (luôn = 'room')
    // discount_months, discount_amount_per_month: converted to discounts array above
    const {
      building_id,
      rental_type,
      discount_months,
      discount_amount_per_month,
      ...contractData
    } = data;

    // Build tenants data for junction table
    const tenantsData = selectedTenants.map(t => ({
      tenant_id: t.tenant_id,
      is_representative: t.is_representative,
      move_in_date: data.start_date,
    }));

    createContractMutation.mutate(
      {
        ...contractData,
        services: servicesData,
        discounts,
        contract_file_url: fileUrl,
        tenants: tenantsData,
      },
      {
        onSuccess: (contract) => {
          // Create asset handover if there are selected assets
          if (selectedAssets.length > 0) {
            const handoverItems = selectedAssets.map(asset => ({
              asset_id: asset.asset_id,
              quantity: asset.quantity,
              condition: asset.condition,
              notes: asset.notes,
            }));

            createAssetHandoverMutation.mutate({
              contract_id: contract.id,
              type: 'CHECK_IN',
              handover_date: data.start_date,
              items: handoverItems as any, // JSONB type
              notes: 'Biên bản bàn giao tài sản khi vào ở',
            }, {
              onSuccess: () => {
                handleClose();
              },
              onError: () => {
                // Contract created but handover failed - still close dialog
                toast.warning('Hợp đồng đã tạo nhưng biên bản bàn giao thất bại. Vui lòng tạo lại biên bản.');
                handleClose();
              }
            });
          } else {
            handleClose();
          }
        },
      }
    );
  };

  // Auto-fill deposit paid from deposits table
  const totalDepositPaid = deposits?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;

  // Auto-fill rent price from selected room
  const selectedRoom = availableRooms?.find(r => r.id === selectedRoomId);
  const autoRentPrice = selectedRoom?.rent_price;
  const autoDeposit = selectedRoom?.deposit_amount;

  // Update form values when room changes
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

        <form
          onSubmit={handleSubmit(onSubmit, (errors) => { console.log("Form validation errors:", errors); })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const target = e.target as HTMLElement;
            const tag = target.tagName;
            if (tag === 'TEXTAREA') return;
            if (tag === 'BUTTON' && (target as HTMLButtonElement).type === 'submit') return;
            e.preventDefault();
          }}
          className="space-y-6 p-6 pt-2"
        >

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
                    setSelectedRoomId('');
                    setValue('room_id', undefined);
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
                <Label>Căn hộ *</Label>
                <Select
                  value={selectedRoomId}
                  onValueChange={(value) => {
                    setSelectedRoomId(value);
                    setValue('room_id', value);
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
                    <SelectValue placeholder="Chọn căn hộ..." />
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
                <Label>Ngày ký *</Label>
                <DateInput
                  value={watch('signed_date') || ''}
                  onChange={(v) => setValue('signed_date', v, { shouldValidate: true, shouldDirty: true })}
                />
                {errors.signed_date && <p className="text-xs text-red-500">{errors.signed_date.message}</p>}
              </div>

              <div className="space-y-2">
                <Label>Ngày bắt đầu *</Label>
                <DateInput
                  value={watch('start_date') || ''}
                  onChange={(v) => setValue('start_date', v, { shouldValidate: true, shouldDirty: true })}
                />
                {errors.start_date && <p className="text-xs text-red-500">{errors.start_date.message}</p>}
              </div>

              <div className="space-y-2">
                <Label>Hạn hợp đồng *</Label>
                <DateInput
                  value={watch('end_date') || ''}
                  onChange={(v) => setValue('end_date', v, { shouldValidate: true, shouldDirty: true })}
                />
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
                setShowTenantSelect(true);
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

              {selectedTenants.length > 0 ? (
                selectedTenants.map((st) => {
                  const tenantInfo = tenants?.find(t => t.id === st.tenant_id);
                  return (
                    <div key={st.tenant_id} className="grid grid-cols-12 gap-4 p-3 items-center text-sm border-b last:border-b-0">
                      <div className="col-span-1">
                        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-red-500" onClick={() => {
                          const updated = selectedTenants.filter(t => t.tenant_id !== st.tenant_id);
                          // If we removed the representative, make the first remaining tenant the representative
                          if (st.is_representative && updated.length > 0) {
                            updated[0].is_representative = true;
                          }
                          setSelectedTenants(updated);
                          // Update form tenant_id to the representative
                          const newRep = updated.find(t => t.is_representative);
                          setValue('tenant_id', newRep?.tenant_id || '');
                        }}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="col-span-4">
                        <div className="font-medium">{tenantInfo?.full_name}</div>
                        <div className="text-xs text-gray-500">{tenantInfo?.phone}</div>
                      </div>
                      <div className="col-span-3">
                        {watchedValues.start_date}
                      </div>
                      <div className="col-span-4">
                        <Checkbox
                          checked={st.is_representative}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              // Set this tenant as representative, unset others
                              const updated = selectedTenants.map(t => ({
                                ...t,
                                is_representative: t.tenant_id === st.tenant_id,
                              }));
                              setSelectedTenants(updated);
                              setValue('tenant_id', st.tenant_id);
                            }
                          }}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="p-8 text-center text-gray-500 text-sm">
                  Danh sách trống
                </div>
              )}
            </div>

            {(showTenantSelect || selectedTenants.length === 0) && (
              <div className="max-w-md">
                <Label>Chọn khách hàng từ danh sách *</Label>
                <Select
                  value=""
                  onValueChange={(value) => {
                    // Check if tenant is already selected
                    if (selectedTenants.some(t => t.tenant_id === value)) {
                      toast.error('Khách hàng này đã được thêm');
                      return;
                    }
                    const isFirst = selectedTenants.length === 0;
                    const newTenant: SelectedTenant = {
                      tenant_id: value,
                      is_representative: isFirst, // First tenant is representative by default
                    };
                    const updated = [...selectedTenants, newTenant];
                    setSelectedTenants(updated);
                    // Set form tenant_id to the representative
                    if (isFirst) {
                      setValue('tenant_id', value);
                    }
                    setShowTenantSelect(false);
                  }}
                >
                  <SelectTrigger id="tenant-select-trigger">
                    <SelectValue placeholder="Chọn khách hàng..." />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants
                      ?.filter(tenant => !selectedTenants.some(st => st.tenant_id === tenant.id))
                      .map((tenant) => (
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
                <CurrencyInput
                  value={watch('rent_price')}
                  onChange={(v) => setValue('rent_price', v, { shouldValidate: true, shouldDirty: true })}
                />
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
                <DateInput
                  value={watch('start_billing_date') || ''}
                  onChange={(v) => setValue('start_billing_date', v, { shouldValidate: true, shouldDirty: true })}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Tiền cọc *</Label>
                <CurrencyInput
                  value={watch('total_deposit')}
                  onChange={(v) => setValue('total_deposit', v, { shouldValidate: true, shouldDirty: true })}
                />
              </div>
              <div className="space-y-2">
                <Label>Đã đặt cọc</Label>
                <CurrencyInput
                  value={watch('deposit_paid')}
                  onChange={(v) => setValue('deposit_paid', v, { shouldValidate: true, shouldDirty: true })}
                  disabled
                />
              </div>
              <div className="space-y-2">
                <Label>Tiền cọc phải đóng</Label>
                <CurrencyInput
                  value={(watchedValues.total_deposit || 0) - (watchedValues.deposit_paid || 0)}
                  readOnly
                  className="bg-gray-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Số tháng giảm</Label>
                <NumberInput
                  value={watch('discount_months')}
                  onChange={(v) => setValue('discount_months', v, { shouldValidate: true, shouldDirty: true })}
                />
              </div>
              <div className="space-y-2">
                <Label>Số tiền giảm mỗi tháng</Label>
                <CurrencyInput
                  value={watch('discount_amount_per_month')}
                  onChange={(v) => setValue('discount_amount_per_month', v, { shouldValidate: true, shouldDirty: true })}
                />
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
                        <NumberInput
                          allowDecimal
                          className="h-8 text-xs"
                          placeholder="0"
                          value={
                            service.name.toLowerCase().includes('điện')
                              ? watch('initial_electricity_reading')
                              : watch('initial_water_reading')
                          }
                          onChange={(v) =>
                            setValue(
                              service.name.toLowerCase().includes('điện')
                                ? 'initial_electricity_reading'
                                : 'initial_water_reading',
                              v,
                              { shouldValidate: true, shouldDirty: true }
                            )
                          }
                        />
                      )}
                    </div>
                    <div className="col-span-2">
                      <NumberInput className="h-8 text-xs" value={1} disabled={service.type === 'METER_READING'} />
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
            <div className="flex justify-between items-center">
              <h3 className="font-medium text-gray-900">6. BÀN GIAO TÀI SẢN</h3>
              <Button
                type="button"
                size="sm"
                className="bg-green-600 hover:bg-green-700"
                onClick={() => {
                  if (!assets || assets.length === 0) {
                    toast.info('Không có tài sản nào trong căn hộ này. Vui lòng thêm tài sản trước.');
                    return;
                  }
                  // Add empty row - user will select asset from dropdown
                  const firstAvailableAsset = assets[0];
                  setSelectedAssets([...selectedAssets, {
                    asset_id: firstAvailableAsset.id,
                    asset_name: firstAvailableAsset.name,
                    quantity: 1,
                    condition: 'GOOD',
                    notes: ''
                  }]);
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                Thêm tài sản
              </Button>
            </div>

            <div className="border rounded-md overflow-hidden">
              <div className="grid grid-cols-12 gap-2 p-3 bg-gray-50 border-b text-sm font-medium text-gray-500">
                <div className="col-span-1">Thao tác</div>
                <div className="col-span-4">Tài sản</div>
                <div className="col-span-2">Số lượng</div>
                <div className="col-span-2">Tình trạng</div>
                <div className="col-span-3">Ghi chú</div>
              </div>

              <div className="max-h-60 overflow-y-auto p-2 space-y-2">
                {selectedAssets.length === 0 ? (
                  <div className="p-8 text-center text-gray-500 text-sm">
                    Chưa có tài sản nào được thêm
                  </div>
                ) : (
                  selectedAssets.map((asset, index) => (
                    <div key={asset.asset_id} className="grid grid-cols-12 gap-2 items-center text-sm">
                      <div className="col-span-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-red-500"
                          onClick={() => {
                            setSelectedAssets(selectedAssets.filter((_, i) => i !== index));
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="col-span-4">
                        <Select
                          value={asset.asset_id}
                          onValueChange={(value) => {
                            const newAsset = assets?.find(a => a.id === value);
                            if (newAsset) {
                              const updated = [...selectedAssets];
                              updated[index] = {
                                ...updated[index],
                                asset_id: value,
                                asset_name: newAsset.name
                              };
                              setSelectedAssets(updated);
                            }
                          }}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {assets?.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name} {a.code ? `(${a.code})` : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-2">
                        <NumberInput
                          className="h-8"
                          min={1}
                          value={asset.quantity}
                          onChange={(v) => {
                            const updated = [...selectedAssets];
                            updated[index].quantity = v || 1;
                            setSelectedAssets(updated);
                          }}
                        />
                      </div>
                      <div className="col-span-2">
                        <Select
                          value={asset.condition}
                          onValueChange={(value) => {
                            const updated = [...selectedAssets];
                            updated[index].condition = value;
                            setSelectedAssets(updated);
                          }}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="NEW">Mới</SelectItem>
                            <SelectItem value="GOOD">Tốt</SelectItem>
                            <SelectItem value="FAIR">Khá</SelectItem>
                            <SelectItem value="POOR">Kém</SelectItem>
                            <SelectItem value="BROKEN">Hư hỏng</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-3">
                        <Input
                          className="h-8"
                          placeholder="Ghi chú..."
                          value={asset.notes}
                          onChange={(e) => {
                            const updated = [...selectedAssets];
                            updated[index].notes = e.target.value;
                            setSelectedAssets(updated);
                          }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 pt-4">
            <Button type="button" variant="outline" onClick={handleClose}>
              Hủy
            </Button>
            <Button
              type="submit"
              className="bg-green-600 hover:bg-green-700"
              disabled={createContractMutation.isPending || isUploadingFile}
            >
              {isUploadingFile ? 'Đang upload file...' : createContractMutation.isPending ? 'Đang lưu...' : 'Lưu'}
            </Button>
          </DialogFooter>
        </form >
      </DialogContent >
    </Dialog >
  );
};

export default CreateContractDialog;
