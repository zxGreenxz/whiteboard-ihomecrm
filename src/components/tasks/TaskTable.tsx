import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Eye, Trash2, ClipboardList, CheckCircle2, Pencil, MessageSquarePlus } from "lucide-react";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { calculatePaginationInfo } from "@/hooks/usePagination";
import { format } from "date-fns";
import type { JobWithRelations } from "@/types/jobs";
import { getStatusColor, getStatusLabel } from "@/lib/jobValidation";

interface TaskTableProps {
  data: JobWithRelations[];
  isLoading: boolean;
  onViewDetail: (job: JobWithRelations) => void;
  onComplete: (job: JobWithRelations) => void;
  onEdit: (job: JobWithRelations) => void;
  onAddNotes: (job: JobWithRelations) => void;
  onDelete: (id: string) => void;
  pagination: {
    page: number;
    pageSize: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
  };
  totalCount: number;
}

function formatDeadline(deadline: string | null): string {
  if (!deadline) return "—";
  try {
    return format(new Date(deadline), "dd-MM-yyyy HH:mm");
  } catch {
    return "—";
  }
}

export default function TaskTable({
  data,
  isLoading,
  onViewDetail,
  onComplete,
  onEdit,
  onAddNotes,
  onDelete,
  pagination,
  totalCount,
}: TaskTableProps) {
  const paginationInfo = calculatePaginationInfo(pagination.page, pagination.pageSize, totalCount);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 overflow-hidden bg-white">
        <Table className="text-[15px] [&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
          <TableHeader>
            <TableRow className="bg-zinc-50">
              <TableHead className="w-[200px] py-3 text-sm font-semibold text-zinc-700">Thao tác</TableHead>
              <TableHead className="py-3 text-sm font-semibold text-zinc-700">Công việc</TableHead>
              <TableHead className="w-[160px] py-3 text-sm font-semibold text-zinc-700">Vị trí</TableHead>
              <TableHead className="w-[180px] py-3 text-sm font-semibold text-zinc-700">Loại công việc</TableHead>
              <TableHead className="w-[180px] py-3 text-sm font-semibold text-zinc-700">Hạn hoàn thành</TableHead>
              <TableHead className="w-[200px] py-3 text-sm font-semibold text-zinc-700">Người thực hiện</TableHead>
              <TableHead className="w-[140px] py-3 text-sm font-semibold text-zinc-700">Trạng thái</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                  Đang tải...
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-16">
                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                    <ClipboardList className="h-12 w-12 mb-3 opacity-50" />
                    <p>Chưa có công việc nào. Hãy thêm công việc đầu tiên.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              data.map((job) => (
                <TableRow key={job.id} className="hover:bg-zinc-50/60">
                  <TableCell className="py-3">
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-9 w-9 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        onClick={() => onViewDetail(job)}
                        title="Xem chi tiết"
                      >
                        <Eye className="h-[18px] w-[18px]" />
                      </Button>
                      {job.status === "IN_PROGRESS" && (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-9 w-9 text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => onComplete(job)}
                            title="Hoàn thành"
                          >
                            <CheckCircle2 className="h-[18px] w-[18px]" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-9 w-9 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                            onClick={() => onEdit(job)}
                            title="Sửa phiếu"
                          >
                            <Pencil className="h-[18px] w-[18px]" />
                          </Button>
                        </>
                      )}
                      {job.status === "COMPLETED" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                          onClick={() => onAddNotes(job)}
                          title="Ghi chú đánh giá"
                        >
                          <MessageSquarePlus className="h-[18px] w-[18px]" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-9 w-9 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => onDelete(job.id)}
                        title="Xoá"
                      >
                        <Trash2 className="h-[18px] w-[18px]" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="py-3">
                    <span
                      className="font-medium text-blue-600 hover:underline cursor-pointer"
                      onClick={() => onViewDetail(job)}
                    >
                      {job.title}
                    </span>
                  </TableCell>
                  <TableCell className="py-3">
                    {job.buildings?.name ? (
                      <div className="flex flex-col leading-tight">
                        <span>{job.buildings.name}</span>
                        {job.rooms?.name && (
                          <span className="text-xs text-muted-foreground">
                            {job.rooms.name}
                          </span>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="py-3">{job.job_types?.name ?? "—"}</TableCell>
                  <TableCell className="py-3 text-sm">{formatDeadline(job.deadline)}</TableCell>
                  <TableCell className="py-3">
                    {job.profiles?.full_name ? (
                      <div className="flex flex-col leading-tight">
                        <span>{job.profiles.full_name}</span>
                        {(job.profiles as any)?.phone && (
                          <span className="text-xs text-muted-foreground">
                            {(job.profiles as any).phone}
                          </span>
                        )}
                      </div>
                    ) : job.assignee_name ? (
                      <span>{job.assignee_name}</span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${getStatusColor(
                        job.status
                      )}`}
                    >
                      {getStatusLabel(job.status)}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination
        paginationInfo={paginationInfo}
        onPageChange={pagination.onPageChange}
        onPageSizeChange={pagination.onPageSizeChange}
      />
    </div>
  );
}
