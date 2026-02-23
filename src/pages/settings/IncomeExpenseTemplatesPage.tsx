import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import IncomeExpenseTemplateList from '@/components/income-expense-templates/IncomeExpenseTemplateList';
import IncomeExpenseTemplateForm from '@/components/income-expense-templates/IncomeExpenseTemplateForm';
import {
  useIncomeExpenseTemplates,
  useDeleteIncomeExpenseTemplate,
  useToggleDefaultTemplate,
  type IncomeExpenseTemplate,
} from '@/hooks/useIncomeExpenseTemplates';
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

export default function IncomeExpenseTemplatesPage() {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<IncomeExpenseTemplate | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);

  const { data: templates, isLoading } = useIncomeExpenseTemplates();
  const deleteTemplate = useDeleteIncomeExpenseTemplate();
  const toggleDefault = useToggleDefaultTemplate();

  const handleEdit = (template: IncomeExpenseTemplate) => {
    setEditingTemplate(template);
    setIsFormOpen(true);
  };

  const handleDelete = (templateId: string) => {
    setDeletingTemplateId(templateId);
  };

  const confirmDelete = async () => {
    if (!deletingTemplateId) return;
    try {
      await deleteTemplate.mutateAsync(deletingTemplateId);
    } finally {
      setDeletingTemplateId(null);
    }
  };

  const handleToggleDefault = (id: string, isDefault: boolean, isIncomeTemplate: boolean) => {
    toggleDefault.mutate({ id, is_default: isDefault, is_income_template: isIncomeTemplate });
  };

  const handleFormClose = (open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditingTemplate(null);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Breadcrumb */}
        <div className="text-sm text-muted-foreground">
          Cài đặt hệ thống &gt; Mẫu biểu &gt;{' '}
          <span className="text-foreground font-medium">Mẫu thu chi</span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => { setEditingTemplate(null); setIsFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm mới
          </Button>
        </div>

        {/* Template List */}
        <IncomeExpenseTemplateList
          templates={templates || []}
          isLoading={isLoading}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleDefault={handleToggleDefault}
        />

        {/* Template Form Dialog */}
        <IncomeExpenseTemplateForm
          open={isFormOpen}
          onOpenChange={handleFormClose}
          template={editingTemplate}
        />

        {/* Delete Confirmation Dialog */}
        <AlertDialog
          open={!!deletingTemplateId}
          onOpenChange={(open) => { if (!open) setDeletingTemplateId(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
              <AlertDialogDescription>
                Bạn đang thực hiện thao tác xoá mẫu in thu chi. Bạn có chắc chắn muốn xoá không?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Hủy</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                disabled={deleteTemplate.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteTemplate.isPending ? 'Đang xoá...' : 'Xoá'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </MainLayout>
  );
}
