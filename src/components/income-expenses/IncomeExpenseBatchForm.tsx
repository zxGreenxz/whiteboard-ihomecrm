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
import { Plus, Trash2, ArrowUp, ArrowDown, Layers } from 'lucide-react';
import {
  incomeExpenseBatchFormSchema,
  type IncomeExpenseBatchFormValues,
} from '@/lib/incomeExpenseValidation';
import { useCreateIncomeExpenseBatch } from '@/hooks/useIncomeExpenses';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useAccounts } from '@/hooks/useAccounts';
import { useIncomeExpenseTypes, type IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';
import IncomeExpenseItemSelector from './IncomeExpenseItemSelector';
import AttachmentUpload from './AttachmentUpload';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/use-mobile';

interface BatchItemRow {
  building_id: string;
  room_id: string | null;
  income_expense_type_id: string;
  type_name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  start_date: string;
  end_date: string;
}

interface IncomeExpenseBatchFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: 'INCOME' | 'EXPENSE';
}

// Sub-component cho mỗi row hạng mục — có cascade rooms riêng theo building_id của row
const ItemRow = ({
  index,
  item,
  onChange,
  onRemove,
  buildings,
}: {
  index: number;
  item: BatchItemRow;
  onChange: (idx: number, patch: Partial<BatchItemRow>) => void;
  onRemove: (idx: number) => void;
  buildings: Array<{ id: string; name: string }>;
}) => {
  const { data: rooms = [] } = useRooms(item.building_id || undefined);

  return (
    <div className="rounded-lg border p-3 space-y-2 bg-zinc-50/50">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {index + 1}. {item.type_name || '(Chưa chọn loại)'}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 h-7 w-7 text-destructive hover:text-destructive"
          onClick={() => onRemove(index)}
          title="Xoá hạng mục"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="col-span-2 sm:col-span-1">
          <label className="text-[11px] text-muted-foreground font-medium">
            Tòa nhà *
          </label>
          <Select
            value={item.building_id || ''}
            onValueChange={(v) =>
              onChange(index, { building_id: v, room_id: null })
            }
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Chọn tòa" />
            </SelectTrigger>
            <SelectContent>
              {buildings.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="col-span-2 sm:col-span-1">
          <label className="text-[11px] text-muted-foreground font-medium">
            Phòng
          </label>
          <Select
            value={item.room_id ?? '__none__'}
            onValueChange={(v) =>
              onChange(index, { room_id: v === '__none__' ? null : v })
            }
            disabled={!item.building_id}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Chọn phòng" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">-- Không chọn --</SelectItem>
              {rooms.map((r: any) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-[11px] text-muted-foreground font-medium">
            Số tiền *
          </label>
          <CurrencyInput
            value={item.unit_price}
            onChange={(v) => onChange(index, { unit_price: v })}
            className="h-8 text-sm"
            placeholder="0"
          />
        </div>

        <div className="grid grid-cols-2 gap-1">
          <div>
            <label className="text-[11px] text-muted-foreground font-medium">
              Từ ngày
            </label>
            <DateInput
              value={item.start_date}
              onChange={(v) => onChange(index, { start_date: v })}
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground font-medium">
              Đến
            </label>
            <DateInput
              value={item.end_date}
              onChange={(v) => onChange(index, { end_date: v })}
              className="h-8 text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const IncomeExpenseBatchForm = ({
  open,
  onOpenChange,
  defaultType,
}: IncomeExpenseBatchFormProps) => {
  const createMutation = useCreateIncomeExpenseBatch();
  const { data: authUser } = useAuth();
  const isMobile = useIsMobile();

  const [isItemSelectorOpen, setIsItemSelectorOpen] = useState(false);
  const [itemRows, setItemRows] = useState<BatchItemRow[]>([]);

  const { data: buildings = [] } = useBuildings({ includeVirtual: true });
  const { data: accounts = [] } = useAccounts();
  const { data: incomeTypes = [] } = useIncomeExpenseTypes('income');
  const { data: expenseTypes = [] } = useIncomeExpenseTypes('expense');

  // Hạng mục "cọc" (is_deposit) → tự suy mặc định cờ "Hạch toán KQKD".
  const depositTypeIds = new Set(
    [...incomeTypes, ...expenseTypes]
      .filter((t) => t.is_deposit)
      .map((t) => t.id),
  );
  const hasDepositItem = itemRows.some((r) =>
    depositTypeIds.has(r.income_expense_type_id),
  );
  const autoBusinessResult = !hasDepositItem;

  const form = useForm<IncomeExpenseBatchFormValues>({
    resolver: zodResolver(incomeExpenseBatchFormSchema),
    defaultValues: {
      type: defaultType ?? 'EXPENSE',
      shared_name: '',
      account_id: '',
      voucher_date: new Date().toISOString().split('T')[0],
      payer_name: '',
      business_result_accounting: null,
      attachments: [],
      notes: '',
      items: [],
    },
  });

  const voucherType = form.watch('type');

  // Reset khi mở dialog hoặc đổi default type
  useEffect(() => {
    if (!open) return;
    form.reset({
      type: defaultType ?? 'EXPENSE',
      shared_name: '',
      account_id: '',
      voucher_date: new Date().toISOString().split('T')[0],
      payer_name: '',
      business_result_accounting: null,
      attachments: [],
      notes: '',
      items: [],
    });
    setItemRows([]);
  }, [open, defaultType, form]);

  // Khi đổi loại phiếu (INCOME ↔ EXPENSE) → reset items vì danh mục khác nhau
  useEffect(() => {
    if (open && form.formState.isDirty) {
      setItemRows([]);
      form.setValue('items', [], { shouldValidate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voucherType]);

  const syncToForm = (rows: BatchItemRow[]) => {
    form.setValue(
      'items',
      rows.map((r) => ({
        building_id: r.building_id,
        room_id: r.room_id,
        income_expense_type_id: r.income_expense_type_id,
        type_name: r.type_name,
        description: r.description,
        quantity: r.quantity,
        unit_price: r.unit_price,
        start_date: r.start_date,
        end_date: r.end_date,
      })),
      { shouldValidate: form.formState.isSubmitted }
    );
  };

  // Item selector: thêm 1 hạng mục cho MỖI loại được chọn (mỗi hạng mục = 1 phiếu).
  // Nếu chọn lại loại đã có, vẫn cho thêm dòng mới (vì có thể vệ sinh máy lạnh ở 4 nhà).
  const handleItemsSelected = (types: IncomeExpenseType[]) => {
    const today = new Date().toISOString().split('T')[0];
    const newRows: BatchItemRow[] = types.map((t) => ({
      building_id: '',
      room_id: null,
      income_expense_type_id: t.id,
      type_name: t.name,
      description: null,
      quantity: 1,
      unit_price: 0,
      start_date: today,
      end_date: today,
    }));
    const merged = [...itemRows, ...newRows];
    setItemRows(merged);
    syncToForm(merged);
  };

  const handleRowChange = (idx: number, patch: Partial<BatchItemRow>) => {
    const updated = [...itemRows];
    updated[idx] = { ...updated[idx], ...patch };
    setItemRows(updated);
    syncToForm(updated);
  };

  const handleRowRemove = (idx: number) => {
    const updated = itemRows.filter((_, i) => i !== idx);
    setItemRows(updated);
    syncToForm(updated);
  };

  const onSubmit = async (data: IncomeExpenseBatchFormValues) => {
    try {
      await createMutation.mutateAsync(data);
      onOpenChange(false);
    } catch {
      // toast đã hiển thị trong hook
    }
  };

  const isPending = createMutation.isPending;
  const totalAmount = itemRows.reduce(
    (sum, r) => sum + r.quantity * r.unit_price,
    0
  );
  const submitLabel = isPending
    ? 'Đang lưu...'
    : `Lưu ${itemRows.length || 0} phiếu`;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            isMobile
              ? 'max-w-full w-full h-[100dvh] !top-0 !left-0 !translate-x-0 !translate-y-0 rounded-none p-4 overflow-y-auto'
              : 'sm:max-w-[860px] max-h-[90vh] overflow-y-auto'
          }
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary" />
              THÊM PHIẾU THU/CHI TỔNG
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Mỗi hạng mục bên dưới sẽ tạo thành 1 phiếu lẻ riêng cho từng tòa
              nhà, dùng chung sổ quỹ, ngày, người nhận và ảnh đính kèm.
            </p>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Tabs loại phiếu */}
              <Tabs
                value={form.watch('type')}
                onValueChange={(v) =>
                  form.setValue('type', v as 'INCOME' | 'EXPENSE')
                }
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger
                    value="INCOME"
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <ArrowUp className="h-4 w-4 mr-1" />
                    Phiếu thu
                  </TabsTrigger>
                  <TabsTrigger
                    value="EXPENSE"
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <ArrowDown className="h-4 w-4 mr-1" />
                    Phiếu chi
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {/* Metadata chung */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="account_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sổ quỹ *</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || ''}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn sổ quỹ" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {accounts.map((a: any) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                              {a.bank_name ? ` (${a.bank_name})` : ''}
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
                  name="voucher_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {voucherType === 'EXPENSE'
                          ? 'Ngày thực chi'
                          : 'Ngày thực thu'}{' '}
                        *
                      </FormLabel>
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="payer_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {voucherType === 'EXPENSE'
                          ? 'Tên người nhận'
                          : 'Tên người nộp'}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={
                            voucherType === 'EXPENSE'
                              ? 'VD: Anh Nam (thợ vệ sinh)'
                              : 'VD: Khách thuê tổng hợp'
                          }
                          {...field}
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="business_result_accounting"
                  render={({ field }) => {
                    const isAuto = field.value === null || field.value === undefined;
                    const effective = isAuto ? autoBusinessResult : !!field.value;
                    return (
                      <FormItem className="flex items-end justify-between rounded-lg border p-2 h-[62px] mt-auto">
                        <FormLabel
                          className="text-sm font-medium"
                          title={
                            isAuto
                              ? hasDepositItem
                                ? 'Tự động: có hạng mục cọc → không tính lợi nhuận'
                                : 'Tự động: tính vào lợi nhuận'
                              : 'Override tay'
                          }
                        >
                          Hạch toán KQKD?{isAuto ? ' (tự động)' : ''}
                        </FormLabel>
                        <FormControl>
                          <Switch
                            checked={effective}
                            onCheckedChange={(v) => field.onChange(v)}
                          />
                        </FormControl>
                      </FormItem>
                    );
                  }}
                />
              </div>

              <FormField
                control={form.control}
                name="shared_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tên phiếu (chung) *</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder="VD: Vệ sinh máy lạnh + sửa máy giặt T5/2026"
                        {...field}
                      />
                    </FormControl>
                    <p className="text-[11px] text-muted-foreground">
                      Tên phiếu con = tên này + " - " + tên loại hạng mục.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Hạng mục */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <FormLabel className="flex items-center gap-2">
                    Hạng mục
                    {itemRows.length > 0 && (
                      <span className="text-xs text-muted-foreground font-normal">
                        ({itemRows.length} phiếu sẽ được tạo)
                      </span>
                    )}
                  </FormLabel>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsItemSelectorOpen(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Thêm hạng mục
                  </Button>
                </div>

                {form.formState.errors.items?.message && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.items.message}
                  </p>
                )}

                {itemRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center border rounded-lg">
                    Chưa có hạng mục nào. Ấn "Thêm hạng mục" để bắt đầu.
                    <br />
                    <span className="text-[11px]">
                      Mỗi hạng mục sẽ tạo thành 1 phiếu lẻ cho 1 tòa nhà.
                    </span>
                  </p>
                ) : (
                  <div className="space-y-2">
                    {itemRows.map((item, index) => (
                      <ItemRow
                        key={`${item.income_expense_type_id}-${index}`}
                        index={index}
                        item={item}
                        onChange={handleRowChange}
                        onRemove={handleRowRemove}
                        buildings={buildings as any}
                      />
                    ))}

                    {/* Tổng */}
                    <div className="flex justify-end pt-2 border-t">
                      <p className="text-sm font-semibold">
                        Tổng cộng:{' '}
                        <span
                          className={
                            voucherType === 'INCOME'
                              ? 'text-green-600'
                              : 'text-red-600'
                          }
                        >
                          {totalAmount.toLocaleString('vi-VN')} đ
                        </span>
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Đính kèm */}
              <FormField
                control={form.control}
                name="attachments"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Đính kèm (dùng chung cho tất cả phiếu trong đợt)
                    </FormLabel>
                    <FormControl>
                      <AttachmentUpload
                        attachments={field.value ?? []}
                        onChange={field.onChange}
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
                    ? 'sticky bottom-0 -mx-4 -mb-4 px-4 py-3 bg-white border-t border-zinc-200 flex gap-2 items-center'
                    : 'flex justify-end gap-3 pt-4'
                }
                style={
                  isMobile
                    ? {
                        paddingBottom:
                          'calc(12px + env(safe-area-inset-bottom, 0px))',
                      }
                    : undefined
                }
              >
                <Button
                  type="button"
                  variant="outline"
                  className={isMobile ? 'flex-1' : ''}
                  onClick={() => onOpenChange(false)}
                >
                  Huỷ bỏ
                </Button>
                <Button
                  type="submit"
                  disabled={isPending || itemRows.length === 0}
                  className={isMobile ? 'flex-1' : ''}
                >
                  {submitLabel}
                </Button>
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
        // Truyền [] để selector luôn cho phép thêm lại loại đã chọn
        // (vì batch có thể có nhiều phiếu cùng loại ở các tòa khác nhau)
        selectedTypeIds={[]}
      />
    </>
  );
};

export default IncomeExpenseBatchForm;
