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
        <Table className="[&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">Mã</TableHead>
              <TableHead className="w-[180px]">Thao tác</TableHead>
              <TableHead>Công việc</TableHead>
              <TableHead className="w-[140px]">Vị trí</TableHead>
              <TableHead className="w-[160px]">Loại công việc</TableHead>
              <TableHead className="w-[160px]">Hạn hoàn thành</TableHead>
              <TableHead className="w-[180px]">Người thực hiện</TableHead>
              <TableHead className="w-[140px]">Trạng thái</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-12">
                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                    <ClipboardList className="h-12 w-12 mb-3 opacity-50" />
                    <p>Chưa có công việc nào. Hãy thêm công việc đầu tiên.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              data.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <span
                      className="text-blue-600 cursor-pointer hover:underline font-medium"
                      onClick={() => onViewDetail(job)}
                    >
                      {job.code}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        onClick={() => onViewDetail(job)}
                        title="Xem chi tiết"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {job.status === "IN_PROGRESS" && (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => onComplete(job)}
                            title="Hoàn thành"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                            onClick={() => onEdit(job)}
                            title="Sửa phiếu"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {job.status === "COMPLETED" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                          onClick={() => onAddNotes(job)}
                          title="Ghi chú đánh giá"
                        >
                          <MessageSquarePlus className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => onDelete(job.id)}
                        title="Xoá"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col leading-snug">
                      <span className="font-medium">{job.title}</span>
                      {job.description && (
                        <span className="text-xs text-muted-foreground line-clamp-2">
                          {job.description}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
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
                  <TableCell>{job.job_types?.name ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDeadline(job.deadline)}</TableCell>
                  <TableCell>
                    {job.profiles?.full_name ? (
                      <div className="flex flex-col leading-tight">
                        <span>{job.profiles.full_name}</span>
                        {(job.profiles as any)?.phone && (
                          <span className="text-xs text-muted-foreground">
                            {(job.profiles as any).phone}
                          </span>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
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
