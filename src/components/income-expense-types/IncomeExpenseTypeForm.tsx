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
    },
  });

  useEffect(() => {
    form.reset({
      name: '',
      type: defaultType ?? undefined,
      category: '',
      description: '',
      is_default: false,
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
