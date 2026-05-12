import { useEffect, useState, useMemo } from 'react';
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
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { roomSchema, type RoomFormData } from '@/lib/roomValidation';
import { useBuildings } from '@/hooks/useBuildings';
import { useFloors } from '@/hooks/useFloors';
import { useCreateRoom, useUpdateRoom } from '@/hooks/useRooms';
import { useDocumentTemplatesByType } from '@/hooks/useDocumentTemplates';
import QuickCreateBuildingDialog from './QuickCreateBuildingDialog';
import QuickCreateFloorDialog from './QuickCreateFloorDialog';
import type { RoomWithRelations } from '@/types/room';
import type { BuildingWithRelations } from '@/types/building';
import type { Building } from '@/types/building';

interface RoomFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room?: RoomWithRelations;
  preselectedBuildingId?: string;
}

const QUICK_CREATE_BUILDING = '__quick_create_building__';
const QUICK_CREATE_FLOOR = '__quick_create_floor__';

export default function RoomFormDialog({
  open,
  onOpenChange,
  room,
  preselectedBuildingId,
}: RoomFormDialogProps) {
  const isEditMode = !!room;

  // Quick-create dialog states
  const [quickBuildingOpen, setQuickBuildingOpen] = useState(false);
  const [quickFloorOpen, setQuickFloorOpen] = useState(false);

  // Hooks
  const createRoom = useCreateRoom();
  const updateRoom = useUpdateRoom();
  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () =>
      (Array.isArray(buildingsData) ? buildingsData : []).filter(
        (b: any) => b.status === 'ACTIVE'
      ) as BuildingWithRelations[],
    [buildingsData]
  );

  const { data: invoiceTemplates = [] } = useDocumentTemplatesByType('invoice');
  const { data: leaseTemplates = [] } = useDocumentTemplatesByType('lease_contract');

  // Form
  const form = useForm<RoomFormData>({
    resolver: zodResolver(roomSchema),
    defaultValues: {
      building_id: '',
      floor: 0,
      name: '',
      rent_price: 0,
      deposit_amount: 0,
      area: null,
      max_occupants: null,
      status: 'AVAILABLE',
      invoice_template_id: null,
      lease_template_id: null,
    },
  });

  const selectedBuildingId = form.watch('building_id');

  // Floors cascading by building
  const { data: floorsData } = useFloors(selectedBuildingId || undefined);
  const floors = useMemo(
    () => (Array.isArray(floorsData) ? floorsData : []),
    [floorsData]
  );

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (room) {
        form.reset({
          building_id: room.building_id,
          floor: room.floor,
          name: room.name,
          rent_price: room.rent_price,
          deposit_amount: room.deposit_amount,
          area: room.area ?? null,
          max_occupants: room.max_occupants ?? null,
          status: room.status,
          invoice_template_id: room.invoice_template_id ?? null,
          lease_template_id: room.lease_template_id ?? null,
        });
      } else {
        form.reset({
          building_id: preselectedBuildingId || '',
          floor: 0,
          name: '',
          rent_price: 0,
          deposit_amount: 0,
          area: null,
          max_occupants: null,
          status: 'AVAILABLE',
          invoice_template_id: null,
          lease_template_id: null,
        });
      }
    }
  }, [open, room, preselectedBuildingId, form]);

  // Reset floor when building changes (only in create mode or when building actually changes)
  useEffect(() => {
    if (!isEditMode || form.getValues('building_id') !== room?.building_id) {
      form.setValue('floor', 0);
    }
  }, [selectedBuildingId]);

  const onSubmit = async (data: RoomFormData) => {
    try {
      if (isEditMode && room) {
        await updateRoom.mutateAsync({
          id: room.id,
          updates: {
            building_id: data.building_id,
            floor: data.floor,
            name: data.name,
            rent_price: data.rent_price,
            deposit_amount: data.deposit_amount,
            area: data.area ?? null,
            max_occupants: data.max_occupants ?? null,
            status: data.status,
            invoice_template_id: data.invoice_template_id ?? null,
            lease_template_id: data.lease_template_id ?? null,
          } as any,
        });
        toast.success('Dữ liệu đã được CẬP NHẬT thành công');
      } else {
        await createRoom.mutateAsync({
          building_id: data.building_id,
          floor: data.floor,
          name: data.name,
          rent_price: data.rent_price,
          deposit_amount: data.deposit_amount,
          area: data.area ?? null,
          max_occupants: data.max_occupants ?? null,
          status: data.status,
          invoice_template_id: data.invoice_template_id ?? null,
          lease_template_id: data.lease_template_id ?? null,
        } as any);
        toast.success('Dữ liệu đã được TẠO thành công');
      }
      onOpenChange(false);
    } catch (error: any) {
      if (error?.code === '23505') {
        toast.error('Tên phòng đã tồn tại trong toà nhà này');
      }
      // Other errors handled by hook toasts
    }
  };

  const handleBuildingChange = (value: string) => {
    if (value === QUICK_CREATE_BUILDING) {
      setQuickBuildingOpen(true);
      return;
    }
    form.setValue('building_id', value, { shouldValidate: true });
  };

  const handleFloorChange = (value: string) => {
    if (value === QUICK_CREATE_FLOOR) {
      if (!selectedBuildingId) {
        toast.error('Vui lòng chọn toà nhà trước');
        return;
      }
      setQuickFloorOpen(true);
      return;
    }
    form.setValue('floor', parseInt(value, 10), { shouldValidate: true });
  };

  const handleBuildingCreated = (building: Building) => {
    form.setValue('building_id', building.id, { shouldValidate: true });
  };

  const handleFloorCreated = (floor: any) => {
    form.setValue('floor', floor.floor_number, { shouldValidate: true });
  };

  const isPending = createRoom.isPending || updateRoom.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>{isEditMode ? 'Sửa căn hộ' : 'Thêm căn hộ'}</DialogTitle>
            <DialogDescription>
              {isEditMode ? 'Cập nhật thông tin căn hộ' : 'Thêm căn hộ mới vào hệ thống'}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  {/* Toà nhà */}
                  <FormField
                    control={form.control}
                    name="building_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Toà nhà *</FormLabel>
                        <Select onValueChange={handleBuildingChange} value={field.value || ''}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn toà nhà" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {buildings.map((b) => (
                              <SelectItem key={b.id} value={b.id}>
                                {b.name}{b.code ? ` (${b.code})` : ''}
                              </SelectItem>
                            ))}
                            <SelectItem value={QUICK_CREATE_BUILDING}>
                              <span className="flex items-center gap-1 text-primary">
                                <Plus className="h-3 w-3" /> Thêm toà nhà
                              </span>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Tầng */}
                  <FormField
                    control={form.control}
                    name="floor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tầng *</FormLabel>
                        <Select
                          onValueChange={handleFloorChange}
                          value={field.value ? String(field.value) : ''}
                          disabled={!selectedBuildingId}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={selectedBuildingId ? 'Chọn tầng' : 'Chọn toà nhà trước'} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {floors.map((f: any) => (
                              <SelectItem key={f.id} value={String(f.floor_number)}>
                                Tầng {f.floor_number}{f.name ? ` - ${f.name}` : ''}
                              </SelectItem>
                            ))}
                            <SelectItem value={QUICK_CREATE_FLOOR}>
                              <span className="flex items-center gap-1 text-primary">
                                <Plus className="h-3 w-3" /> Thêm tầng
                              </span>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Tên phòng */}
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên phòng *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Nhập tên phòng" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  {/* Tiền thuê */}
                  <FormField
                    control={form.control}
                    name="rent_price"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tiền thuê *</FormLabel>
                        <FormControl>
                          <CurrencyInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            placeholder="Nhập tiền thuê"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Tiền cọc */}
                  <FormField
                    control={form.control}
                    name="deposit_amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tiền cọc *</FormLabel>
                        <FormControl>
                          <CurrencyInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            placeholder="Nhập tiền cọc"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {/* Diện tích */}
                  <FormField
                    control={form.control}
                    name="area"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Diện tích (m²)</FormLabel>
                        <FormControl>
                          <NumberInput
                            allowDecimal
                            min={0}
                            value={field.value}
                            onChange={(v) => field.onChange(v || null)}
                            onBlur={field.onBlur}
                            name={field.name}
                            placeholder="Nhập diện tích"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Số khách tối đa */}
                  <FormField
                    control={form.control}
                    name="max_occupants"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số khách tối đa</FormLabel>
                        <FormControl>
                          <NumberInput
                            min={1}
                            value={field.value}
                            onChange={(v) => field.onChange(v || null)}
                            onBlur={field.onBlur}
                            name={field.name}
                            placeholder="Nhập số khách tối đa"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Toggle Hoạt động */}
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center gap-3">
                        <Label>Hoạt động</Label>
                        <Switch
                          checked={field.value === 'AVAILABLE'}
                          onCheckedChange={(checked) =>
                            field.onChange(checked ? 'AVAILABLE' : 'UNAVAILABLE')
                          }
                        />
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  {/* Mẫu hoá đơn */}
                  <FormField
                    control={form.control}
                    name="invoice_template_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mẫu hoá đơn</FormLabel>
                        <Select
                          onValueChange={(val) => field.onChange(val === '__none__' ? null : val)}
                          value={field.value || '__none__'}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn mẫu hoá đơn" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="__none__">-- Không chọn --</SelectItem>
                            {(invoiceTemplates || []).map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Mẫu hợp đồng thuê */}
                  <FormField
                    control={form.control}
                    name="lease_template_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mẫu hợp đồng thuê</FormLabel>
                        <Select
                          onValueChange={(val) => field.onChange(val === '__none__' ? null : val)}
                          value={field.value || '__none__'}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn mẫu hợp đồng" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="__none__">-- Không chọn --</SelectItem>
                            {(leaseTemplates || []).map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

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
                      : (isEditMode ? 'Cập nhật' : 'Thêm căn hộ')}
                  </Button>
                </div>
              </form>
            </Form>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Quick-create dialogs */}
      <QuickCreateBuildingDialog
        open={quickBuildingOpen}
        onOpenChange={setQuickBuildingOpen}
        onCreated={handleBuildingCreated}
      />

      {selectedBuildingId && (
        <QuickCreateFloorDialog
          open={quickFloorOpen}
          onOpenChange={setQuickFloorOpen}
          buildingId={selectedBuildingId}
          onCreated={handleFloorCreated}
        />
      )}
    </>
  );
}
