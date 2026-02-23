import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { meterFormSchema, type MeterFormValues } from '@/lib/meterReadingValidation';
import { useCreateMeter, useUpdateMeter, type MeterWithRoom } from '@/hooks/useMeters';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';

interface MeterFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meter?: MeterWithRoom | null;
}

const METER_TYPE_OPTIONS = [
  { value: 'ELECTRICITY', label: 'Điện' },
  { value: 'WATER', label: 'Nước' },
  { value: 'GAS', label: 'Gas' },
] as const;

const MeterForm = ({ open, onOpenChange, meter }: MeterFormProps) => {
  const isEditing = !!meter;
  const createMeter = useCreateMeter();
  const updateMeter = useUpdateMeter();

  const { data: buildings } = useBuildings();
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const { data: rooms } = useRooms(selectedBuildingId || undefined);

  const form = useForm<MeterFormValues>({
    resolver: zodResolver(meterFormSchema),
    defaultValues: {
      building_id: '',
      room_id: '',
      meter_type: undefined,
      code: '',
      initial_reading: 0,
      installation_date: '',
      location_note: '',
      manufacturer: '',
      model: '',
      serial_number: '',
      notes: '',
    },
  });

  // Populate form when editing
  useEffect(() => {
    if (meter && open) {
      const values: MeterFormValues = {
        building_id: meter.building_id || '',
        room_id: meter.room_id || '',
        meter_type: meter.meter_type as 'ELECTRICITY' | 'WATER' | 'GAS',
        code: meter.code || '',
        initial_reading: meter.initial_reading ?? 0,
        installation_date: meter.installation_date || '',
        location_note: meter.location_note || '',
        manufacturer: meter.manufacturer || '',
        model: meter.model || '',
        serial_number: meter.serial_number || '',
        notes: meter.notes || '',
      };
      setSelectedBuildingId(meter.building_id || '');
      form.reset(values);
    } else if (!meter && open) {
      form.reset({
        building_id: '',
        room_id: '',
        meter_type: undefined,
        code: '',
        initial_reading: 0,
        installation_date: '',
        location_note: '',
        manufacturer: '',
        model: '',
        serial_number: '',
        notes: '',
      });
      setSelectedBuildingId('');
    }
  }, [meter, open, form]);

  const onSubmit = async (data: MeterFormValues) => {
    try {
      if (isEditing) {
        await updateMeter.mutateAsync({
          id: meter.id,
          updates: {
            building_id: data.building_id,
            room_id: data.room_id,
            meter_type: data.meter_type,
            code: data.code,
            initial_reading: data.initial_reading,
            installation_date: data.installation_date || null,
            location_note: data.location_note || null,
            manufacturer: data.manufacturer || null,
            model: data.model || null,
            serial_number: data.serial_number || null,
            notes: data.notes || null,
          },
        });
      } else {
        // service_id is auto-resolved from meter_type in the useCreateMeter hook
        await createMeter.mutateAsync({
          building_id: data.building_id,
          room_id: data.room_id,
          meter_type: data.meter_type,
          code: data.code,
          initial_reading: data.initial_reading,
          installation_date: data.installation_date || null,
          location_note: data.location_note || null,
          manufacturer: data.manufacturer || null,
          model: data.model || null,
          serial_number: data.serial_number || null,
          notes: data.notes || null,
        } as Parameters<typeof createMeter.mutateAsync>[0]);
      }
      onOpenChange(false);
    } catch {
      // Errors handled by mutation hooks (toast)
    }
  };

  const isPending = createMeter.isPending || updateMeter.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Sửa công tơ' : 'Thêm công tơ'}</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Required fields */}
              <FormField
                control={form.control}
                name="building_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tòa nhà *</FormLabel>
                    <Select
                      onValueChange={(val) => {
                        field.onChange(val);
                        setSelectedBuildingId(val);
                        form.setValue('room_id', '');
                      }}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn tòa nhà" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {buildings?.map((b) => (
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

              <FormField
                control={form.control}
                name="room_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phòng *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn phòng" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {rooms?.map((r) => (
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

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="meter_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Loại công tơ *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn loại" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {METER_TYPE_OPTIONS.map((opt) => (
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

                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mã công tơ *</FormLabel>
                      <FormControl>
                        <Input placeholder="VD: CTD-201" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Optional fields */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Thông tin bổ sung</h3>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="initial_reading"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Chỉ số ban đầu</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="0"
                            {...field}
                            onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="installation_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngày lắp đặt</FormLabel>
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
                  name="location_note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ghi chú vị trí</FormLabel>
                      <FormControl>
                        <Input placeholder="VD: Tầng 2, hành lang" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="manufacturer"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nhà sản xuất</FormLabel>
                        <FormControl>
                          <Input placeholder="VD: Schneider" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Model</FormLabel>
                        <FormControl>
                          <Input placeholder="VD: iEM3155" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="serial_number"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số serial</FormLabel>
                        <FormControl>
                          <Input placeholder="VD: SN12345" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ghi chú</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Ghi chú thêm..." {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending ? 'Đang lưu...' : 'Lưu'}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default MeterForm;
