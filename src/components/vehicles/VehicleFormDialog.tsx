import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { InlineSkeleton, LoadingState } from '@/components/loading/LoadingState';
import type { Vehicle } from '@/types/vehicle';
import { focusFirstError } from '@/lib/formErrors';
import { friendlyError } from '@/lib/friendlyError';

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

/**
 * Số khách nạp cho ô chọn "Khách hàng". Ô này lọc CLIENT-SIDE (SearchableSelect
 * dùng cmdk), nên khách không nằm trong tập nạp về thì gõ đúng tên cũng không
 * tìm ra.
 *
 * Trước đây là 500 và tổ chức thật đã có 520 khách chưa xoá: `.range(0, 499)`
 * bỏ IM LẶNG 20 người gần nhất — không lỗi, không cảnh báo, chỉ là người dùng
 * không tìm thấy khách vừa tạo rồi tưởng mình nhớ nhầm.
 *
 * 1000 là trần `max_rows` của PostgREST: xin hơn cũng không được trả thêm. Nên
 * con số này KHÔNG phải cách sửa triệt để, nó chỉ dời ngưỡng. Thứ thật sự sửa
 * là `customersTruncated` bên dưới: khi tập nạp về không còn đủ, ô chọn phải
 * NÓI RA thay vì cắt lặng lẽ. Đường đi tiếp là tìm kiếm phía server (cần
 * SearchableSelect báo được từ khoá đang gõ ra ngoài) — việc riêng, không gộp.
 */
const CUSTOMER_OPTIONS_PAGE_SIZE = 1000;

