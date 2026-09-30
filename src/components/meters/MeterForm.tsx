import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { NumberInput } from '@/components/ui/number-input';
import { DateInput } from '@/components/ui/date-input';
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
import { focusFirstError } from '@/lib/formErrors';
import { isDuplicateMeterCode } from '@/lib/meterFeedback';
import {recordWriteBlocked,recordWriteMessage} from '@/lib/recordWriteOutcome';

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
  const formRef = useRef<HTMLFormElement>(null);
  const isEditing = !!meter;
  const [failure,setFailure]=useState<unknown>();
  const [blocked,setBlocked]=useState(false);
  const draftKey=useRef<string|null>(null);
  const createMeter = useCreateMeter();
  const updateMeter = useUpdateMeter();

  const buildingsQuery=useBuildings();
  const {data:buildings}=buildingsQuery;
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const roomsQuery=useRooms(selectedBuildingId||undefined);
  const {data:rooms}=roomsQuery;
  const sources=[buildingsQuery,roomsQuery];
  const sourceBlocked=sources.some(query=>query.isError||query.isLoading);

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
    },
  });

  // Populate form when editing, reset when adding
  useEffect(() => {
    const key=meter?.id??'create';
    if(draftKey.current===key && (failure || form.formState.isDirty))return;
    draftKey.current=key;setFailure(undefined);setBlocked(false);
    if (meter && open) {
      const values: MeterFormValues = {
        building_id: meter.building_id || '',
        room_id: meter.room_id || '',
        meter_type: meter.meter_type as 'ELECTRICITY' | 'WATER' | 'GAS',
        code: meter.code || '',
        initial_reading: meter.initial_reading ?? 0,
        installation_date: meter.installation_date || '',
        location_note: meter.location_note || '',
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
      });
      setSelectedBuildingId('');
    }
  }, [meter, open, form]);

  const onSubmit = async (data: MeterFormValues) => {
    if(blocked||sourceBlocked)return;form.clearErrors('root.server');
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
          },
        });
      } else {
        await createMeter.mutateAsync({
          building_id: data.building_id,
          room_id: data.room_id,
          meter_type: data.meter_type,
          code: data.code,
          initial_reading: data.initial_reading,
          installation_date: data.installation_date || null,
          location_note: data.location_note || null,
        } as Parameters<typeof createMeter.mutateAsync>[0]);
      }
      draftKey.current=null;
      onOpenChange(false);
      form.reset();
    } catch (error: unknown) {
      setFailure(error);setBlocked(recordWriteBlocked(error));
      form.setError('root.server',{type:'server',message:recordWriteMessage(error,'lưu công tơ')});
      if (isDuplicateMeterCode(error)) {
        form.setError('code', { message: 'Mã công tơ đã tồn tại' });
        await focusFirstError({ code: 'Mã công tơ đã tồn tại' }, { root: formRef.current });
      }
    }
  };

  const isPending = createMeter.isPending || updateMeter.isPending;

  return (
    <Dialog open={open} onOpenChange={value=>{if(!form.formState.isSubmitting&&!isPending)onOpenChange(value);}}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Sửa công tơ' : 'Thêm công tơ'}</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form ref={formRef} onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors, { root: formRef.current }); })} className="space-y-4">
              {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
              {sourceBlocked && <div role="alert" className="rounded border border-destructive p-3 text-sm">Chưa tải đủ tòa hoặc phòng. Tải lại trước khi lưu.<Button type="button" variant="outline" onClick={()=>{for(const query of sources)void query.refetch();}}>Tải lại dữ liệu</Button></div>}
              <fieldset disabled={blocked || sourceBlocked || isPending || form.formState.isSubmitting} className="space-y-4">
              {/* Tòa nhà (*) */}
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

              {/* Phòng (*) - phụ thuộc Tòa nhà */}
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
                {/* Loại công tơ (*) */}
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

                {/* Mã công tơ (*) */}
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

              {/* Thông tin bổ sung */}
              <div className="space-y-4 pt-4 border-t">
                <div className="grid grid-cols-2 gap-4">
                  {/* Chỉ số ban đầu */}
                  <FormField
                    control={form.control}
                    name="initial_reading"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Chỉ số ban đầu</FormLabel>
                        <FormControl>
                          <NumberInput
                            allowDecimal
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Ngày lắp đặt */}
                  <FormField
                    control={form.control}
                    name="installation_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngày lắp đặt</FormLabel>
                        <FormControl>
                          <DateInput
                            value={field.value || ''}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Ghi chú vị trí */}
                <FormField
                  control={form.control}
                  name="location_note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ghi chú vị trí</FormLabel>
                      <FormControl>
                        <Textarea placeholder="VD: Tầng 2, hành lang" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              </fieldset>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={blocked || sourceBlocked || isPending || form.formState.isSubmitting}>
                  {isPending ? 'Đang lưu...' : 'Lưu'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default MeterForm;
