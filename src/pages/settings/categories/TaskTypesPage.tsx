import { QueryRegion, refetchStartedSources } from '@/components/errors/QueryRegion';
import { LoadingState } from '@/components/loading/LoadingState';
import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { ClipboardList, Plus, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useJobTypes,
  useCreateJobType,
  useUpdateJobType,
  useDeleteJobType,
  useDepartments,
} from "@/hooks/useJobTypes";
import { useJobGroups, useCreateJobGroup } from "@/hooks/useJobGroups";
import { usePagination } from "@/hooks/usePagination";
import { filterJobTypesBySearch, paginateJobTypes } from "@/lib/jobTypeValidation";
import TaskTypeTable from "@/components/task-types/TaskTypeTable";
import TaskTypeFormDialog from "@/components/task-types/TaskTypeFormDialog";
import type { JobTypeWithRelations } from "@/types/jobTypes";
import type { JobTypeFormValues } from "@/lib/jobTypeValidation";
import { Link } from "react-router-dom";

export default function TaskTypesPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingJobType, setEditingJobType] = useState<JobTypeWithRelations | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const pagination = usePagination(20);

  // Data hooks
  const jobTypesQuery = useJobTypes();
  const { data: jobTypes = [], isLoading } = jobTypesQuery;
  const jobGroupsQuery = useJobGroups();
  const { data: jobGroups = [] } = jobGroupsQuery;
  const departmentsQuery = useDepartments();
  const { data: departments = [] } = departmentsQuery;
  const createJobType = useCreateJobType();
  const updateJobType = useUpdateJobType();
  const deleteJobType = useDeleteJobType();
  const createJobGroup = useCreateJobGroup();

  // Filter and paginate
  const filtered = filterJobTypesBySearch(jobTypes as JobTypeWithRelations[], searchQuery);
  const { data: paginatedData, totalCount } = paginateJobTypes(filtered, pagination.page, pagination.pageSize);

  // Handlers
  const handleAdd = () => {
    setEditingJobType(null);
    setIsFormOpen(true);
  };

  const handleEdit = (jobType: JobTypeWithRelations) => {
    setEditingJobType(jobType);
    setIsFormOpen(true);
  };

  const handleDelete = (id: string) => {
    setDeleteTarget(id);
  };

  const handleConfirmDelete = () => {
    if (deleteTarget) {
      deleteJobType.mutate(deleteTarget,{onSuccess:()=>setDeleteTarget(null)});
    }
  };

  const handleFormSubmit = async (values: JobTypeFormValues) => {
    if(editingJobType) await updateJobType.mutateAsync({id:editingJobType.id,updates:values});
    else await createJobType.mutateAsync(values);
    setIsFormOpen(false);setEditingJobType(null);
  };

  const handleCreateJobGroup = async (name: string) => {
    return createJobGroup.mutateAsync(name);
  };

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    pagination.setPage(1);
  };

  // Thanh trên (quay lại + Thêm) dùng cho cả lúc chờ: khung trang hiện ngay, nút Thêm
  // chỉ khoá trong lúc chờ (form cần nhóm/bộ phận) — chủ chốt 02/10/2026.
  const topBar = (waiting: boolean) => (
      <div className="flex items-center justify-between mb-4">
        <Link
          to="/settings/categories"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Quay lại Danh mục khác
        </Link>
        <Button
          className="bg-green-600 hover:bg-green-700 text-white"
          onClick={handleAdd}
          disabled={waiting}
        >
          <Plus className="h-4 w-4 mr-1" />
          Thêm loại công việc
        </Button>
      </div>
  );

  return (
    <MainLayout
      title="Loại công việc"
      subtitle="Quản lý loại công việc vận hành"
      icon={ClipboardList}
    >
      <QueryRegion label="Loại công việc, nhóm và bộ phận" queries={[jobTypesQuery,jobGroupsQuery,departmentsQuery]} loading={<>
        {topBar(true)}
        <LoadingState
          label="Loại công việc, nhóm và bộ phận"
          variant="table"
          rows={6}
          onRetry={() => refetchStartedSources([jobTypesQuery, jobGroupsQuery, departmentsQuery])}
        />
      </>}>
      {/* Top bar */}
      {topBar(false)}

      {/* Table */}
      <TaskTypeTable
        data={paginatedData}
        isLoading={isLoading}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onEdit={handleEdit}
        onDelete={handleDelete}
        pagination={pagination}
        totalCount={totalCount}
      />

      {/* Form Dialog */}
      <TaskTypeFormDialog
        open={isFormOpen}
        onOpenChange={(open) => {
          setIsFormOpen(open);
          if (!open) setEditingJobType(null);
        }}
        jobType={editingJobType}
        jobGroups={jobGroups}
        departments={departments}
        onSubmit={handleFormSubmit}
        onCreateJobGroup={handleCreateJobGroup}
        isSubmitting={createJobType.isPending || updateJobType.isPending}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xoá loại công việc này không?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteJobType.isPending} onClick={event => {event.preventDefault();handleConfirmDelete();}}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </QueryRegion></MainLayout>
  );
}
