import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyState from '@/components/ui/EmptyState';
import { Pencil, Trash2, Tags } from 'lucide-react';
import type { IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';

interface IncomeExpenseTypeListProps {
  types: IncomeExpenseType[];
  isLoading: boolean;
  onEdit: (type: IncomeExpenseType) => void;
  onDelete: (id: string) => void;
}

const IncomeExpenseTypeList = ({
  types,
  isLoading,
  onEdit,
  onDelete,
}: IncomeExpenseTypeListProps) => {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (types.length === 0) {
    return (
      <EmptyState
        icon={Tags}
        title="Chưa có loại thu chi nào"
        description="Hãy thêm loại thu chi đầu tiên để bắt đầu quản lý"
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tên loại</TableHead>
            <TableHead>Loại</TableHead>
            <TableHead>Mô tả</TableHead>
            <TableHead>Mặc định</TableHead>
            <TableHead className="text-right">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {types.map((type) => (
            <TableRow key={type.id}>
              <TableCell className="font-medium">{type.name}</TableCell>
              <TableCell>
                <Badge
                  className={
                    type.type === 'income'
                      ? 'bg-green-100 text-green-800 hover:bg-green-100'
                      : 'bg-red-100 text-red-800 hover:bg-red-100'
                  }
                >
                  {type.type === 'income' ? 'Thu' : 'Chi'}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {type.description || '—'}
              </TableCell>
              <TableCell>
                <Switch checked={type.is_default} disabled />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEdit(type)}
                    title="Sửa"
                  >
                    <Pencil className="h-4 w-4 text-purple-600" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(type.id)}
                    title="Xoá"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default IncomeExpenseTypeList;
