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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Plus, Trash2 } from 'lucide-react';
import {
  incomeExpenseFormSchema,
  type IncomeExpenseFormValues,
  canEditVoucher,
} from '@/lib/incomeExpenseValidation';
import {
  useCreateIncomeExpense,
  useUpdateIncomeExpense,
  type IncomeExpenseWithRelations,
} from '@/hooks/useIncomeExpenses';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { useTenantsLegacy } from '@/hooks/useTenants';
import type { IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';
import IncomeExpenseItemSelector from './IncomeExpenseItemSelector';

interface IncomeExpenseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher?: IncomeExpenseWithRelations | null;
  defaultType?: 'INCOME' | 'EXPENSE';
}

interface FormItemRow {
  income_expense_type_id: string;
  type_name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
}

const IncomeExpenseForm = ({
  open,
  onOpenChange,
  voucher,
  defaultType,
}: IncomeExpenseFormProps) => {
  const isEditing = !!voucher;
  const createMutation = useCreateIncomeExpense();
  const updateMutation = useUpdateIncomeExpense();

  // Cascade dropdown state
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | undefined>(undefined);
  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);

  // Item selector dialog
  const [isItemSelectorOpen, setIsItemSelectorOpen] = useState(false);

  // Item rows with type_name for display (not part of Zod schema)
  const [itemRows, setItemRows] = useState<FormItemRow[]>([]);

  // Cascade data hooks
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(selectedBuildingId);
  const { data: beds = [] } = useBeds(selectedRoomId);
  const { data: tenants = [] } = useTenantsLegacy();

  const form = useForm<IncomeExpenseFormValues>({
    resolver: zodResolver(incomeExpenseFormSchema),
    defaultValues: {
      type: defaultType ?? 'INCOME',
      name: '',
      building_id: '',
      room_id: null,
      bed_id: null,
      tenant_id: null,
      voucher_date: new Date().toISOString().split('T')[0],
      notes: '',
      items: [],
    },
  });

  const voucherType = form.watch('type');

  // Populate form when editing or reset when adding
  useEffect(() => {
    if (!open) return;

    if (voucher) {
      setSelectedBuildingId(voucher.building_id);
      setSelectedRoomId(voucher.room_id ?? undefined);

      form.reset({
        type: voucher.type,
        name: voucher.name,
        building_id: voucher.building_id,
        room_id: voucher.room_id ?? null,
        bed_id: voucher.bed_id ?? null,
        tenant_id: voucher.tenant_id ?? null,
        voucher_date: voucher.voucher_date,
        notes: voucher.notes ?? '',
        items: voucher.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
        })),
      });

      setItemRows(
        voucher.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          type_name: item.type_name,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
        }))
      );
    } else {
      setSelectedBuildingId(undefined);
      setSelectedRoomId(undefined);
      form.reset({
        type: defaultType ?? 'INCOME',
        name: '',
        building_id: '',
        room_id: null,
        bed_id: null,
        tenant_id: null,
        voucher_date: new Date().toISOString().split('T')[0],
        notes: '',
        items: [],
      });
      setItemRows([]);
    }
  }, [voucher, open, defaultType, form]);

  // Cascade: when building changes → clear room, bed, tenant
  const handleBuildingChange = (buildingId: string) => {
    setSelectedBuildingId(buildingId);
    setSelectedRoomId(undefined);
    form.setValue('building_id', buildingId);
    form.setValue('room_id', null);
    form.setValue('bed_id', null);
    form.setValue('tenant_id', null);
  };

  // Cascade: when room changes → clear bed, tenant
  const handleRoomChange = (roomId: string) => {
    const value = roomId === '__none__' ? null : roomId;
    setSelectedRoomId(value ?? undefined);
    form.setValue('room_id', value);
    form.setValue('bed_id', null);
    form.setValue('tenant_id', null);
  };

  const handleBedChange = (bedId: string) => {
    form.setValue('bed_id', bedId === '__none__' ? null : bedId);
  };

  const handleTenantChange = (tenantId: string) => {
    form.setValue('tenant_id', tenantId === '__none__' ? null : tenantId);
  };

  // Item selector callback
  const handleItemsSelected = (types: IncomeExpenseType[]) => {
    const existingIds = new Set(itemRows.map((r) => r.income_expense_type_id));
    const newRows: FormItemRow[] = [];

    for (const t of types) {
      if (!existingIds.has(t.id)) {
        newRows.push({
          income_expense_type_id: t.id,
          type_name: t.name,
          description: null,
          quantity: 1,
          unit_price: 0,
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
      })),
      { shouldValidate: form.formState.isSubmitted }
    );
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
      }
      onOpenChange(false);
    } catch {
      // Errors handled by mutation hooks (toast)
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const isApproved = voucher?.approval_status === 'APPROVED';
  const canEdit = !voucher || canEditVoucher(voucher.approval_status);

  const totalAmount = itemRows.reduce(
    (sum, item) => sum + item.quantity * item.unit_price,
    0
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isEditing ? 'Sửa phiếu thu/chi' : 'Thêm phiếu thu/chi'}
            </DialogTitle>
          </DialogHeader>

          {isApproved && (
            <p className="text-sm text-destructive">
              Phiếu đã được duyệt. Vui lòng bỏ duyệt trước khi sửa.
            </p>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Step 1: Voucher type radio */}
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại phiếu *</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="flex gap-4"
                        disabled={!canEdit}
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="INCOME" id="type-income" />
                          <Label htmlFor="type-income" className="cursor-pointer">
                            Phiếu thu
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="EXPENSE" id="type-expense" />
                          <Label htmlFor="type-expense" className="cursor-pointer">
                            Phiếu chi
                          </Label>
                        </div>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Step 2: Form fields */}
              {/* Building (required) */}
              <FormField
                control={form.control}
                name="building_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Căn hộ *</FormLabel>
                    <Select
                      onValueChange={handleBuildingChange}
                      value={field.value || ''}
                      disabled={!canEdit}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn căn hộ" />
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

              {/* Room (cascade from building) */}
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

              {/* Bed (cascade from room) */}
              <FormField
                control={form.control}
                name="bed_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Giường</FormLabel>
                    <Select
                      onValueChange={handleBedChange}
                      value={field.value ?? '__none__'}
                      disabled={!canEdit || !selectedRoomId}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn giường" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">-- Không chọn --</SelectItem>
                        {beds.map((b) => (
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

              {/* Tenant */}
              <FormField
                control={form.control}
                name="tenant_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Khách hàng</FormLabel>
                    <Select
                      onValueChange={handleTenantChange}
                      value={field.value ?? '__none__'}
                      disabled={!canEdit}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn khách hàng" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">-- Không chọn --</SelectItem>
                        {tenants.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.full_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Voucher name (required) */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {voucherType === 'EXPENSE' ? 'Tên phiếu chi' : 'Tên phiếu thu'} *
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="VD: Thu tiền phòng tháng 7"
                        {...field}
                        disabled={!canEdit}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Voucher date (required) */}
              <FormField
                control={form.control}
                name="voucher_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {voucherType === 'EXPENSE' ? 'Ngày chi' : 'Ngày thu'} *
                    </FormLabel>
                    <FormControl>
                      <Input type="date" {...field} disabled={!canEdit} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Notes */}
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ghi chú</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Ghi chú thêm..."
                        {...field}
                        value={field.value ?? ''}
                        disabled={!canEdit}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Step 3: Items */}
              <div className="space-y-3">
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
                    {itemRows.map((item, index) => (
                      <div
                        key={`${item.income_expense_type_id}-${index}`}
                        className="flex items-center gap-2 rounded-lg border p-3"
                      >
                        <div className="flex-1 min-w-0 space-y-2">
                          <p className="text-sm font-medium truncate">
                            {item.type_name}
                          </p>
                          <div className="flex items-center gap-2">
                            <div className="flex-1">
                              <label className="text-xs text-muted-foreground">
                                Số lượng
                              </label>
                              <Input
                                type="number"
                                min={1}
                                value={item.quantity}
                                onChange={(e) =>
                                  handleItemQuantityChange(
                                    index,
                                    parseInt(e.target.value) || 1
                                  )
                                }
                                disabled={!canEdit}
                                className="h-8"
                              />
                            </div>
                            <div className="flex-1">
                              <label className="text-xs text-muted-foreground">
                                Đơn giá
                              </label>
                              <Input
                                type="number"
                                min={0}
                                value={item.unit_price}
                                onChange={(e) =>
                                  handleItemPriceChange(
                                    index,
                                    parseFloat(e.target.value) || 0
                                  )
                                }
                                disabled={!canEdit}
                                className="h-8"
                              />
                            </div>
                            <div className="flex-1">
                              <label className="text-xs text-muted-foreground">
                                Thành tiền
                              </label>
                              <p className="text-sm font-medium h-8 flex items-center">
                                {(item.quantity * item.unit_price).toLocaleString('vi-VN')}
                              </p>
                            </div>
                          </div>
                        </div>
                        {canEdit && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0 text-destructive hover:text-destructive"
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

              {/* Action buttons */}
              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                {canEdit && (
                  <Button type="submit" disabled={isPending}>
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
