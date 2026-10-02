import { useEffect, useState, useCallback, useRef } from 'react';
import {
  mapMeterToReading,
  getPreviousReadingFromList,
  getMeterNameFromList,
  formatSimpleMeterName,
  isLoadEnabled,
  previousReadingWhenEditing,
  meterNameWhenEditing,
  type UnrecordedMeter,
} from './meterReadingFormUtils';
import { useForm, useFieldArray } from 'react-hook-form';
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
import { StorageImage } from '@/components/ui/storage-image';
import { NumberInput } from '@/components/ui/number-input';
import { DateInput } from '@/components/ui/date-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  meterReadingFormSchema,
  validateReadingValue,
  type MeterReadingFormValues,
} from '@/lib/meterReadingValidation';
import {
  useBulkCreateMeterReadings,
  useUpdateMeterReading,
  MeterReadingBatchPartialError,
  type MeterReadingDetailed,
} from '@/hooks/useMeterReadings';
import { useUnrecordedMeters } from '@/hooks/useMeters';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useAuth } from '@/hooks/useAuth';
import { uploadFile, sanitizeStorageFileName } from '@/lib/storage';
import { toast } from 'sonner';
import { ImagePlus, Loader2 } from 'lucide-react';
import { LoadingState } from '@/components/loading/LoadingState';
import { todayISO } from '@/lib/collect';
import { focusFirstError } from '@/lib/formErrors';
import {recordWriteBlocked,recordWriteMessage} from '@/lib/recordWriteOutcome';
import {validateInputDrafts} from '@/lib/inputDraftValidation';

// ============================================================================
// Types
// ============================================================================

interface MeterReadingFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reading: MeterReadingDetailed | null; // null = thêm mới, non-null = sửa
}

// ============================================================================
// Constants
// ============================================================================

const METER_TYPE_OPTIONS = [
  { value: 'ELECTRICITY', label: 'Điện' },
  { value: 'WATER', label: 'Nước' },
] as const;

const DEFAULT_METER_TYPE: 'ELECTRICITY' = 'ELECTRICITY';

const STORAGE_BUCKET = 'meter-images';

// ============================================================================
// Component
// ============================================================================

