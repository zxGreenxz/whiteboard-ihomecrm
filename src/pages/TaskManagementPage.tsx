import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { ClipboardList, Plus, SlidersHorizontal, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useJobs, useUpdateJobStatus, useDeleteJob } from "@/hooks/useJobs";
import { usePagination } from "@/hooks/usePagination";
import { filterJobs, paginateJobs } from "@/lib/jobValidation";
import { TaskStatusStats } from "@/components/tasks/TaskStatusStats";
import { TaskFiltersPanel } from "@/components/tasks/TaskFiltersPanel";
import TaskTable from "@/components/tasks/TaskTable";
import TaskCreateDialog from "@/components/tasks/TaskCreateDialog";
import TaskDetailDialog from "@/components/tasks/TaskDetailDialog";
import TaskCompleteDialog from "@/components/tasks/TaskCompleteDialog";
import TaskAcceptanceDialog from "@/components/tasks/TaskAcceptanceDialog";
import type { TaskFilters, JobWithRelations } from "@/types/jobs";
import { defaultTaskFilters } from "@/types/jobs";

export default function TaskManagementPage() {
  // State management
  const [searchQuery, setSearchQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<TaskFilters>(defaultTaskFilters);
  const [appliedFilters, setAppliedFilters] = useState<TaskFilters>(defaultTaskFilters);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<JobWithRelations | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isCompleteOpen, setIsCompleteOpen] = useState(false);
  const [isAcceptanceOpen, setIsAcceptanceOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const pagination = usePagination(20);

  // Data hooks
  const { data: allJobs = [], isLoading } = useJobs(appliedFilters);
  const updateJobStatus = useUpdateJobStatus();
  const deleteJob = useDeleteJob();

  // Client-side search filter
  const searchFiltered = (allJobs as JobWithRelations[]).filter(
    (job) =>
      job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.code.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Client-side pagination
  const { data: paginatedData, total: totalCount } = paginateJobs(
    searchFiltered,
    pagination.page,
    pagination.pageSize
  );

  // Handlers
  const handleViewDetail = (job: JobWithRelations) => {
    setSelectedJob(job);
    setIsDetailOpen(true);
  };

  const handleAcceptTask = () => {
    if (!selectedJob) return;
    updateJobStatus.mutate(
      {
        id: selectedJob.id,
        status: "IN_PROGRESS",
        extraData: { started_at: new Date().toISOString() },
      },
      {
        onSuccess: () => {
          setIsDetailOpen(false);
          setSelectedJob(null);
        },
      }
    );
  };

  const handleCompleteTask = () => {
    setIsDetailOpen(false);
    setIsCompleteOpen(true);
  };

  const handleReviewTask = () => {
    setIsDetailOpen(false);
    setIsAcceptanceOpen(true);
  };

  const handleDelete = (id: string) => {
    setDeleteTarget(id);
  };

  const handleConfirmDelete = () => {
    if (deleteTarget) {
      deleteJob.mutate(deleteTarget);
      setDeleteTarget(null);
    }
  };

  const handleApplyFilters = () => {
    setAppliedFilters(filters);
    pagination.setPage(1);
  };

  const handleClearFilters = () => {
    setFilters(defaultTaskFilters);
    setAppliedFilters(defaultTaskFilters);
    pagination.setPage(1);
  };

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    pagination.setPage(1);
  };

  return (
    <MainLayout
      title="Công việc"
      subtitle="Quản lý công việc vận hành"
      icon={ClipboardList}
    >
      {/* Stats */}
      <TaskStatusStats jobs={allJobs as JobWithRelations[]} />

      {/* Toolbar */}
      <div className="flex items-center justify-between mt-4 mb-4">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm kiếm theo mã hoặc tiêu đề..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={() => setIsCreateOpen(true)}
          >
            <Plus className="h-4 w-4 mr-1" />
            Thêm công việc
          </Button>
        </div>
      </div>

      {/* Filters Panel (collapsible) */}
      {showFilters && (
        <div className="mb-4">
          <TaskFiltersPanel
            filters={filters}
            onChange={setFilters}
            onApply={handleApplyFilters}
            onClear={handleClearFilters}
          />
        </div>
      )}

      {/* Table */}
      <TaskTable
        data={paginatedData}
        isLoading={isLoading}
        onViewDetail={handleViewDetail}
        onDelete={handleDelete}
        pagination={{
          page: pagination.page,
          pageSize: pagination.pageSize,
          onPageChange: pagination.setPage,
          onPageSizeChange: pagination.setPageSize,
        }}
        totalCount={totalCount}
      />

      {/* Create Dialog */}
      <TaskCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSuccess={() => setIsCreateOpen(false)}
      />

      {/* Detail Dialog */}
      <TaskDetailDialog
        open={isDetailOpen}
        onOpenChange={(open) => {
          setIsDetailOpen(open);
          if (!open) setSelectedJob(null);
        }}
        job={selectedJob}
        onAcceptTask={handleAcceptTask}
        onCompleteTask={handleCompleteTask}
        onReviewTask={handleReviewTask}
      />

      {/* Complete Dialog */}
      <TaskCompleteDialog
        open={isCompleteOpen}
        onOpenChange={setIsCompleteOpen}
        jobId={selectedJob?.id ?? ""}
        onSuccess={() => {
          setIsCompleteOpen(false);
          setSelectedJob(null);
        }}
      />

      {/* Acceptance Dialog */}
      <TaskAcceptanceDialog
        open={isAcceptanceOpen}
        onOpenChange={setIsAcceptanceOpen}
        jobId={selectedJob?.id ?? ""}
        onSuccess={() => {
          setIsAcceptanceOpen(false);
          setSelectedJob(null);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xoá công việc này không?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
