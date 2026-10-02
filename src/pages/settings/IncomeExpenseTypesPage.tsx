import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import MainLayout from '@/components/layout/MainLayout';
import IncomeExpenseTypeList from '@/components/income-expense-types/IncomeExpenseTypeList';
import {
  useIncomeExpenseTypes,
  useIncomeExpenseTypeCategories,
  useCreateIncomeExpenseType,
  useUpdateIncomeExpenseType,
  useDeleteIncomeExpenseType,
  type IncomeExpenseType,
} from '@/hooks/useIncomeExpenseTypes';
import {
  incomeExpenseTypeFormSchema,
  type IncomeExpenseTypeFormValues,
} from '@/lib/incomeExpenseValidation';
import { Button } from '@/components/ui/button';
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
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus } from 'lucide-react';
import CategoryCombobox from '@/components/income-expense-types/CategoryCombobox';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { focusFirstError } from '@/lib/formErrors';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';

export default function IncomeExpenseTypesPage() {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingType, setEditingType] = useState<IncomeExpenseType | null>(null);
  const [deletingTypeId, setDeletingTypeId] = useState<string | null>(null);

  const typesQuery = useIncomeExpenseTypes();
  const { data: types, isLoading } = typesQuery;
  const createType = useCreateIncomeExpenseType();
  const updateType = useUpdateIncomeExpenseType();
  const deleteType = useDeleteIncomeExpenseType();

  const isEditing = !!editingType;
  const [blocked,setBlocked]=useState(false);
  const [deleteFailures,setDeleteFailures]=useState<Record<string,{message:string;blocked:boolean}>>({});
  const busy=useRef(false);
  const draftKey=useRef<string|null>(null);

  const form = useForm<IncomeExpenseTypeFormValues>({
    resolver: zodResolver(incomeExpenseTypeFormSchema),
    defaultValues: {
      name: '',
      type: undefined,
      category: '',
      description: '',
      is_default: false,
      hide_in_report: false,
    },
  });

  const watchedType = form.watch('type');
  const categoriesQuery=useIncomeExpenseTypeCategories(watchedType);
  const sourceBlocked=categoriesQuery.isLoading || categoriesQuery.isError;

  useEffect(() => {
    if(!isFormOpen) return;
    const key=editingType?.id ?? 'new';
    if(draftKey.current===key && (form.formState.isDirty || form.formState.errors.root?.server || blocked)) return;
    draftKey.current=key;setBlocked(false);
    if (editingType && isFormOpen) {
      form.reset({
        name: editingType.name,
        type: editingType.type,
        category: editingType.category ?? '',
        description: editingType.description ?? '',
        is_default: editingType.is_default ?? false,
        hide_in_report: editingType.hide_in_report ?? false,
      });
    } else if (!editingType && isFormOpen) {
      form.reset({
        name: '',
        type: undefined,
        category: '',
        description: '',
        is_default: false,
        hide_in_report: false,
      });
    }
  }, [editingType, isFormOpen, form]);

  const onSubmit = async (data: IncomeExpenseTypeFormValues) => {
    if(blocked || busy.current || createType.isPending || updateType.isPending || sourceBlocked) return;
    busy.current=true;form.clearErrors('root.server');
    try {
      const normalizedCategory = data.category?.trim()
        ? data.category.trim()
        : null;
      if (isEditing) {
        await updateType.mutateAsync({
          id: editingType.id,
          updates: {
            name: data.name,
            type: data.type,
            category: normalizedCategory,
            description: data.description || null,
            is_default: data.is_default ?? false,
            hide_in_report: data.hide_in_report ?? false,
          },
        });
      } else {
        await createType.mutateAsync({
          name: data.name,
          type: data.type,
          category: normalizedCategory,
          description: data.description || null,
          is_default: data.is_default ?? false,
          hide_in_report: data.hide_in_report ?? false,
        });
      }
      draftKey.current=null;form.reset();setIsFormOpen(false);setEditingType(null);
    } catch (error) {
      setBlocked(recordWriteBlocked(error));
      form.setError('root.server',{type:'server',message:recordWriteMessage(error,'lưu loại thu chi')});
    } finally {busy.current=false;}
  };

  const isPending = createType.isPending || updateType.isPending;

  const handleEdit = (type: IncomeExpenseType) => {
    setEditingType(type);
    setIsFormOpen(true);
  };

  const handleDelete = (typeId: string) => {
    setDeletingTypeId(typeId);
  };

  const confirmDelete = async () => {
    if(!deletingTypeId || busy.current || deleteType.isPending || deleteFailures[deletingTypeId]?.blocked) return;
    busy.current=true;
    try {await deleteType.mutateAsync(deletingTypeId);setDeletingTypeId(null);}
    catch(error) {setDeleteFailures(previous=>({...previous,[deletingTypeId]:{message:recordWriteMessage(error,'xoá loại thu chi'),blocked:recordWriteBlocked(error)}}));}
    finally {busy.current=false;}
  };

  const handleFormClose = (open: boolean) => {
    if(busy.current || isPending) return;
    setIsFormOpen(open);
    if (!open) setEditingType(null);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => { setEditingType(null); setIsFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm loại
          </Button>
        </div>

        {/* Type List */}
        {/* Thanh công cụ hiện ngay; chỉ danh sách chờ dữ liệu (chủ chốt 02/10/2026). */}
        <QueryRegion label="danh sách loại thu chi" queries={[typesQuery]} skeleton="table" rows={8}>
        <IncomeExpenseTypeList
          types={types || []}
          isLoading={isLoading}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
        </QueryRegion>

        {/* Type Form Dialog */}
        <Dialog open={isFormOpen} onOpenChange={handleFormClose}>
          <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>
                {isEditing ? 'Sửa loại thu chi' : 'Thêm loại thu chi'}
              </DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
                {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
                {sourceBlocked && <div role="alert">Chưa tải đủ nhóm loại thu chi. <Button type="button" variant="outline" onClick={()=>{void categoriesQuery.refetch();}}>Tải lại dữ liệu</Button></div>}
                <fieldset disabled={isPending || blocked || sourceBlocked} className="space-y-4">
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
                      <p className="text-xs text-muted-foreground">
                        Gom nhiều hạng mục vào cùng một nhóm để tổng hợp chi
                        phí dễ hơn. Gõ tên mới để tạo nhóm mới.
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
                <FormField
                  control={form.control}
                  name="hide_in_report"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5 pr-3 leading-tight">
                        <FormLabel className="cursor-pointer">Hạng mục đặc biệt</FormLabel>
                        <p className="text-xs text-muted-foreground">
                          Cho phép ẩn các dòng thuộc hạng mục này khỏi báo cáo
                          Phân bổ lợi nhuận (vd "Tiền nhà").
                        </p>
                      </div>
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
                    onClick={() => handleFormClose(false)}
                  >
                    Hủy
                  </Button>
                  <Button type="submit" disabled={isPending || blocked || sourceBlocked}>
                    {isPending ? 'Đang lưu...' : 'Lưu'}
                  </Button>
                </div>
                </fieldset>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog
          open={!!deletingTypeId}
          onOpenChange={(open) => { if (!open && !busy.current && !deleteType.isPending) setDeletingTypeId(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
              <AlertDialogDescription>
                Bạn đang thực hiện thao tác xoá loại thu chi. Bạn có chắc chắn muốn xoá không?
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deletingTypeId && deleteFailures[deletingTypeId] && <p role="alert" className="text-destructive">{deleteFailures[deletingTypeId].message}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel>Hủy</AlertDialogCancel>
              <Button variant="destructive"
                onClick={() => { void confirmDelete(); }}
                disabled={deleteType.isPending || !!(deletingTypeId && deleteFailures[deletingTypeId]?.blocked)}
              >
                {deleteType.isPending ? 'Đang xoá...' : 'Xoá'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </MainLayout>
  );
}
