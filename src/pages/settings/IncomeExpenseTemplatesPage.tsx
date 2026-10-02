import {recordWriteBlocked,recordWriteMessage} from '@/lib/recordWriteOutcome';
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
import { TemplateDefaultPartialError } from '@/hooks/useIncomeExpenseTemplates';

export default function IncomeExpenseTemplatesPage() {
  const busy=useRef(false);
  const [deleteFailures,setDeleteFailures]=useState<Record<string,{message:string;blocked:boolean}>>({});
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
    if(!deletingTemplateId || busy.current || deleteTemplate.isPending || deleteFailures[deletingTemplateId]?.blocked) return;
    busy.current=true;
    try {await deleteTemplate.mutateAsync(deletingTemplateId);setDeletingTemplateId(null);}
    catch(error) {setDeleteFailures(previous=>({...previous,[deletingTemplateId]:{message:recordWriteMessage(error,'xoá mẫu in'),blocked:recordWriteBlocked(error)}}));}
    finally {busy.current=false;}
  };

  const handleToggleDefault = (id: string, isDefault: boolean, isIncomeTemplate: boolean) => {
    if (toggleDefault.isPending || recordWriteBlocked(toggleDefault.error) || toggleDefault.error instanceof TemplateDefaultPartialError) return;
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
        {(recordWriteBlocked(toggleDefault.error) || toggleDefault.error instanceof TemplateDefaultPartialError) && <div role="alert" className="rounded-md border border-amber-500 p-3 text-sm">
          {recordWriteMessage(toggleDefault.error,'đổi mẫu mặc định')}
          <Button type="button" variant="outline" size="sm" className="mt-2 block" onClick={async () => {
            await templatesQuery.refetch();
            if(toggleDefault.variables) {try {await toggleDefault.mutateAsync(toggleDefault.variables);} catch { /* Marker chỉ được giải phóng bằng đối chiếu có kết quả. */ }}
          }}>Tải lại mẫu để đối chiếu</Button>
        </div>}

        {/* Template List */}
        {/* Thanh công cụ hiện ngay; chỉ danh sách chờ dữ liệu (chủ chốt 02/10/2026). */}
        <QueryRegion label="danh sách mẫu in thu chi" queries={[templatesQuery]} skeleton="table" rows={5}>
        <IncomeExpenseTemplateList
          templates={templates || []}
          isLoading={isLoading}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleDefault={handleToggleDefault}
          defaultPending={toggleDefault.isPending || recordWriteBlocked(toggleDefault.error) || toggleDefault.error instanceof TemplateDefaultPartialError}
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
            {deletingTemplateId && deleteFailures[deletingTemplateId] && <p role="alert" className="text-destructive">{deleteFailures[deletingTemplateId].message}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel>Hủy</AlertDialogCancel>
              <Button variant="destructive"
                onClick={() => { void confirmDelete(); }}
                disabled={deleteTemplate.isPending || !!(deletingTemplateId && deleteFailures[deletingTemplateId]?.blocked)}
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