export default function VehicleFormDialog({
  open,
  onOpenChange,
  vehicle,
}: VehicleFormDialogProps) {
  const isEditMode = !!vehicle;
  const createVehicle = useCreateVehicle();
  const updateVehicle = useUpdateVehicle();
  const buildingsQuery=useBuildings({enabled:open});
  const { data: buildingsData = [] } = buildingsQuery;
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
  const roomsQuery=useRooms(selectedBuildingId);
  const { data: roomsData = [] } = roomsQuery;
  const rooms = Array.isArray(roomsData) ? roomsData : [];

  // Đã chọn toà/phòng ⇒ mặc định chỉ hiện khách đang ở đó (theo HĐ còn hiệu
  // lực). Cho phép tắt vì xe có thể đứng tên khách không nằm trong HĐ phòng đó.
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const locationFilterActive =
    !showAllCustomers && !!(selectedBuildingId || selectedRoomId);

  const customersQuery = useCustomers(
    locationFilterActive
      ? { building_id: selectedBuildingId, room_id: selectedRoomId }
      : undefined,
    { page: 1, pageSize: CUSTOMER_OPTIONS_PAGE_SIZE },
  );
  const {data:customersData,isFetching:isFetchingCustomers}=customersQuery;
  const customers = customersData?.data ?? [];
  // `count` là tổng số khách KHỚP, không phải số dòng đã tải về. Lệch nhau ⇒
  // trang đầu không chứa hết và ô chọn đang thiếu người. Xem hằng ở đầu file.
  const customersTotal = customersData?.count ?? 0;
  const customersTruncated = customersTotal > customers.length;

  // Khách đang chọn có thể nằm ngoài danh sách đã lọc (vd sửa xe cũ, hoặc khách
  // không có HĐ ở toà/phòng này) — nạp riêng để trigger vẫn hiện đúng tên.
  const selectedInList = customers.some((c) => c.id === selectedCustomerId);
  const selectedCustomerQuery = useCustomer(
    selectedCustomerId && !selectedInList ? selectedCustomerId : '',
  );

  const {data:selectedCustomer}=selectedCustomerQuery;
  const sourceError=buildingsQuery.isError || roomsQuery.isError || customersQuery.isError || (!!selectedCustomerId && !selectedInList && selectedCustomerQuery.isError);
  const sourcePending=buildingsQuery.isLoading || roomsQuery.isLoading || customersQuery.isLoading || (!!selectedCustomerId && !selectedInList && selectedCustomerQuery.isLoading);
  const [blocked,setBlocked]=useState(false);
  const busy=useRef(false);
  const draftKey=useRef<string>();
  const formRef=useRef<HTMLFormElement>(null);

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
          ? <InlineSkeleton label="danh sách khách" width="8rem" />
          : 'Không có khách trong toà/phòng này',
        disabled: true,
      });
    }
    // Danh sách bị cắt: nói ra. Im lặng ở đây nghĩa là người dùng gõ đúng tên
    // một khách CÓ THẬT mà không thấy gì, rồi kết luận sai là khách chưa được
    // tạo — và tạo thêm một bản trùng. `disabled` nên cmdk không cho chọn.
    if (customersTruncated) {
      opts.push({
        value: '__truncated__',
        label: `Chỉ hiện ${customers.length}/${customersTotal} khách — hãy lọc theo toà/phòng để thu hẹp`,
        disabled: true,
      });
    }
    return opts;
  }, [
    customers,
    customersTotal,
    customersTruncated,
    selectedCustomer,
    selectedInList,
    locationFilterActive,
    isFetchingCustomers,
  ]);

  // Reset form when dialog opens/closes or vehicle changes
  useEffect(() => {
    if (open) {
      const key=vehicle?.id ?? 'new';
      if(draftKey.current===key && (form.formState.isDirty || form.formState.errors.root?.server || blocked))return;
      if(draftKey.current!==key)setBlocked(false);
      draftKey.current=key;
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
    if (blocked || form.formState.errors.root?.server)return;
    if (!isEditMode || form.getValues('building_id') !== vehicle?.building_id) {
      form.setValue('room_id', undefined);
    }
  }, [selectedBuildingId]);

  const onSubmit = async (data: VehicleFormValues) => {
    if(busy.current || blocked || sourceError || sourcePending || createVehicle.isPending || updateVehicle.isPending)return;
    busy.current=true;
    form.clearErrors('root.server');
    try {
      const formData = data as import('@/types/vehicle').VehicleFormData;
      if (isEditMode && vehicle) {
        await updateVehicle.mutateAsync({ id: vehicle.id, data: formData });
      } else {
        await createVehicle.mutateAsync(formData);
      }
      draftKey.current=undefined;
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save vehicle:', error);
      form.setError('root.server', { type: 'server', message: recordWriteMessage(error,isEditMode?'cập nhật phương tiện':'thêm phương tiện') });
      setBlocked(recordWriteBlocked(error));
    } finally {busy.current=false;}
  };

  const isPending = createVehicle.isPending || updateVehicle.isPending;

  return (
    <Dialog open={open} onOpenChange={next=>{if(!busy.current && !isPending)onOpenChange(next);}}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Sửa phương tiện' : 'Thêm phương tiện'}</DialogTitle>
          <DialogDescription>
            {isEditMode ? 'Cập nhật thông tin phương tiện' : 'Đăng ký phương tiện mới'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form ref={formRef} onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors,{root:formRef.current}); })} className="space-y-4">
              {form.formState.errors.root?.server?.message && (
                <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>
              )}
              {/* Đang nạp nguồn: form vẫn khoá (fieldset bên dưới), chỉ báo cho trình đọc màn hình —
                  không in chữ đỏ "Đang tải…" (chủ chốt 02/10/2026). Lỗi thật giữ nguyên. */}
              {!sourceError && sourcePending && <LoadingState label="dữ liệu biểu mẫu" variant="none" />}
              {sourceError && <div role="alert" className="text-sm text-destructive">Chưa tải đủ tòa, phòng hoặc khách để lưu phương tiện.{sourceError && <Button type="button" variant="outline" onClick={()=>{void buildingsQuery.refetch();void roomsQuery.refetch();void customersQuery.refetch();if(selectedCustomerId && !selectedInList)void selectedCustomerQuery.refetch();}}>Tải lại dữ liệu</Button>}</div>}
              <fieldset disabled={isPending || blocked || sourceError || sourcePending} className="space-y-4">
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
                          // emptyText chỉ nhận chữ: lúc đang nạp để dấu trung tính, không in "Đang tải".
                          isFetchingCustomers
                            ? '…'
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

              </fieldset>
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
                <Button type="submit" disabled={isPending || blocked || sourceError || sourcePending} className="bg-green-600 hover:bg-green-700">
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
