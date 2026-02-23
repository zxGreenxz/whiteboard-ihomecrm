import { useEffect } from 'react';
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
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  incomeExpenseTypeFormSchema,
  type IncomeExpenseTypeFormValues,
} from '@/lib/incomeExpenseValidation';
import {
  useCreateIncomeExpenseType,
  useUpdateIncomeExpenseType,
  type IncomeExpenseType,
} from '@/hooks/useIncomeExpenseTypes';

interface IncomeExpenseTypeFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type?: IncomeExpenseType | null;
}

const IncomeExpenseTypeForm = ({ open, onOpenChange, type }: IncomeExpenseTypeFormProps) => {
  const isEditing = !!type;
  const createType = useCreateIncomeExpenseType();
  const updateType = useUpdateIncomeExpenseType();

  const form = useForm<IncomeExpenseTypeFormValues>({
    resolver: zodResolver(incomeExpenseTypeFormSchema),
    defaultValues: {
      name: '',
      type: undefined,
      description: '',
      is_default: false,
    },
  });

  // Populate form when editing, reset when adding
  useEffect(() => {
    if (type && open) {
      form.reset({
        name: type.name,
        type: type.type,
        description: type.description ?? '',
        is_default: type.is_default ?? false,
      });
    } else if (!type && open) {
      form.reset({
        name: '',
        type: undefined,
        description: '',
        is_default: false,
      });
    }
  }, [type, open, form]);

  const onSubmit = async (data: IncomeExpenseTypeFormValues) => {
    try {
      if (isEditing) {
        await updateType.mutateAsync({
          id: type.id,
          updates: {
            name: data.name,
            type: data.type,
            description: data.description || null,
            is_default: data.is_default ?? false,
          },
        });
      } else {
        await createType.mutateAsync({
          name: data.name,
          type: data.type,
          description: data.description || null,
          is_default: data.is_default ?? false,
        });
      }
      onOpenChange(false);
    } catch {
      // Errors handled by mutation hooks (toast)
    }
  };

  const isPending = createType.isPending || updateType.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Sửa loại thu chi' : 'Thêm loại thu chi'}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên loại *</FormLabel>
                  <FormControl>
                    <Input placeholder="VD: Tiền thuê phòng" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Loại *</FormLabel>
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

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Mô tả loại thu chi..."
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
              name="is_default"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <FormLabel className="cursor-pointer">Mặc định</FormLabel>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

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
      </DialogContent>
    </Dialog>
  );
};

export default IncomeExpenseTypeForm;
