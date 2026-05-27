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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useJobs, useDeleteJob } from "@/hooks/useJobs";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePagination } from "@/hooks/usePagination";
import { paginateJobs } from "@/lib/jobValidation";
import { TaskStatusStats } from "@/components/tasks/TaskStatusStats";
import { TaskFiltersPanel } from "@/components/tasks/TaskFiltersPanel";
import TaskTable from "@/components/tasks/TaskTable";
import TaskListMobile from "@/components/tasks/TaskListMobile";
import TaskCreateDialog from "@/components/tasks/TaskCreateDialog";
import TaskDetailDialog from "@/components/tasks/TaskDetailDialog";
import TaskEditDialog from "@/components/tasks/TaskEditDialog";
import TaskNotesDialog from "@/components/tasks/TaskNotesDialog";
import TaskCompleteDialog from "@/components/tasks/TaskCompleteDialog";
import type { TaskFilters, JobWithRelations } from "@/types/jobs";
import { defaultTaskFilters } from "@/types/jobs";

type TaskTab = "ALL" | "MINE" | "WATCHING";
type StatusFilter = "IN_PROGRESS" | "COMPLETED" | null;

export default function TaskManagementPage() {
  const { data: authUser } = useAuth();
  const isMobile = useIsMobile();
  // State management
  const [searchQuery, setSearchQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<TaskFilters>(defaultTaskFilters);
  const [appliedFilters, setAppliedFilters] = useState<TaskFilters>(defaultTaskFilters);
  const [activeTab, setActiveTab] = useState<TaskTab>("ALL");
  // Mặc định chỉ hiển thị phiếu chưa hoàn thành (đang làm + trễ hẹn).
  // Click vào stat card sẽ chuyển sang IN_PROGRESS hoặc COMPLETED.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("IN_PROGRESS");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<JobWithRelations | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<JobWithRelations | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const pagination = usePagination(isMobile ? 50 : 20);

  // Data hooks
  const { data: allJobs = [], isLoading } = useJobs(appliedFilters);
  const deleteJob = useDeleteJob();

  // Tab filter
  // - MINE: phiếu mà mình là người thực hiện (assignee_id = me)
  // - WATCHING: phiếu KHÔNG giao cho mình (mình đang theo dõi/giám sát).
  //   Super admin thấy hết qua RLS bypass nên tab này bao gồm cả phiếu do user khác tạo.
  //   Staff thường chỉ thấy phiếu mình tạo/được giao → tab này tự thu hẹp về "mình tạo cho người khác".
  const myUserId = authUser?.id ?? null;
  const isAssignedToMe = (job: any) =>
    myUserId &&
    (job.assignee_id === myUserId || job.profiles?.id === myUserId);
  const isWatching = (job: any) => !!myUserId && !isAssignedToMe(job);

  const tabFiltered = (allJobs as JobWithRelations[]).filter((job) => {
    if (activeTab === "MINE") return isAssignedToMe(job);
    if (activeTab === "WATCHING") return isWatching(job);
    return true;
  });

  const tabCounts = {
    ALL: (allJobs as JobWithRelations[]).length,
    MINE: (allJobs as JobWithRelations[]).filter(isAssignedToMe).length,
    WATCHING: (allJobs as JobWithRelations[]).filter(isWatching).length,
  };

  // Status filter (từ stat card click)
  const statusFiltered = tabFiltered.filter((job) => {
    if (statusFilter === null) return true;
    return job.status === statusFilter;
  });

  // Search filter: title + code + assignee (cả tên có profile và tên text)
  const q = searchQuery.trim().toLowerCase();
  const searchFiltered = q
    ? statusFiltered.filter((job) => {
        const assigneeName = (
          job.profiles?.full_name ||
          job.assignee_name ||
          ""
        ).toLowerCase();
        return (
          job.title.toLowerCase().includes(q) ||
          job.code.toLowerCase().includes(q) ||
          assigneeName.includes(q)
        );
      })
    : statusFiltered;

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

  const handleRequestComplete = (job: JobWithRelations) => {
    setCompleteTarget(job);
  };

  const handleEdit = (job: JobWithRelations) => {
    setSelectedJob(job);
    setIsDetailOpen(false);
    setIsEditOpen(true);
  };

  const handleAddNotes = (job: JobWithRelations) => {
    setSelectedJob(job);
    setIsDetailOpen(false);
    setIsNotesOpen(true);
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

  const handleStatusCardClick = (status: "IN_PROGRESS" | "COMPLETED") => {
    setStatusFilter((prev) => (prev === status ? null : status));
    pagination.setPage(1);
  };

  // Shared dialogs (desktop + mobile)
  const dialogs = (
    <>
      <TaskCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSuccess={() => setIsCreateOpen(false)}
      />
      <TaskDetailDialog
        open={isDetailOpen}
        onOpenChange={(open) => {
          setIsDetailOpen(open);
          if (!open) setSelectedJob(null);
        }}
        job={selectedJob}
        onComplete={() => {
          if (selectedJob) handleRequestComplete(selectedJob);
        }}
        onEdit={() => {
          if (selectedJob) handleEdit(selectedJob);
        }}
        onAddNotes={() => {
          if (selectedJob) handleAddNotes(selectedJob);
        }}
        onDelete={
          isMobile
            ? () => {
                if (selectedJob) {
                  setIsDetailOpen(false);
                  handleDelete(selectedJob.id);
                }
              }
            : undefined
        }
      />
      <TaskEditDialog
        open={isEditOpen}
        onOpenChange={(open) => {
          setIsEditOpen(open);
          if (!open) setSelectedJob(null);
        }}
        job={selectedJob}
        onSuccess={() => {
          setIsEditOpen(false);
          setSelectedJob(null);
        }}
      />
      <TaskNotesDialog
        open={isNotesOpen}
        onOpenChange={(open) => {
          setIsNotesOpen(open);
          if (!open) setSelectedJob(null);
        }}
        job={selectedJob}
        onSuccess={() => {
          setIsNotesOpen(false);
          setSelectedJob(null);
        }}
      />
      <TaskCompleteDialog
        open={!!completeTarget}
        onOpenChange={(open) => {
          if (!open) setCompleteTarget(null);
        }}
        job={completeTarget}
        onSuccess={() => {
          setCompleteTarget(null);
          setIsDetailOpen(false);
          setSelectedJob(null);
        }}
      />
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
    </>
  );

  // ============== MOBILE LAYOUT ==============
  if (isMobile) {
    return (
      <MainLayout
        title="Công việc"
        subtitle="Quản lý công việc vận hành"
        icon={ClipboardList}
      >
        <div className="-mx-4 -my-4 sm:-mx-6 sm:-my-6 bg-zinc-50 min-h-[calc(100vh-120px)]">
          {/* Search + filter + Stats trên 1 dải */}
          <div className="px-3 pt-2 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Tìm công việc, người thực hiện..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-9 h-9 bg-white"
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowFilters(!showFilters)}
                className="h-9 w-9 shrink-0 bg-white"
                title="Lọc dữ liệu"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            </div>

            {/* Tabs + Stats: gộp 1 dải compact */}
            <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1">
              {([
                ["ALL", "Tất cả"],
                ["MINE", "Của tôi"],
                ["WATCHING", "Theo dõi"],
              ] as const).map(([key, label]) => {
                const active = activeTab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setActiveTab(key as TaskTab);
                      pagination.setPage(1);
                    }}
                    className={`shrink-0 px-2.5 py-1 text-[12px] font-medium rounded-full flex items-center gap-1 transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-white text-zinc-600 border border-zinc-200"
                    }`}
                  >
                    {label}
                    <span
                      className={`inline-flex items-center rounded-full px-1 text-[10px] ${
                        active
                          ? "bg-white/25 text-white"
                          : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {tabCounts[key]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Stats compact */}
          <div className="px-3 pt-2">
            <TaskStatusStats
              jobs={tabFiltered}
              activeFilter={statusFilter}
              onFilterChange={handleStatusCardClick}
            />
          </div>

          {/* Filters Panel — bottom sheet trên mobile (giống thu chi) */}
          <Sheet open={showFilters} onOpenChange={setShowFilters}>
            <SheetContent side="bottom" className="h-[85vh] overflow-y-auto p-0">
              <SheetHeader className="px-4 py-3 border-b">
                <SheetTitle>Bộ lọc</SheetTitle>
              </SheetHeader>
              <div className="p-4">
                <TaskFiltersPanel
                  filters={filters}
                  onChange={setFilters}
                  onApply={() => {
                    handleApplyFilters();
                    setShowFilters(false);
                  }}
                  onClear={() => {
                    handleClearFilters();
                    setShowFilters(false);
                  }}
                />
              </div>
            </SheetContent>
          </Sheet>

          {/* List */}
          <TaskListMobile
            jobs={paginatedData}
            isLoading={isLoading}
            onView={handleViewDetail}
          />

          {/* Pagination summary */}
          {totalCount > pagination.pageSize && (
            <div className="px-3 pb-2 text-center text-xs text-muted-foreground">
              Hiển thị {paginatedData.length} / {totalCount} công việc
              {pagination.page * pagination.pageSize < totalCount && (
                <button
                  className="ml-2 text-blue-600 font-medium"
                  onClick={() => pagination.setPage(pagination.page + 1)}
                >
                  Xem thêm →
                </button>
              )}
            </div>
          )}
        </div>

        {/* FAB */}
        <button
          type="button"
          onClick={() => setIsCreateOpen(true)}
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full bg-green-600 hover:bg-green-700 text-white shadow-lg flex items-center justify-center z-40"
          aria-label="Thêm công việc"
        >
          <Plus className="h-6 w-6" />
        </button>

        {dialogs}
      </MainLayout>
    );
  }

  // ============== DESKTOP LAYOUT ==============
  return (
    <MainLayout
      title="Công việc"
      subtitle="Quản lý công việc vận hành"
      icon={ClipboardList}
    >
      {/* Tabs — match Resident "Tất cả / Việc của tôi / Đang theo dõi" */}
      <div className="flex items-center gap-1 mb-4 border-b">
        {([
          ["ALL", "Tất cả"],
          ["MINE", "Việc của tôi"],
          ["WATCHING", "Đang theo dõi"],
        ] as const).map(([key, label]) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setActiveTab(key as TaskTab);
                pagination.setPage(1);
              }}
              className={`relative px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2 ${
                active
                  ? "text-primary border-b-2 border-primary -mb-px"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              <span
                className={`inline-flex items-center rounded-full px-1.5 text-xs ${
                  active
                    ? "bg-red-100 text-red-600"
                    : "bg-zinc-100 text-zinc-600"
                }`}
              >
                {tabCounts[key]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Stats */}
      <TaskStatusStats
              jobs={tabFiltered}
              activeFilter={statusFilter}
              onFilterChange={handleStatusCardClick}
            />

      {/* Toolbar */}
      <div className="flex items-center justify-between mt-4 mb-4">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm theo mã, công việc, người thực hiện..."
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
        onComplete={handleRequestComplete}
        onEdit={handleEdit}
        onAddNotes={handleAddNotes}
        onDelete={handleDelete}
        pagination={{
          page: pagination.page,
          pageSize: pagination.pageSize,
          onPageChange: pagination.setPage,
          onPageSizeChange: pagination.setPageSize,
        }}
        totalCount={totalCount}
      />

      {dialogs}
    </MainLayout>
  );
}
