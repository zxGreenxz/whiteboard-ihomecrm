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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  incomeExpenseTypeFormSchema,
  type IncomeExpenseTypeFormValues,
} from '@/lib/incomeExpenseValidation';
import {
  useDeleteIncomeExpenseType,
  useUpdateIncomeExpenseType,
  type IncomeExpenseType,
} from '@/hooks/useIncomeExpenseTypes';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import CategoryCombobox from './CategoryCombobox';

interface EditIncomeExpenseTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: IncomeExpenseType | null;
  /** Gọi sau khi xoá thành công để parent có thể bỏ id khỏi selectedTypeIds. */
  onDeleted?: (deletedId: string) => void;
}

const EditIncomeExpenseTypeDialog = ({
  open,
  onOpenChange,
  type,
  onDeleted,
}: EditIncomeExpenseTypeDialogProps) => {
  const updateType = useUpdateIncomeExpenseType();
  const deleteType = useDeleteIncomeExpenseType();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: perms } = useMyPermissions();
  // Chỉ người có quyền xem/sửa hạng mục hạn chế mới được đánh dấu "hạn chế".
  const canManageRestricted = canUse(perms, 'income_expenses', 'restricted_view');

  const form = useForm<IncomeExpenseTypeFormValues>({
    resolver: zodResolver(incomeExpenseTypeFormSchema),
    defaultValues: {
      name: '',
      type: 'expense',
      category: '',
      description: '',
      is_default: false,
      is_restricted: false,
      hide_in_report: false,
    },
  });

  useEffect(() => {
    if (open && type) {
      form.reset({
        name: type.name,
        type: type.type,
        category: type.category ?? '',
        description: type.description ?? '',
        is_default: type.is_default ?? false,
        is_restricted: type.is_restricted ?? false,
        hide_in_report: type.hide_in_report ?? false,
      });
    }
  }, [open, type, form]);

  const watchedType = form.watch('type');

  const onSubmit = async (data: IncomeExpenseTypeFormValues) => {
    if (!type) return;
    try {
      await updateType.mutateAsync({
        id: type.id,
        updates: {
          name: data.name,
          type: data.type,
          category: data.category?.trim() ? data.category.trim() : null,
          description: data.description || null,
          is_default: data.is_default ?? false,
          // Chỉ ghi is_restricted khi có quyền — tránh staff vô tình gỡ cờ.
          ...(canManageRestricted ? { is_restricted: data.is_restricted ?? false } : {}),
          hide_in_report: data.hide_in_report ?? false,
        },
      });
      onOpenChange(false);
    } catch {
      // toast handled in mutation
    }
  };

  const handleDelete = async () => {
    if (!type) return;
    try {
      await deleteType.mutateAsync(type.id);
      onDeleted?.(type.id);
      setConfirmDelete(false);
      onOpenChange(false);
    } catch {
      // toast handled in mutation
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Sửa hạng mục thu chi</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-3"
            >
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

              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại Thu/Chi *</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
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
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nhóm (Loại) *</FormLabel>
                    <FormControl>
                      <CategoryCombobox
                        value={field.value ?? null}
                        onChange={(v) => field.onChange(v ?? '')}
                        filterType={watchedType}
                        placeholder="VD: Bảo trì máy lạnh"
                      />
                    </FormControl>
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
                        <FormLabel className="cursor-pointer">
                          Hạng mục hạn chế
                        </FormLabel>
                        <p className="text-xs text-muted-foreground">
                          Chỉ người có quyền mới thấy hạng mục này và các phiếu
                          thuộc hạng mục — ẩn khỏi nhân viên khác.
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
                      <FormLabel className="cursor-pointer">
                        Hạng mục đặc biệt
                      </FormLabel>
                      <p className="text-xs text-muted-foreground">
                        Cho phép ẩn các dòng thuộc hạng mục này khỏi báo cáo
                        Phân bổ lợi nhuận (vd "Tiền nhà").
                      </p>
                    </div>
                  </FormItem>
                )}
              />

              <div className="flex items-center justify-between pt-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleteType.isPending}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Xoá
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                  >
                    Huỷ
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={updateType.isPending}
                  >
                    {updateType.isPending ? 'Đang lưu...' : 'Lưu'}
                  </Button>
                </div>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá hạng mục?</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc muốn xoá hạng mục "{type?.name}"? Hạng mục đang
              được dùng trong phiếu thu/chi sẽ không thể xoá.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteType.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteType.isPending ? 'Đang xoá...' : 'Xoá'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default EditIncomeExpenseTypeDialog;
