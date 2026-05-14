import { useState, useEffect } from 'react';
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
import { CurrencyInput } from '@/components/ui/currency-input';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import {
  incomeExpenseFormSchema,
  type IncomeExpenseFormValues,
} from '@/lib/incomeExpenseValidation';
import {
  useCreateIncomeExpense,
  useUpdateIncomeExpense,
  type IncomeExpenseWithRelations,
} from '@/hooks/useIncomeExpenses';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useAccounts } from '@/hooks/useAccounts';
import type { IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';
import IncomeExpenseItemSelector from './IncomeExpenseItemSelector';
import AttachmentUpload from './AttachmentUpload';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/use-mobile';

interface IncomeExpenseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher?: IncomeExpenseWithRelations | null;
  defaultType?: 'INCOME' | 'EXPENSE';
  /**
   * Khi mở dialog ở chế độ "tạo mới" (không có voucher), prefill các field
   * này để rút ngắn thao tác cho user. Vẫn cho phép user sửa lại trước khi
   * lưu — chỉ là giá trị khởi tạo.
   */
  defaultPrefill?: {
    building_id?: string;
    room_id?: string | null;
    name?: string;
    items?: Array<{
      income_expense_type_id: string;
      type_name: string;
      quantity: number;
      unit_price: number;
      description?: string | null;
    }>;
  };
  /**
   * Callback sau khi tạo mới phiếu thành công (không gọi khi edit).
   * Param `totalAmount` là tổng items đã lưu, để caller cập nhật UI ngoài.
   */
  onSaved?: (totalAmount: number) => void;
}

interface FormItemRow {
  income_expense_type_id: string;
  type_name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  start_date: string;
  end_date: string;
}

