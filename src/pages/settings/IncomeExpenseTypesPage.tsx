import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import MainLayout from '@/components/layout/MainLayout';
import IncomeExpenseTypeList from '@/components/income-expense-types/IncomeExpenseTypeList';
import {
  useIncomeExpenseTypes,
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
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus } from 'lucide-react';

export default function IncomeExpenseTypesPage() {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingType, setEditingType] = useState<IncomeExpenseType | null>(null);
  const [deletingTypeId, setDeletingTypeId] = useState<string | null>(null);

  const { data: types, isLoading } = useIncomeExpenseTypes();
  const createType = useCreateIncomeExpenseType();
  const updateType = useUpdateIncomeExpenseType();
  const deleteType = useDeleteIncomeExpenseType();

  const isEditing = !!editingType;

  const form = useForm<IncomeExpenseTypeFormValues>({
    resolver: zodResolver(incomeExpenseTypeFormSchema),
    defaultValues: {
      name: '',
      type: undefined,
      description: '',
      is_default: false,
    },
  });

  useEffect(() => {
    if (editingType && isFormOpen) {
      form.reset({
        name: editingType.name,
        type: editingType.type,
        description: editingType.description ?? '',
        is_default: editingType.is_default ?? false,
      });
    } else if (!editingType && isFormOpen) {
      form.reset({
        name: '',
        type: undefined,
        description: '',
        is_default: false,
      });
    }
  }, [editingType, isFormOpen, form]);

  const onSubmit = async (data: IncomeExpenseTypeFormValues) => {
    try {
      if (isEditing) {
        await updateType.mutateAsync({
          id: editingType.id,
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
      handleFormClose(false);
    } catch {
      // Errors handled by mutation hooks (toast)
    }
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
    if (!deletingTypeId) return;
    try {
      await deleteType.mutateAsync(deletingTypeId);
    } finally {
      setDeletingTypeId(null);
    }
  };

  const handleFormClose = (open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditingType(null);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Breadcrumb */}
        <div className="text-sm text-muted-foreground">
          Cài đặt hệ thống &gt; Danh mục khác &gt; Tài chính &gt;{' '}
          <span className="text-foreground font-medium">Loại thu chi</span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => { setEditingType(null); setIsFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm loại
          </Button>
        </div>

        {/* Type List */}
        <IncomeExpenseTypeList
          types={types || []}
          isLoading={isLoading}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />

        {/* Type Form Dialog */}
        <Dialog open={isFormOpen} onOpenChange={handleFormClose}>
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
                    onClick={() => handleFormClose(false)}
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

        {/* Delete Confirmation Dialog */}
        <AlertDialog
          open={!!deletingTypeId}
          onOpenChange={(open) => { if (!open) setDeletingTypeId(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
              <AlertDialogDescription>
                Bạn đang thực hiện thao tác xoá loại thu chi. Bạn có chắc chắn muốn xoá không?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Hủy</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                disabled={deleteType.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteType.isPending ? 'Đang xoá...' : 'Xoá'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </MainLayout>
  );
}
