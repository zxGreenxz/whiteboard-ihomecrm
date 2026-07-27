import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { vehicleSchema, type VehicleFormValues } from '@/lib/vehicleValidation';
import { useCreateVehicle, useUpdateVehicle } from '@/hooks/useVehicles';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useCustomers, useCustomer } from '@/hooks/useCustomers';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '@/components/ui/searchable-select';
import ImageUploadZone from '@/components/customers/ImageUploadZone';
import type { Vehicle } from '@/types/vehicle';

interface VehicleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle?: Vehicle;
}

const VEHICLE_TYPE_OPTIONS = [
  { value: 'MOTORBIKE', label: 'Xe máy' },
  { value: 'CAR', label: 'Ô tô' },
  { value: 'BICYCLE', label: 'Xe đạp' },
  { value: 'ELECTRIC_BIKE', label: 'Xe điện' },
  { value: 'OTHER', label: 'Khác' },
] as const;

export default function VehicleFormDialog({
  open,
  onOpenChange,
  vehicle,
}: VehicleFormDialogProps) {
  const isEditMode = !!vehicle;
  const createVehicle = useCreateVehicle();
  const updateVehicle = useUpdateVehicle();
  const { data: buildingsData = [] } = useBuildings();
  const buildings = Array.isArray(buildingsData) ? buildingsData : [];

  const form = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    defaultValues: {
      vehicle_type: 'MOTORBIKE',
      vehicle_name: '',
      color: '',
      license_plate: '',
      owner_name: '',
      ticket_number: '',
      building_id: undefined,
      room_id: undefined,
      customer_id: undefined,
      image_url: '',
    },
  });

  const selectedBuildingId = form.watch('building_id');
  const selectedRoomId = form.watch('room_id');
  const selectedCustomerId = form.watch('customer_id');
  const { data: roomsData = [] } = useRooms(selectedBuildingId);
  const rooms = Array.isArray(roomsData) ? roomsData : [];

  // Đã chọn toà/phòng ⇒ mặc định chỉ hiện khách đang ở đó (theo HĐ còn hiệu
  // lực). Cho phép tắt vì xe có thể đứng tên khách không nằm trong HĐ phòng đó.
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const locationFilterActive =
    !showAllCustomers && !!(selectedBuildingId || selectedRoomId);

  const { data: customersData, isFetching: isFetchingCustomers } = useCustomers(
    locationFilterActive
      ? { building_id: selectedBuildingId, room_id: selectedRoomId }
      : undefined,
    { page: 1, pageSize: 500 },
  );
  const customers = customersData?.data ?? [];

  // Khách đang chọn có thể nằm ngoài danh sách đã lọc (vd sửa xe cũ, hoặc khách
  // không có HĐ ở toà/phòng này) — nạp riêng để trigger vẫn hiện đúng tên.
  const selectedInList = customers.some((c) => c.id === selectedCustomerId);
  const { data: selectedCustomer } = useCustomer(
    selectedCustomerId && !selectedInList ? selectedCustomerId : '',
  );

  const customerOptions = useMemo(() => {
    const label = (c: { full_name: string | null; phone: string | null }) =>
      `${c.full_name || 'Không tên'}${c.phone ? ` (${c.phone})` : ''}`;
    const opts: SearchableSelectOption[] = [
      { value: '__none__', label: '-- Không chọn --' },
      ...customers.map((c) => ({ value: c.id, label: label(c), keywords: c.phone || '' })),
    ];
    if (selectedCustomer && !selectedInList) {
      opts.splice(1, 0, {
        value: selectedCustomer.id,
        label: label(selectedCustomer),
        keywords: selectedCustomer.phone || '',
      });
    }
    // Lọc theo toà/phòng mà không ra ai: dropdown chỉ còn "-- Không chọn --"
    // nên CommandEmpty không bật — phải tự nói lý do, kẻo tưởng lỗi mất data.
    if (locationFilterActive && customers.length === 0) {
      opts.push({
        value: '__empty__',
        label: isFetchingCustomers
          ? 'Đang tải...'
          : 'Không có khách trong toà/phòng này',
        disabled: true,
      });
    }
    return opts;
  }, [
    customers,
    selectedCustomer,
    selectedInList,
    locationFilterActive,
    isFetchingCustomers,
  ]);

  // Reset form when dialog opens/closes or vehicle changes
  useEffect(() => {
    if (open) {
      setShowAllCustomers(false);
      if (vehicle) {
        form.reset({
          vehicle_type: vehicle.vehicle_type,
          vehicle_name: vehicle.vehicle_name || '',
          color: vehicle.color || '',
          license_plate: vehicle.license_plate || '',
          owner_name: vehicle.owner_name || '',
          ticket_number: vehicle.ticket_number || '',
          building_id: vehicle.building_id || undefined,
          room_id: vehicle.room_id || undefined,
          customer_id: vehicle.customer_id || undefined,
          image_url: vehicle.image_url || '',
        });
      } else {
        form.reset({
          vehicle_type: 'MOTORBIKE',
          vehicle_name: '',
          color: '',
          license_plate: '',
          owner_name: '',
          ticket_number: '',
          building_id: undefined,
          room_id: undefined,
          customer_id: undefined,
          image_url: '',
        });
      }
    }
  }, [open, vehicle, form]);

  // Reset room when building changes
  useEffect(() => {
    if (!isEditMode || form.getValues('building_id') !== vehicle?.building_id) {
      form.setValue('room_id', undefined);
    }
  }, [selectedBuildingId]);

  const onSubmit = async (data: VehicleFormValues) => {
    try {
      const formData = data as import('@/types/vehicle').VehicleFormData;
      if (isEditMode && vehicle) {
        await updateVehicle.mutateAsync({ id: vehicle.id, data: formData });
      } else {
        await createVehicle.mutateAsync(formData);
      }
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save vehicle:', error);
    }
  };

  const isPending = createVehicle.isPending || updateVehicle.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Sửa phương tiện' : 'Thêm phương tiện'}</DialogTitle>
          <DialogDescription>
            {isEditMode ? 'Cập nhật thông tin phương tiện' : 'Đăng ký phương tiện mới'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Image upload */}
              <FormField
                control={form.control}
                name="image_url"
                render={({ field }) => (
                  <FormItem>
                    <ImageUploadZone
                      label="Ảnh phương tiện"
                      value={field.value}
                      onChange={field.onChange}
                      bucket="vehicle-images"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                {/* Vehicle type */}
                <FormField
                  control={form.control}
                  name="vehicle_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Loại phương tiện *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn loại PT" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {VEHICLE_TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Vehicle name */}
                <FormField
                  control={form.control}
                  name="vehicle_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên dòng xe *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="VD: Honda Wave, Toyota Vios..." />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Color */}
                <FormField
                  control={form.control}
                  name="color"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Màu xe *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="VD: Đen, Trắng, Đỏ..." />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* License plate */}
                <FormField
                  control={form.control}
                  name="license_plate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Biển số xe *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="VD: 30A-12345" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Owner name */}
                <FormField
                  control={form.control}
                  name="owner_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên chủ xe *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Tên chủ xe theo đăng ký" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Ticket number */}
                <FormField
                  control={form.control}
                  name="ticket_number"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số vé xe</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Số vé xe" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Building */}
                <FormField
                  control={form.control}
                  name="building_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Toà nhà</FormLabel>
                      <Select
                        onValueChange={(val) => field.onChange(val === '__none__' ? undefined : val)}
                        value={field.value || '__none__'}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn toà nhà" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">-- Không chọn --</SelectItem>
                          {buildings.map((b: any) => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Room (cascading by building) */}
                <FormField
                  control={form.control}
                  name="room_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phòng</FormLabel>
                      <Select
                        onValueChange={(val) => field.onChange(val === '__none__' ? undefined : val)}
                        value={field.value || '__none__'}
                        disabled={!selectedBuildingId}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={selectedBuildingId ? 'Chọn phòng' : 'Chọn toà nhà trước'} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">-- Không chọn --</SelectItem>
                          {rooms.map((r: any) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Customer */}
              <FormField
                control={form.control}
                name="customer_id"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between gap-2">
                      <FormLabel>Khách hàng</FormLabel>
                      {(selectedBuildingId || selectedRoomId) && (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => setShowAllCustomers((v) => !v)}
                        >
                          {locationFilterActive
                            ? `Đang lọc theo ${selectedRoomId ? 'phòng' : 'toà nhà'} — xem tất cả`
                            : 'Lọc theo toà/phòng đã chọn'}
                        </Button>
                      )}
                    </div>
                    <FormControl>
                      <SearchableSelect
                        value={field.value || '__none__'}
                        onValueChange={(val) =>
                          field.onChange(val === '__none__' ? undefined : val)
                        }
                        options={customerOptions}
                        placeholder="Chọn khách hàng"
                        searchPlaceholder="Gõ tên hoặc SĐT để tìm..."
                        emptyText={
                          isFetchingCustomers
                            ? 'Đang tải...'
                            : locationFilterActive
                              ? 'Không có khách trong toà/phòng này'
                              : 'Không tìm thấy khách hàng'
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                >
                  Huỷ
                </Button>
                <Button type="submit" disabled={isPending} className="bg-green-600 hover:bg-green-700">
                  {isPending
                    ? (isEditMode ? 'Đang cập nhật...' : 'Đang tạo...')
                    : (isEditMode ? 'Cập nhật' : 'Thêm phương tiện')}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
