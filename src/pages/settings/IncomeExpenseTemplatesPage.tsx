import {recordWriteMessage} from '@/lib/recordWriteOutcome';
import { useState, useRef } from 'react';
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
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus } from 'lucide-react';
import { QueryRegion } from '@/components/errors/QueryRegion';

export default function IncomeExpenseTemplatesPage() {
  const busy=useRef(false);
  // Đợt 8 (luật 5): xoá mẫu và chọn mẫu mặc định ghi lặp lại được, nên trang không tự khoá sau kết quả chưa rõ: báo rõ (hộp
  // xác nhận / thông báo), bấm lại cho đúng một kết quả.
  const [deleteFailures,setDeleteFailures]=useState<Record<string,string>>({});
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<IncomeExpenseTemplate | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);

  const templatesQuery = useIncomeExpenseTemplates();
  const { data: templates, isLoading } = templatesQuery;
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
    if(!deletingTemplateId || busy.current || deleteTemplate.isPending) return;
    busy.current=true;
    try {await deleteTemplate.mutateAsync(deletingTemplateId);setDeletingTemplateId(null);}
    catch(error) {setDeleteFailures(previous=>({...previous,[deletingTemplateId]:recordWriteMessage(error,'xoá mẫu in')}));}
    finally {busy.current=false;}
  };

  const handleToggleDefault = (id: string, isDefault: boolean, isIncomeTemplate: boolean) => {
    if (toggleDefault.isPending) return;
    toggleDefault.mutate({ id, is_default: isDefault, is_income_template: isIncomeTemplate });
  };

  const handleFormClose = (open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditingTemplate(null);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => { setEditingTemplate(null); setIsFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm mới
          </Button>
        </div>

        {/* Template List */}
        {/* Thanh công cụ hiện ngay; chỉ danh sách chờ dữ liệu (chủ chốt 02/10/2026). */}
        <QueryRegion label="danh sách mẫu in thu chi" queries={[templatesQuery]} skeleton="table" rows={5}>
        <IncomeExpenseTemplateList
          templates={templates || []}
          isLoading={isLoading}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleDefault={handleToggleDefault}
          defaultPending={toggleDefault.isPending}
        />
        </QueryRegion>

        {/* Template Form Dialog */}
        <IncomeExpenseTemplateForm
          open={isFormOpen}
          onOpenChange={handleFormClose}
          template={editingTemplate}
        />

        {/* Delete Confirmation Dialog */}
        <AlertDialog
          open={!!deletingTemplateId}
          onOpenChange={(open) => { if (!open && !busy.current && !deleteTemplate.isPending) setDeletingTemplateId(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
              <AlertDialogDescription>
                Bạn đang thực hiện thao tác xoá mẫu in thu chi. Bạn có chắc chắn muốn xoá không?
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deletingTemplateId && deleteFailures[deletingTemplateId] && <p role="alert" className="text-destructive">{deleteFailures[deletingTemplateId]}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel>Hủy</AlertDialogCancel>
              <Button variant="destructive"
                onClick={() => { void confirmDelete(); }}
                disabled={deleteTemplate.isPending}
              >
                {deleteTemplate.isPending ? 'Đang xoá...' : 'Xoá'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </MainLayout>
  );
}
