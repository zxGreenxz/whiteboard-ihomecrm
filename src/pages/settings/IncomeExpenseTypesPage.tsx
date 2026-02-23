import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import IncomeExpenseTypeList from '@/components/income-expense-types/IncomeExpenseTypeList';
import IncomeExpenseTypeForm from '@/components/income-expense-types/IncomeExpenseTypeForm';
import {
  useIncomeExpenseTypes,
  useDeleteIncomeExpenseType,
  type IncomeExpenseType,
} from '@/hooks/useIncomeExpenseTypes';
import { Button } from '@/components/ui/button';
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
  const deleteType = useDeleteIncomeExpenseType();

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
        <IncomeExpenseTypeForm
          open={isFormOpen}
          onOpenChange={handleFormClose}
          type={editingType}
        />

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
