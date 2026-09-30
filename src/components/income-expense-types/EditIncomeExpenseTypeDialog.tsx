import {recordWriteBlocked,recordWriteMessage} from '@/lib/recordWriteOutcome';
import {focusFirstError} from '@/lib/formErrors';
import { useEffect, useRef, useState } from 'react';
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
  useIncomeExpenseTypeCategories,
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
  const [blocked,setBlocked]=useState(false);
  const [deleteFailure,setDeleteFailure]=useState('');
  const busy=useRef(false);
  const draftKey=useRef<string|null>(null);
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
    if(open && type) {
      if(draftKey.current===type.id && (form.formState.isDirty || form.formState.errors.root?.server || blocked || deleteFailure)) return;
      draftKey.current=type.id;setBlocked(false);setDeleteFailure('');
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
  const categoriesQuery=useIncomeExpenseTypeCategories(watchedType);
  const sourceBlocked=categoriesQuery.isLoading || categoriesQuery.isError;

  const onSubmit = async (data: IncomeExpenseTypeFormValues) => {
    if(!type || blocked || busy.current || updateType.isPending || deleteType.isPending || sourceBlocked) return;
    busy.current=true;form.clearErrors('root.server');
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
    } catch(error) {
      setBlocked(recordWriteBlocked(error));
      form.setError('root.server',{type:'server',message:recordWriteMessage(error,'cập nhật loại thu chi')});
    } finally {busy.current=false;}
  };

  const handleDelete = async () => {
    if(!type || blocked || busy.current || updateType.isPending || deleteType.isPending) return;
    busy.current=true;
    try {
      await deleteType.mutateAsync(type.id);
      onDeleted?.(type.id);
      setConfirmDelete(false);
      onOpenChange(false);
    } catch(error) {
      setBlocked(recordWriteBlocked(error));
      setDeleteFailure(recordWriteMessage(error,'xoá loại thu chi'));
    } finally {busy.current=false;}
  };

  return (
    <>
      <Dialog open={open} onOpenChange={next=>{if(!busy.current && !updateType.isPending && !deleteType.isPending) onOpenChange(next);}}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Sửa hạng mục thu chi</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit,errors=>{void focusFirstError(errors);})}
              className="space-y-3"
            >
              {form.formState.errors.root?.server?.message && <p role="alert" className="text-destructive">{form.formState.errors.root.server.message}</p>}
              {sourceBlocked && <div role="alert">Chưa tải đủ nhóm loại thu chi. <Button type="button" variant="outline" onClick={()=>{void categoriesQuery.refetch();}}>Tải lại dữ liệu</Button></div>}
              <fieldset disabled={updateType.isPending || deleteType.isPending || blocked || sourceBlocked} className="space-y-3">
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
                  disabled={deleteType.isPending || blocked}
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
                    disabled={updateType.isPending || blocked || sourceBlocked}
                  >
                    {updateType.isPending ? 'Đang lưu...' : 'Lưu'}
                  </Button>
                </div>
              </div>
              </fieldset>
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
            {deleteFailure && <p role="alert" className="text-destructive">{deleteFailure}</p>}
            <AlertDialogAction
              onClick={event=>{event.preventDefault();void handleDelete();}}
              disabled={deleteType.isPending || blocked}
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