const IncomeExpenseForm = ({
  open,
  onOpenChange,
  voucher,
  defaultType,
  defaultPrefill,
  onSaved,
}: IncomeExpenseFormProps) => {
  const isEditing = !!voucher;
  const createMutation = useCreateIncomeExpense();
  const updateMutation = useUpdateIncomeExpense();
  const { data: authUser } = useAuth();
  const isMobile = useIsMobile();

  // Cascade dropdown state
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | undefined>(undefined);
  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);

  // Item selector dialog
  const [isItemSelectorOpen, setIsItemSelectorOpen] = useState(false);

  // Item rows with type_name for display (not part of Zod schema)
  const [itemRows, setItemRows] = useState<FormItemRow[]>([]);

  // Cascade data hooks — includeVirtual để hiển thị tòa "Chung" cho chi/thu chung công ty
  const { data: buildings = [] } = useBuildings({ includeVirtual: true });
  const { data: rooms = [] } = useRooms(selectedBuildingId);
  const { data: accounts = [] } = useAccounts();

  const form = useForm<IncomeExpenseFormValues>({
    resolver: zodResolver(incomeExpenseFormSchema),
    defaultValues: {
      type: defaultType ?? 'INCOME',
      name: '',
      building_id: '',
      room_id: null,
      tenant_id: null,
      payer_name: '',
      account_id: '',
      voucher_date: new Date().toISOString().split('T')[0],
      business_result_accounting: false,
      repeat_cycle: 'NONE',
      repeat_infinity: false,
      repeat_count: 0,
      attachments: [],
      items: [],
    },
  });

  const voucherType = form.watch('type');

  // When voucher type changes, reset items (income types differ from expense types)
  useEffect(() => {
    // Only reset items when type changes in create mode (not during initial load)
    if (!voucher && open && form.formState.isDirty) {
      setItemRows([]);
      form.setValue('items', [], { shouldValidate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voucherType]);

  // Populate form when editing or reset when adding
  useEffect(() => {
    if (!open) return;

    if (voucher) {
      setSelectedBuildingId(voucher.building_id);
      setSelectedRoomId(voucher.room_id ?? undefined);

      const today = new Date().toISOString().split('T')[0];

      form.reset({
        type: voucher.type,
        name: voucher.name,
        building_id: voucher.building_id,
        room_id: voucher.room_id ?? null,
        tenant_id: voucher.tenant_id ?? null,
        payer_name: voucher.payer_name ?? '',
        account_id: voucher.account_id ?? '',
        voucher_date: voucher.voucher_date,
        business_result_accounting: voucher.business_result_accounting ?? false,
        repeat_cycle: (voucher.repeat_cycle as any) ?? 'NONE',
        repeat_infinity: voucher.repeat_infinity ?? false,
        repeat_count: voucher.repeat_count ?? 0,
        attachments: voucher.attachments ?? [],
        items: voucher.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? today,
          end_date: item.end_date ?? today,
        })),
      });

      setItemRows(
        voucher.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          type_name: item.type_name,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? today,
          end_date: item.end_date ?? today,
        }))
      );
    } else {
      const prefillBuilding = defaultPrefill?.building_id;
      const prefillRoom = defaultPrefill?.room_id ?? null;
      setSelectedBuildingId(prefillBuilding ?? undefined);
      setSelectedRoomId(prefillRoom ?? undefined);

      const today = new Date().toISOString().split('T')[0];
      const prefillItemsForm = (defaultPrefill?.items ?? []).map((it) => ({
        income_expense_type_id: it.income_expense_type_id,
        description: it.description ?? null,
        quantity: it.quantity,
        unit_price: it.unit_price,
        start_date: today,
        end_date: today,
      }));
      const prefillItemsRows = (defaultPrefill?.items ?? []).map((it) => ({
        income_expense_type_id: it.income_expense_type_id,
        type_name: it.type_name,
        description: it.description ?? null,
        quantity: it.quantity,
        unit_price: it.unit_price,
        start_date: today,
        end_date: today,
      }));

      form.reset({
        type: defaultType ?? 'INCOME',
        name: defaultPrefill?.name ?? '',
        building_id: prefillBuilding ?? '',
        room_id: prefillRoom,
        tenant_id: null,
        payer_name: '',
        account_id: '',
        voucher_date: today,
        business_result_accounting: false,
        repeat_cycle: 'NONE',
        repeat_infinity: false,
        repeat_count: 0,
        attachments: [],
        items: prefillItemsForm,
      });
      setItemRows(prefillItemsRows);
    }
  }, [voucher, open, defaultType, defaultPrefill, form]);

  // Cascade: when building changes → clear room, tenant
  const handleBuildingChange = (buildingId: string) => {
    setSelectedBuildingId(buildingId);
    setSelectedRoomId(undefined);
    form.setValue('building_id', buildingId);
    form.setValue('room_id', null);
    form.setValue('tenant_id', null);
  };

  // Cascade: when room changes → clear tenant
  const handleRoomChange = (roomId: string) => {
    const value = roomId === '__none__' ? null : roomId;
    setSelectedRoomId(value ?? undefined);
    form.setValue('room_id', value);
    form.setValue('tenant_id', null);
  };

  const handleAccountChange = (accountId: string) => {
    form.setValue('account_id', accountId);
  };

  // Item selector callback
  const handleItemsSelected = (types: IncomeExpenseType[]) => {
    const existingIds = new Set(itemRows.map((r) => r.income_expense_type_id));
    const today = new Date().toISOString().split('T')[0];
    const newRows: FormItemRow[] = [];

    for (const t of types) {
      if (!existingIds.has(t.id)) {
        newRows.push({
          income_expense_type_id: t.id,
          type_name: t.name,
          description: null,
          quantity: 1,
          unit_price: 0,
          start_date: today,
          end_date: today,
        });
      }
    }

    // Remove items that were unchecked
    const selectedIds = new Set(types.map((t) => t.id));
    const kept = itemRows.filter((r) => selectedIds.has(r.income_expense_type_id));

    const merged = [...kept, ...newRows];
    setItemRows(merged);
    syncItemsToForm(merged);
  };

  const syncItemsToForm = (rows: FormItemRow[]) => {
    form.setValue(
      'items',
      rows.map((r) => ({
        income_expense_type_id: r.income_expense_type_id,
        description: r.description,
        quantity: r.quantity,
        unit_price: r.unit_price,
        start_date: r.start_date,
        end_date: r.end_date,
      })),
      { shouldValidate: form.formState.isSubmitted }
    );
  };

  const handleItemDescriptionChange = (index: number, value: string) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], description: value || null };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemQuantityChange = (index: number, value: number) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], quantity: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemPriceChange = (index: number, value: number) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], unit_price: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemStartDateChange = (index: number, value: string) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], start_date: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemEndDateChange = (index: number, value: string) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], end_date: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleRemoveItem = (index: number) => {
    const updated = itemRows.filter((_, i) => i !== index);
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const onSubmit = async (data: IncomeExpenseFormValues) => {
    try {
      if (isEditing && voucher) {
        await updateMutation.mutateAsync({ id: voucher.id, data });
      } else {
        await createMutation.mutateAsync(data);
        // Báo cho caller (vd ContractFormDialog) biết phiếu vừa tạo có tổng
        // bao nhiêu để cập nhật field "Đã đặt cọc" ngay tại form HĐ.
        const total = data.items.reduce(
          (sum, it) => sum + (it.quantity ?? 0) * (it.unit_price ?? 0),
          0,
        );
        onSaved?.(total);
      }
      onOpenChange(false);
    } catch {
      // Errors handled by mutation hooks (toast)
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  // Phiếu Nháp (UNAPPROVED): cho phép sửa.
  // Phiếu đã ghi nhận/đã huỷ: chỉ xem (read-only).
  // Tạo mới: edit được.
  const isUnapprovedDraft = voucher?.approval_status === 'UNAPPROVED';
  const isViewing = !!voucher && !isUnapprovedDraft;
  const canEdit = !voucher || isUnapprovedDraft;

  const totalAmount = itemRows.reduce(
    (sum, item) => sum + item.quantity * item.unit_price,
    0
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            isMobile
              ? "max-w-full w-full h-[100dvh] !top-0 !left-0 !translate-x-0 !translate-y-0 rounded-none p-4 overflow-y-auto"
              : "sm:max-w-[800px] max-h-[90vh] overflow-y-auto"
          }
        >
          <DialogHeader>
            <DialogTitle>
              {isUnapprovedDraft
                ? 'SỬA PHIẾU NHÁP'
                : isViewing
                ? 'CHI TIẾT PHIẾU'
                : 'THÊM PHIẾU THU/CHI'}
            </DialogTitle>
          </DialogHeader>

          {isUnapprovedDraft && (
            <p className="text-sm text-muted-foreground">
              Phiếu đang ở trạng thái <b>Nháp</b>. Bạn có thể chỉnh sửa nội
              dung, sau đó ấn <b>Lưu</b> để cập nhật. Phiếu chỉ tính vào tồn
              quỹ khi đã được duyệt.
            </p>
          )}
          {isViewing && (
            <p className="text-sm text-muted-foreground">
              Phiếu đã được ghi nhận. Để bỏ ghi nhận, hãy đóng dialog này và
              ấn nút <b>Huỷ phiếu</b> trên dòng phiếu.
            </p>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Step 1: Voucher type tab toggle */}
              <Tabs
                value={form.watch('type')}
                onValueChange={(value) => form.setValue('type', value as 'INCOME' | 'EXPENSE')}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger
                    value="INCOME"
                    disabled={!canEdit}
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <ArrowUp className="h-4 w-4 mr-1" />
                    Phiếu thu
                  </TabsTrigger>
                  <TabsTrigger
                    value="EXPENSE"
                    disabled={!canEdit}
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <ArrowDown className="h-4 w-4 mr-1" />
                    Phiếu chi
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {/* Step 2: Thông tin chung - Grid layout */}
              {/* Row 1: Tòa nhà, Phòng, Sổ quỹ */}
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="building_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tòa nhà *</FormLabel>
                      <Select
                        onValueChange={handleBuildingChange}
                        value={field.value || ''}
                        disabled={!canEdit}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn tòa nhà" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {buildings.map((b) => (
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
                        onValueChange={handleRoomChange}
                        value={field.value ?? '__none__'}
                        disabled={!canEdit || !selectedBuildingId}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn phòng" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">-- Không chọn --</SelectItem>
                          {rooms.map((r) => (
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

                <FormField
                  control={form.control}
                  name="account_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sổ quỹ *</FormLabel>
                      <Select
                        onValueChange={handleAccountChange}
                        value={field.value || ''}
                        disabled={!canEdit}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn sổ quỹ" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {accounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}{a.bank_name ? ` (${a.bank_name})` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Row 2: (chỉ EXPENSE) Tên người nhận + Ngày, hoặc (INCOME) chỉ Ngày */}
              <div className="grid grid-cols-2 gap-3">
                {voucherType === 'EXPENSE' && (
                  <FormField
                    control={form.control}
                    name="payer_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tên người nhận</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Nhập tên người nhận"
                            {...field}
                            value={field.value ?? ''}
                            disabled={!canEdit}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="voucher_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {voucherType === 'EXPENSE' ? 'Ngày thực chi' : 'Ngày thực thu'} *
                      </FormLabel>
                      <FormControl>
                        <DateInput
                          value={field.value || ''}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          disabled={!canEdit}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Row 3: Tên phiếu (textarea lớn — gộp tên + ghi chú) */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {voucherType === 'EXPENSE' ? 'Tên phiếu chi' : 'Tên phiếu thu'} *
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder={
                          voucherType === 'EXPENSE'
                            ? 'VD: Chi tiền điện tháng 7 — ghi chú thêm...'
                            : 'VD: Thu tiền phòng tháng 7 — ghi chú thêm...'
                        }
                        {...field}
                        disabled={!canEdit}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Step 3: Items */}
              <div className="space-y-3">
                {/* Business result accounting toggle */}
                <FormField
                  control={form.control}
                  name="business_result_accounting"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <FormLabel className="text-sm font-medium">
                        Hạch toán kết quả kinh doanh?
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={!canEdit}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <div className="flex items-center justify-between">
                  <FormLabel>Hạng mục</FormLabel>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setIsItemSelectorOpen(true)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Thêm hạng mục
                    </Button>
                  )}
                </div>

                {/* Items validation error */}
                {form.formState.errors.items?.message && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.items.message}
                  </p>
                )}

                {itemRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2 text-center border rounded-lg">
                    Chưa có hạng mục nào. Ấn "Thêm hạng mục" để bắt đầu.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {/* Header row */}
                    <div className="grid grid-cols-[1fr_120px_120px_120px_36px] gap-2 text-xs text-muted-foreground font-medium px-1">
                      <span>Hạng mục</span>
                      <span>Số tiền</span>
                      <span>Ngày bắt đầu</span>
                      <span>Ngày kết thúc</span>
                      <span></span>
                    </div>
                    {itemRows.map((item, index) => (
                      <div
                        key={`${item.income_expense_type_id}-${index}`}
                        className="grid grid-cols-[1fr_120px_120px_120px_36px] gap-2 items-center rounded-lg border p-2"
                      >
                        <p className="text-sm font-medium truncate">
                          {item.type_name}
                        </p>
                        <CurrencyInput
                          value={item.unit_price}
                          onChange={(v) => handleItemPriceChange(index, v)}
                          disabled={!canEdit}
                          className="h-8"
                          placeholder="Số tiền"
                        />
                        <DateInput
                          value={item.start_date}
                          onChange={(v) => handleItemStartDateChange(index, v)}
                          disabled={!canEdit}
                          className="h-8"
                        />
                        <DateInput
                          value={item.end_date}
                          onChange={(v) => handleItemEndDateChange(index, v)}
                          disabled={!canEdit}
                          className="h-8"
                        />
                        {canEdit && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0 h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => handleRemoveItem(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}

                    {/* Total */}
                    <div className="flex justify-end pt-2 border-t">
                      <p className="text-sm font-semibold">
                        Tổng cộng:{' '}
                        <span className={voucherType === 'INCOME' ? 'text-green-600' : 'text-red-600'}>
                          {totalAmount.toLocaleString('vi-VN')} đ
                        </span>
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Cài đặt lặp lại — mirror Resident */}
              <div className="rounded-lg border border-zinc-200 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <FormLabel className="text-sm font-semibold">
                    Cài đặt lặp lại
                  </FormLabel>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <FormField
                    control={form.control}
                    name="repeat_cycle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Chu kỳ</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? 'NONE'}
                          disabled={!canEdit}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="NONE">Không lặp lại</SelectItem>
                            <SelectItem value="WEEK">Hàng tuần</SelectItem>
                            <SelectItem value="MONTH">Hàng tháng</SelectItem>
                            <SelectItem value="QUARTER">Hàng quý</SelectItem>
                            <SelectItem value="YEAR">Hàng năm</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="repeat_count"
                    render={({ field }) => {
                      const cycle = form.watch('repeat_cycle');
                      const inf = form.watch('repeat_infinity');
                      const disabled = !canEdit || cycle === 'NONE' || inf;
                      return (
                        <FormItem>
                          <FormLabel>Số lần lặp</FormLabel>
                          <FormControl>
                            <NumberInput
                              value={field.value}
                              onChange={field.onChange}
                              onBlur={field.onBlur}
                              name={field.name}
                              min={0}
                              disabled={disabled}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />

                  <FormField
                    control={form.control}
                    name="repeat_infinity"
                    render={({ field }) => {
                      const cycle = form.watch('repeat_cycle');
                      const disabled = !canEdit || cycle === 'NONE';
                      return (
                        <FormItem className="flex items-end justify-between rounded-md border p-2">
                          <FormLabel className="text-xs">Lặp vô hạn</FormLabel>
                          <FormControl>
                            <Switch
                              checked={!!field.value}
                              onCheckedChange={field.onChange}
                              disabled={disabled}
                            />
                          </FormControl>
                        </FormItem>
                      );
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Hệ thống sẽ tự động sinh phiếu con đến ngày hôm nay theo chu kỳ.
                  Bạn có thể chạy thủ công bằng nút <b>Sinh phiếu lặp lại</b>{' '}
                  trên thanh công cụ.
                </p>
              </div>

              {/* Đính kèm */}
              <FormField
                control={form.control}
                name="attachments"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Đính kèm</FormLabel>
                    <FormControl>
                      <AttachmentUpload
                        attachments={field.value ?? []}
                        onChange={field.onChange}
                        disabled={!canEdit}
                        userId={authUser?.id ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Action buttons */}
              <div
                className={
                  isMobile
                    ? "sticky bottom-0 -mx-4 -mb-4 px-4 py-3 bg-white border-t border-zinc-200 flex gap-2 items-center"
                    : "flex justify-end gap-3 pt-4"
                }
                style={
                  isMobile
                    ? { paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }
                    : undefined
                }
              >
                <Button
                  type="button"
                  variant="outline"
                  className={isMobile ? "flex-1" : ""}
                  onClick={() => onOpenChange(false)}
                >
                  {isViewing ? 'Đóng' : 'Huỷ bỏ'}
                </Button>
                {canEdit && (
                  <Button
                    type="submit"
                    disabled={isPending}
                    className={isMobile ? "flex-1" : ""}
                  >
                    {isPending ? 'Đang lưu...' : 'Lưu'}
                  </Button>
                )}
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Item selector dialog */}
      <IncomeExpenseItemSelector
        open={isItemSelectorOpen}
        onOpenChange={setIsItemSelectorOpen}
        voucherType={voucherType}
        onSelect={handleItemsSelected}
        selectedTypeIds={itemRows.map((r) => r.income_expense_type_id)}
      />
    </>
  );
};

export default IncomeExpenseForm;
