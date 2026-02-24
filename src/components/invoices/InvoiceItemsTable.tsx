import { useFieldArray, Control, UseFormRegister, UseFormWatch, UseFormSetValue, FieldErrors } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { InvoiceFormData, InvoiceItemType } from '@/types/invoice';

interface InvoiceItemsTableProps {
  control: Control<InvoiceFormData>;
  register: UseFormRegister<InvoiceFormData>;
  watch: UseFormWatch<InvoiceFormData>;
  setValue: UseFormSetValue<InvoiceFormData>;
  errors?: FieldErrors<InvoiceFormData>;
}

const ITEM_TYPE_LABELS: Record<InvoiceItemType, string> = {
  RENT: 'Tiền thuê',
  SERVICE: 'Dịch vụ',
  PENALTY: 'Phạt',
  DISCOUNT: 'Giảm giá',
  OTHER: 'Khác',
};

const DEFAULT_ITEM: InvoiceFormData['items'][number] = {
  type: 'SERVICE',
  description: '',
  unit_price: 0,
  quantity: 1,
  coefficient: 1,
  previous_reading: null,
  current_reading: null,
  from_date: null,
  to_date: null,
  sort_order: 0,
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(amount));

const InvoiceItemsTable = ({ control, register, watch, setValue, errors }: InvoiceItemsTableProps) => {
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const watchedItems = watch('items');

  const handleAddItem = () => {
    append({ ...DEFAULT_ITEM, sort_order: fields.length });
  };

  const handleTypeChange = (index: number, value: string) => {
    setValue(`items.${index}.type`, value as InvoiceItemType);
  };

  /** When current/previous reading changes, auto-calc quantity for SERVICE items with readings */
  const handleReadingChange = (index: number) => {
    const item = watchedItems[index];
    if (!item) return;
    const prev = item.previous_reading ?? 0;
    const curr = item.current_reading ?? 0;
    if (curr >= prev) {
      setValue(`items.${index}.quantity`, curr - prev);
    }
  };

  const computeAmount = (index: number): number => {
    const item = watchedItems?.[index];
    if (!item) return 0;
    return item.unit_price * item.quantity * item.coefficient;
  };

  const hasMeterReading = (index: number): boolean => {
    const item = watchedItems?.[index];
    if (!item) return false;
    return (
      item.type === 'SERVICE' &&
      (item.previous_reading != null || item.current_reading != null)
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Dịch vụ & Phí</h3>
        <Button type="button" variant="outline" size="sm" onClick={handleAddItem}>
          <Plus className="h-4 w-4 mr-1" />
          Thêm dòng
        </Button>
      </div>

      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">Loại</TableHead>
              <TableHead className="min-w-[160px]">Dịch vụ</TableHead>
              <TableHead className="w-[100px]">Đơn giá</TableHead>
              <TableHead className="w-[80px]">Chỉ số cũ</TableHead>
              <TableHead className="w-[80px]">Chỉ số mới</TableHead>
              <TableHead className="w-[70px]">Số lượng</TableHead>
              <TableHead className="w-[70px]">Hệ số</TableHead>
              <TableHead className="w-[110px]">Từ ngày</TableHead>
              <TableHead className="w-[110px]">Đến ngày</TableHead>
              <TableHead className="w-[110px] text-right">Thành tiền</TableHead>
              <TableHead className="w-[40px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-muted-foreground py-6">
                  Chưa có dòng dịch vụ nào. Ấn "Thêm dòng" để bắt đầu.
                </TableCell>
              </TableRow>
            )}
            {fields.map((field, index) => {
              const showReadings = hasMeterReading(index);
              return (
                <TableRow key={field.id}>
                  {/* Loại */}
                  <TableCell className="p-2">
                    <Select
                      value={watchedItems[index]?.type}
                      onValueChange={(v) => handleTypeChange(index, v)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(ITEM_TYPE_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  {/* Dịch vụ (description) */}
                  <TableCell className="p-2">
                    <Input
                      className="h-8 text-xs"
                      placeholder="Tên dịch vụ"
                      {...register(`items.${index}.description`)}
                    />
                    {errors?.items?.[index]?.description && (
                      <p className="text-xs text-red-500 mt-1">
                        {errors.items[index].description?.message}
                      </p>
                    )}
                  </TableCell>

                  {/* Đơn giá */}
                  <TableCell className="p-2">
                    <Input
                      className="h-8 text-xs"
                      type="number"
                      min={0}
                      {...register(`items.${index}.unit_price`, { valueAsNumber: true })}
                    />
                  </TableCell>

                  {/* Chỉ số cũ */}
                  <TableCell className="p-2">
                    {showReadings ? (
                      <Input
                        className="h-8 text-xs"
                        type="number"
                        {...register(`items.${index}.previous_reading`, { valueAsNumber: true })}
                        onBlur={() => handleReadingChange(index)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Chỉ số mới */}
                  <TableCell className="p-2">
                    {showReadings ? (
                      <Input
                        className="h-8 text-xs"
                        type="number"
                        {...register(`items.${index}.current_reading`, { valueAsNumber: true })}
                        onBlur={() => handleReadingChange(index)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Số lượng */}
                  <TableCell className="p-2">
                    <Input
                      className="h-8 text-xs"
                      type="number"
                      min={0}
                      step="0.01"
                      {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                      readOnly={showReadings}
                    />
                  </TableCell>

                  {/* Hệ số */}
                  <TableCell className="p-2">
                    <Input
                      className="h-8 text-xs"
                      type="number"
                      min={0}
                      step="0.01"
                      {...register(`items.${index}.coefficient`, { valueAsNumber: true })}
                    />
                  </TableCell>

                  {/* Từ ngày */}
                  <TableCell className="p-2">
                    <Input
                      className="h-8 text-xs"
                      type="date"
                      {...register(`items.${index}.from_date`)}
                    />
                  </TableCell>

                  {/* Đến ngày */}
                  <TableCell className="p-2">
                    <Input
                      className="h-8 text-xs"
                      type="date"
                      {...register(`items.${index}.to_date`)}
                    />
                  </TableCell>

                  {/* Thành tiền */}
                  <TableCell className="p-2 text-right text-xs font-medium">
                    {formatCurrency(computeAmount(index))}
                  </TableCell>

                  {/* Xoá */}
                  <TableCell className="p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {errors?.items?.message && (
        <p className="text-sm text-red-500">{errors.items.message}</p>
      )}
    </div>
  );
};

export default InvoiceItemsTable;
