import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Eye, Trash2, ClipboardList } from "lucide-react";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { calculatePaginationInfo } from "@/hooks/usePagination";
import { format } from "date-fns";
import type { JobWithRelations } from "@/types/jobs";
import {
  getStatusColor,
  getStatusLabel,
  getPriorityColor,
  getPriorityLabel,
} from "@/lib/jobValidation";

interface TaskTableProps {
  data: JobWithRelations[];
  isLoading: boolean;
  onViewDetail: (job: JobWithRelations) => void;
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
    return format(new Date(deadline), "dd/MM/yyyy HH:mm");
  } catch {
    return "—";
  }
}

export default function TaskTable({
  data,
  isLoading,
  onViewDetail,
  onDelete,
  pagination,
  totalCount,
}: TaskTableProps) {
  const paginationInfo = calculatePaginationInfo(pagination.page, pagination.pageSize, totalCount);

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mã công việc</TableHead>
              <TableHead>Tiêu đề</TableHead>
              <TableHead>Căn hộ</TableHead>
              <TableHead>Phòng</TableHead>
              <TableHead>Nhóm công việc</TableHead>
              <TableHead>Loại công việc</TableHead>
              <TableHead>Mức độ ưu tiên</TableHead>
              <TableHead>Người thực hiện</TableHead>
              <TableHead>Hạn hoàn thành</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead className="w-[100px]">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="py-12">
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
                    <span className="block max-w-[200px] truncate">{job.title}</span>
                  </TableCell>
                  <TableCell>{job.buildings?.name ?? "—"}</TableCell>
                  <TableCell>{job.rooms?.name ?? "—"}</TableCell>
                  <TableCell>{job.job_groups?.name ?? "—"}</TableCell>
                  <TableCell>{job.job_types?.name ?? "—"}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${getPriorityColor(job.priority)}`}>
                      {getPriorityLabel(job.priority)}
                    </span>
                  </TableCell>
                  <TableCell>{job.profiles?.full_name ?? "—"}</TableCell>
                  <TableCell>{formatDeadline(job.deadline)}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${getStatusColor(job.status)}`}>
                      {getStatusLabel(job.status)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        onClick={() => onViewDetail(job)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => onDelete(job.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
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
