import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  incomeExpenseTypeFormSchema,
  type IncomeExpenseTypeFormValues,
} from '@/lib/incomeExpenseValidation';
import {
  useCreateIncomeExpenseType,
  type IncomeExpenseType,
} from '@/hooks/useIncomeExpenseTypes';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import CategoryCombobox from './CategoryCombobox';

interface IncomeExpenseTypeFormProps {
  defaultType?: 'income' | 'expense';
  onCreated?: (newType: IncomeExpenseType) => void;
  onCancel?: () => void;
}

const IncomeExpenseTypeForm = ({
  defaultType,
  onCreated,
  onCancel,
}: IncomeExpenseTypeFormProps) => {
  const createType = useCreateIncomeExpenseType();
  const { data: perms } = useMyPermissions();
  // Chỉ người có quyền xem/sửa hạng mục hạn chế mới được đánh dấu "hạn chế".
  const canManageRestricted = canUse(perms, 'income_expenses', 'restricted_view');
  // Khi form được nhúng vào dialog chọn hạng mục thu/chi, defaultType được
  // truyền sẵn → người dùng không cần (và không nên) đổi lại Thu/Chi.
  const lockType = !!defaultType;

  const form = useForm<IncomeExpenseTypeFormValues>({
    resolver: zodResolver(incomeExpenseTypeFormSchema),
    defaultValues: {
      name: '',
      type: defaultType ?? undefined,
      category: '',
      description: '',
      is_default: false,
      is_restricted: false,
      hide_in_report: false,
    },
  });

  useEffect(() => {
    form.reset({
      name: '',
      type: defaultType ?? undefined,
      category: '',
      description: '',
      is_default: false,
      is_restricted: false,
      hide_in_report: false,
    });
  }, [defaultType, form]);

  const onSubmit = async (data: IncomeExpenseTypeFormValues) => {
    try {
      const result = await createType.mutateAsync({
        name: data.name,
        type: data.type,
        category: data.category?.trim() ? data.category.trim() : null,
        description: data.description || null,
        is_default: data.is_default ?? false,
        is_restricted: canManageRestricted ? (data.is_restricted ?? false) : false,
        hide_in_report: data.hide_in_report ?? false,
      });
      form.reset();
      onCreated?.(result as unknown as IncomeExpenseType);
    } catch {
      // Errors handled by mutation hooks (toast)
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tên hạng mục *</FormLabel>
              <FormControl>
                <Input placeholder="VD: Vệ sinh máy lạnh" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {!lockType && (
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Loại Thu/Chi *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn loại" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="income">Thu</SelectItem>
                    <SelectItem value="expense">Chi</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="category"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nhóm (Loại) *</FormLabel>
              <FormControl>
                <CategoryCombobox
                  value={field.value ?? null}
                  onChange={(v) => field.onChange(v ?? '')}
                  filterType={defaultType}
                  placeholder="VD: Bảo trì máy lạnh"
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                Gom nhiều hạng mục vào cùng một nhóm để tổng hợp chi phí dễ
                hơn. Gõ tên mới để tạo nhóm mới.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Mô tả</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Mô tả loại thu chi..."
                  rows={2}
                  {...field}
                  value={field.value ?? ''}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {canManageRestricted && (
          <FormField
            control={form.control}
            name="is_restricted"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start gap-2 rounded-md border p-3">
                <FormControl>
                  <Checkbox
                    checked={!!field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                </FormControl>
                <div className="space-y-0.5 leading-tight">
                  <FormLabel className="cursor-pointer">Hạng mục hạn chế</FormLabel>
                  <p className="text-xs text-muted-foreground">
                    Chỉ người có quyền mới thấy hạng mục này và các phiếu thuộc
                    hạng mục — ẩn khỏi nhân viên khác.
                  </p>
                </div>
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="hide_in_report"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-2 rounded-md border p-3">
              <FormControl>
                <Checkbox
                  checked={!!field.value}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
              </FormControl>
              <div className="space-y-0.5 leading-tight">
                <FormLabel className="cursor-pointer">Hạng mục đặc biệt</FormLabel>
                <p className="text-xs text-muted-foreground">
                  Cho phép ẩn các dòng thuộc hạng mục này khỏi báo cáo Phân bổ
                  lợi nhuận (vd "Tiền nhà"). Bật/tắt hiển thị ngay trong báo cáo.
                </p>
              </div>
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-1">
          {onCancel && (
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Huỷ
            </Button>
          )}
          <Button type="submit" size="sm" disabled={createType.isPending}>
            {createType.isPending ? 'Đang lưu...' : 'Lưu'}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default IncomeExpenseTypeForm;
