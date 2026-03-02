import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pencil, Trash2, Search } from "lucide-react";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { calculatePaginationInfo } from "@/hooks/usePagination";
import type { PaginationState } from "@/hooks/usePagination";
import type { JobTypeWithRelations } from "@/types/jobTypes";
import { getPriorityLabel } from "@/lib/jobTypeValidation";
import type { IssuePriority } from "@/types/jobTypes";

interface TaskTypeTableProps {
  data: JobTypeWithRelations[];
  isLoading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onEdit: (jobType: JobTypeWithRelations) => void;
  onDelete: (id: string) => void;
  pagination: PaginationState;
  totalCount: number;
}

function formatDeadline(value: number | null): string {
  if (!value || value === 0) return "Không quy định";
  return `${value}`;
}

export default function TaskTypeTable({
  data,
  isLoading,
  searchQuery,
  onSearchChange,
  onEdit,
  onDelete,
  pagination,
  totalCount,
}: TaskTypeTableProps) {
  const paginationInfo = calculatePaginationInfo(pagination.page, pagination.pageSize, totalCount);

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="relative w-72">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Tìm kiếm..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Thao tác</TableHead>
              <TableHead>Tên loại công việc</TableHead>
              <TableHead>Bộ phận phụ trách</TableHead>
              <TableHead>Nhóm công việc</TableHead>
              <TableHead>Hạn gọi cho khách (phút)</TableHead>
              <TableHead>Hạn tiếp nhận công việc (phút)</TableHead>
              <TableHead>Hạn hoàn thành (phút)</TableHead>
              <TableHead>Tính giờ hành chính</TableHead>
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
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Chưa có loại công việc nào. Hãy thêm mới.
                </TableCell>
              </TableRow>
            ) : (
              data.map((jobType) => (
                <TableRow key={jobType.id}>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        className="h-8 w-8 bg-green-500 hover:bg-green-600 text-white rounded"
                        onClick={() => onEdit(jobType)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        className="h-8 w-8 bg-red-500 hover:bg-red-600 text-white rounded"
                        onClick={() => onDelete(jobType.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{jobType.name}</TableCell>
                  <TableCell>{jobType.departments?.name ?? "—"}</TableCell>
                  <TableCell>{jobType.job_groups?.name ?? "—"}</TableCell>
                  <TableCell>{formatDeadline(jobType.customer_contact_deadline)}</TableCell>
                  <TableCell>{formatDeadline(jobType.acceptance_deadline)}</TableCell>
                  <TableCell>{formatDeadline(jobType.completion_deadline)}</TableCell>
                  <TableCell>{jobType.business_hours_only ? "Có" : "Không"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <DataTablePagination
        paginationInfo={paginationInfo}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
      />
    </div>
  );
}