const MeterReadingForm = ({ open, onOpenChange, reading }: MeterReadingFormProps) => {
  const formRef = useRef<HTMLFormElement>(null);
  const busy=useRef(false);
  const draftKey=useRef<string|null>(null);
  const loadedFilter=useRef<string|null>(null);
  const [submitFailure,setSubmitFailure]=useState('');
  const isEditing = !!reading;
  const bulkCreate = useBulkCreateMeterReadings();
  const updateReading = useUpdateMeterReading();

  // Người đang đăng nhập — dùng làm thư mục gốc khi upload ảnh chỉ số.
  const { data: currentUser } = useAuth();

  // Building & Room selects
  const buildingsQuery=useBuildings();const {data:buildings}=buildingsQuery;
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const roomsQuery=useRooms(selectedBuildingId || undefined);const {data:rooms}=roomsQuery;
  const sourceBlocked=buildingsQuery.isLoading || buildingsQuery.isError || roomsQuery.isLoading || roomsQuery.isError;

  // UI state
  const [showUnrecordedOnly, setShowUnrecordedOnly] = useState(true);
  const [showMetersTable, setShowMetersTable] = useState(false);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<number, string>>({});
  const [imageErrors, setImageErrors] = useState<Record<number, string>>({});
  const [unknownBatchOutcome, setUnknownBatchOutcome] = useState<string | null>(null);

  const currentMonth = new Date().toISOString().slice(0, 7);

  // Form setup with Zod validation
  const form = useForm<MeterReadingFormValues>({
    resolver: zodResolver(meterReadingFormSchema),
    defaultValues: {
      building_id: '',
      room_id: '',
      meter_type: DEFAULT_METER_TYPE,
      settlement_month: currentMonth,
      reading_date: todayISO(),
      readings: [],
    },
  });

  const { fields, replace } = useFieldArray({
    control: form.control,
    name: 'readings',
  });

  const watchBuildingId = form.watch('building_id');
  const watchRoomId = form.watch('room_id');
  const watchMeterType = form.watch('meter_type');
  const watchMonth = form.watch('settlement_month');

  // Query unrecorded meters based on filter selections
  const unrecordedQuery = useUnrecordedMeters({
    buildingId: watchBuildingId || undefined,
    roomId: watchRoomId || undefined,
    meterType: watchMeterType || undefined,
    month: watchMonth || currentMonth,
  });
  const { data: unrecordedMeters, isLoading: isLoadingMeters } = unrecordedQuery;

  // --------------------------------------------------------------------------
  // Populate form when editing
  // --------------------------------------------------------------------------
  useEffect(() => {
    if(!open)return;
    const key=reading?.id ?? 'new';
    if(draftKey.current===key && (form.formState.isDirty || submitFailure || unknownBatchOutcome || Object.keys(imageErrors).length))return;
    draftKey.current=key;setSubmitFailure('');setUnknownBatchOutcome(null);loadedFilter.current=null;
    if (reading && open) {
      setSelectedBuildingId(reading.building_id || '');
      form.reset({
        building_id: reading.building_id || '',
        room_id: reading.room_id || '',
        meter_type: reading.meter_type as 'ELECTRICITY' | 'WATER' | 'GAS' | null,
        settlement_month: reading.settlement_month || currentMonth,
        reading_date: reading.reading_date || todayISO(),
        readings: [
          {
            meter_id: reading.meter_id,
            current_reading: reading.current_reading ?? 0,
            notes: reading.notes || '',
            meter_image_url: reading.meter_image_url || '',
          },
        ],
      });
      setShowMetersTable(true);
    } else if (!reading && open) {
      form.reset({
        building_id: '',
        room_id: '',
        meter_type: DEFAULT_METER_TYPE,
        settlement_month: currentMonth,
        reading_date: todayISO(),
        readings: [],
      });
      setSelectedBuildingId('');
      setShowMetersTable(false);
      setShowUnrecordedOnly(true);
      setValidationErrors({});
    }
  }, [reading, open, form, currentMonth]);

  // Cast unrecorded meters to typed array
  const metersList: UnrecordedMeter[] = Array.isArray(unrecordedMeters)
    ? (unrecordedMeters as unknown as UnrecordedMeter[])
    : [];

  // --------------------------------------------------------------------------
  // Load meters into form readings array
  // --------------------------------------------------------------------------
  const loadMetersIntoForm = useCallback(() => {
    if (unrecordedQuery.isError || !unrecordedQuery.data) return;
    if (metersList.length === 0) {
      if (
        isLoadEnabled({ buildingId: watchBuildingId, month: watchMonth || '' }) &&
        !isLoadingMeters
      ) {
        toast.info('Không có công tơ chưa chốt cho bộ lọc đã chọn');
      }
      replace([]);
      setShowMetersTable(true);
      setValidationErrors({});
      return;
    }
    const readingsData = metersList.map(mapMeterToReading);
    replace(readingsData);
    setShowMetersTable(true);
    setValidationErrors({});
  }, [metersList, replace, watchBuildingId, watchMonth, isLoadingMeters, unrecordedQuery.isError, unrecordedQuery.data]);

  // Auto-load meters when filters change (add mode only)
  useEffect(() => {
    if (isEditing || !open || submitFailure || unknownBatchOutcome) return;
    const key=[watchBuildingId,watchRoomId,watchMeterType,watchMonth].join(':');
    if(loadedFilter.current===key && form.formState.dirtyFields.readings)return;
    if (isLoadingMeters || unrecordedQuery.isError || !unrecordedQuery.data) return;
    if (isLoadEnabled({ buildingId: watchBuildingId, month: watchMonth || '' })) {
      loadedFilter.current=key;loadMetersIntoForm();
    } else {
      if (showMetersTable) {
        replace([]);
        setShowMetersTable(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchBuildingId, watchRoomId, watchMeterType, watchMonth, metersList, isLoadingMeters]);

  // --------------------------------------------------------------------------
  // Image upload
  // --------------------------------------------------------------------------
  const handleImageUpload = async (index: number, file: File) => {
    try {
      setUploadingIndex(index);
      // Thư mục gốc PHẢI là uid của chính người upload — policy RESTRICTIVE
      // storage_pii_org_isolation_insert chặn ghi vào thư mục người/tổ chức khác.
      if (!currentUser?.id) {
        toast.error('Phiên đăng nhập đã hết hạn, hãy đăng nhập lại');
        return;
      }
      const path = `${currentUser.id}/readings/${Date.now()}_${sanitizeStorageFileName(file.name)}`;
      const url = await uploadFile(STORAGE_BUCKET, path, file);
      form.setValue(`readings.${index}.meter_image_url`, url);
      setImageErrors(previous => { const next = { ...previous }; delete next[index]; return next; });
    } catch (error) {
      console.error('Image upload error:', error);
      setImageErrors(previous => ({ ...previous, [index]: 'Không tải được ảnh công tơ. Chọn lại ảnh trước khi lưu.' }));
      toast.error('Không thể tải lên ảnh công tơ');
      void focusFirstError({ [`readings.${index}.meter_image_url`]: 'Không tải được ảnh' }, { root: formRef.current });
    } finally {
      setUploadingIndex(null);
    }
  };

  // --------------------------------------------------------------------------
  // Helpers: previous reading & meter name
  // --------------------------------------------------------------------------
  const getPreviousReading = (meterId: string): number => {
    if (isEditing && reading) {
      return previousReadingWhenEditing(reading);
    }
    return getPreviousReadingFromList(meterId, metersList);
  };

  const getMeterName = (meterId: string): string => {
    if (isEditing && reading) {
      return meterNameWhenEditing(reading);
    }
    return getMeterNameFromList(meterId, metersList);
  };

  // --------------------------------------------------------------------------
  // Validation: reading values >= previous
  // --------------------------------------------------------------------------
  const validateReadings = (): boolean => {
    const errors: Record<number, string> = {};
    const readings = form.getValues('readings');
    let valid = true;

    readings.forEach((r, index) => {
      const previousReading = getPreviousReading(r.meter_id);
      const error = validateReadingValue(r.current_reading, previousReading);
      if (error) {
        errors[index] = error;
        valid = false;
      }
    });

    setValidationErrors(errors);
    if (!valid) void focusFirstError(Object.fromEntries(Object.entries(errors).map(([index, message]) => [`readings.${index}.current_reading`, message])), { root: formRef.current });
    return valid;
  };

  // --------------------------------------------------------------------------
  // Submit handler
  // --------------------------------------------------------------------------
  const onSubmit = async (data: MeterReadingFormValues) => {
    if (unknownBatchOutcome || busy.current || bulkCreate.isPending || updateReading.isPending || sourceBlocked || (!isEditing && (unrecordedQuery.isLoading || unrecordedQuery.isError || !unrecordedQuery.data)) || !validateInputDrafts(formRef.current)) return;
    if (!validateReadings()) return;

    busy.current=true;setSubmitFailure('');
    try {
      if (isEditing && reading) {
        // Update single reading
        const readingData = data.readings[0];
        await updateReading.mutateAsync({
          id: reading.id,
          current_reading: readingData.current_reading,
          reading_date: data.reading_date,
          notes: readingData.notes || undefined,
          meter_image_url: readingData.meter_image_url || undefined,
        });
      } else {
        // Bulk create readings (only rows with current_reading > 0)
        const readingsToCreate = data.readings
          .filter((r) => r.current_reading > 0)
          .map((r) => ({
            meter_id: r.meter_id,
            reading_date: data.reading_date,
            current_reading: r.current_reading,
            notes: r.notes || undefined,
            meter_image_url: r.meter_image_url || undefined,
          }));

        if (readingsToCreate.length === 0) {
          toast.error('Vui lòng nhập ít nhất 1 chỉ số');
          return;
        }

        await bulkCreate.mutateAsync(readingsToCreate);
      }
      draftKey.current=null;loadedFilter.current=null;form.reset();onOpenChange(false);
    } catch (error) {
      const message=recordWriteMessage(error,'lưu chỉ số');
      setSubmitFailure(message);
      if(recordWriteBlocked(error))setUnknownBatchOutcome(message);
    } finally {busy.current=false;}
  };

  const isPending = bulkCreate.isPending || updateReading.isPending;

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------
  return (
    <Dialog open={open} onOpenChange={next=>{if(!busy.current && !isPending && uploadingIndex===null)onOpenChange(next);}}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[900px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Cập nhật chỉ số' : 'Thêm chỉ số'}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form ref={formRef} onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors, { root: formRef.current }); })} className="space-y-4">
              {(unknownBatchOutcome || submitFailure) && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{unknownBatchOutcome || submitFailure}</p>}
              {!isEditing && unrecordedQuery.isError && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">Không tải được công tơ chưa chốt. Dữ liệu đã nhập được giữ nguyên. <Button type="button" variant="link" onClick={() => void unrecordedQuery.refetch()}>Tải lại công tơ</Button></p>}
              {sourceBlocked && <div role="alert" className="text-destructive">Chưa tải đủ toà nhà hoặc phòng. <Button type="button" variant="outline" onClick={()=>{void buildingsQuery.refetch();void roomsQuery.refetch();}}>Tải lại dữ liệu</Button></div>}
              <fieldset disabled={isPending || sourceBlocked || !!unknownBatchOutcome} className="space-y-4">
              {/* Row 1: Tòa nhà + Phòng */}
              <div className="grid grid-cols-2 gap-4">
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
                          setShowMetersTable(false);
                        }}
                        value={field.value}
                        disabled={isEditing}
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
                      <FormLabel>Phòng</FormLabel>
                      <Select
                        onValueChange={(val) => {
                          field.onChange(val === '__all__' ? '' : val);
                          setShowMetersTable(false);
                        }}
                        value={field.value || '__all__'}
                        disabled={isEditing}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Tất cả phòng" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__all__">Tất cả phòng</SelectItem>
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
              </div>

              {/* Row 2: Loại công tơ + Tháng chốt + Ngày chốt */}
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="meter_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Loại công tơ *</FormLabel>
                      <Select
                        onValueChange={(val) => {
                          field.onChange(val);
                          setShowMetersTable(false);
                        }}
                        value={field.value ?? DEFAULT_METER_TYPE}
                        disabled={isEditing}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
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
                  name="settlement_month"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tháng chốt *</FormLabel>
                      <FormControl>
                        <Input
                          type="month"
                          {...field}
                          onChange={(e) => {
                            field.onChange(e.target.value);
                            setShowMetersTable(false);
                          }}
                          disabled={isEditing}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="reading_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ngày chốt *</FormLabel>
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

              {/* Checkbox: Công tơ chưa chốt trong tháng */}
              {!isEditing && (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="show-unrecorded"
                    checked={showUnrecordedOnly}
                    onCheckedChange={(checked) =>
                      setShowUnrecordedOnly(checked === true)
                    }
                  />
                  <label
                    htmlFor="show-unrecorded"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Công tơ chưa chốt trong tháng
                  </label>
                </div>
              )}

              {/* Đang nạp công tơ: khối xám dạng dòng bảng (chủ chốt 02/10/2026). */}
              {isLoadingMeters && !isEditing && (
                <LoadingState label="danh sách công tơ" variant="table" rows={3} />
              )}

              {/* Meters table */}
              {showMetersTable && fields.length > 0 && (
                <div className="border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tên công tơ</TableHead>
                        <TableHead className="text-right">Chỉ số đầu</TableHead>
                        <TableHead className="text-right">Chỉ số mới</TableHead>
                        <TableHead className="hidden sm:table-cell">Ghi chú</TableHead>
                        <TableHead>Hình ảnh</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fields.map((field, index) => {
                        const previousReading = getPreviousReading(field.meter_id);
                        const error = validationErrors[index];

                        return (
                          <TableRow key={field.id}>
                            {/* Tên công tơ */}
                            <TableCell className="font-medium">
                              {getMeterName(field.meter_id)}
                            </TableCell>

                            {/* Chỉ số đầu (auto from last_reading) */}
                            <TableCell className="text-right text-muted-foreground">
                              {previousReading.toFixed(2)}
                            </TableCell>

                            {/* Chỉ số mới (input) */}
                            <TableCell>
                              <div className="flex flex-col items-end">
                                <FormField
                                  control={form.control}
                                  name={`readings.${index}.current_reading`}
                                  render={({ field: inputField }) => (
                                    <FormItem className="w-32">
                                      <FormControl>
                                        <NumberInput
                                          aria-label={`Chỉ số mới ${getMeterName(field.meter_id)}`}
                                          allowDecimal
                                          min={0}
                                          className={`text-right ${error ? 'border-red-500' : ''}`}
                                          value={inputField.value}
                                          onBlur={inputField.onBlur}
                                          name={inputField.name}
                                          aria-invalid={Boolean(error)}
                                          onChange={(val) => {
                                            inputField.onChange(val);
                                            if (validationErrors[index]) {
                                              setValidationErrors((prev) => {
                                                const next = { ...prev };
                                                delete next[index];
                                                return next;
                                              });
                                            }
                                          }}
                                        />
                                      </FormControl>
                                      {error && (
                                        <p className="text-xs text-red-500 mt-1">
                                          {error}
                                        </p>
                                      )}
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />
                              </div>
                            </TableCell>

                            {/* Ghi chú (ẩn trên mobile) */}
                            <TableCell className="hidden sm:table-cell">
                              <FormField
                                control={form.control}
                                name={`readings.${index}.notes`}
                                render={({ field: notesField }) => (
                                  <FormItem className="w-36">
                                    <FormControl>
                                      <Input
                                        placeholder="Ghi chú"
                                        {...notesField}
                                      />
                                    </FormControl>
                                  </FormItem>
                                )}
                              />
                            </TableCell>

                            {/* Hình ảnh (upload) */}
                            <TableCell>
                              <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                {form.watch(
                                  `readings.${index}.meter_image_url`
                                ) ? (
                                  <StorageImage
                                    value={form.watch(
                                      `readings.${index}.meter_image_url`
                                    )}
                                    alt="Công tơ"
                                    className="h-10 w-10 rounded object-cover"
                                  />
                                ) : null}
                                <label className={`cursor-pointer ${imageErrors[index] ? 'rounded ring-2 ring-destructive' : ''}`}
                                  data-field-name={`readings.${index}.meter_image_url`} tabIndex={0}
                                  aria-invalid={Boolean(imageErrors[index])}>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file) handleImageUpload(index, file);
                                    }}
                                    disabled={uploadingIndex !== null}
                                  />
                                  {uploadingIndex === index ? (
                                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                  ) : (
                                    <ImagePlus className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                                  )}
                                </label>
                              </div>
                              {imageErrors[index] && <p role="alert" className="text-xs text-destructive">{imageErrors[index]}</p>}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Empty state */}
              {showMetersTable && fields.length === 0 && !isEditing && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Không có công tơ chưa chốt cho bộ lọc đã chọn
                </p>
              )}

              </fieldset>
              {/* Actions */}
              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  disabled={isPending || sourceBlocked || uploadingIndex!==null || fields.length === 0 || !!unknownBatchOutcome || (!isEditing && (unrecordedQuery.isError || !unrecordedQuery.data))}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Đang lưu...
                    </>
                  ) : (
                    'Lưu'
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default MeterReadingForm;
