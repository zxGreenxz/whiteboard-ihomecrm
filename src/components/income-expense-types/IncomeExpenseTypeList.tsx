import { Fragment, useState } from 'react';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronDown, ChevronUp, Pencil, Trash2, Tags } from 'lucide-react';
import type { IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';
import { sortIeTypesForPicker } from '@/lib/ieTypeCatalog';
import { groupIeTypesForPicker } from '@/lib/ieTypeLookup';

interface IncomeExpenseTypeListProps {
  types: IncomeExpenseType[];
  isLoading: boolean;
  /** Không truyền = chỉ đọc (người không phải superadmin / chủ công ty). */
  onEdit?: (type: IncomeExpenseType) => void;
  onDelete?: (id: string) => void;
}

const DIRECTIONS = [
  { key: 'expense', label: 'Chi' },
  { key: 'income', label: 'Thu' },
] as const;

const IncomeExpenseTypeList = ({
  types,
  isLoading,
  onEdit,
  onDelete,
}: IncomeExpenseTypeListProps) => {
  const [showArchived, setShowArchived] = useState(false);

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
        description={onEdit ? 'Hãy thêm loại thu chi đầu tiên để bắt đầu quản lý' : 'Báo chủ công ty thêm loại thu chi đầu tiên'}
      />
    );
  }

  const canAct = !!onEdit || !!onDelete;
  const columnCount = canAct ? 5 : 4;
  const byId = new Map(types.map((t) => [t.id, t]));
  const active = types.filter((t) => !t.archived_at);
  const archived = sortIeTypesForPicker(types.filter((t) => !!t.archived_at));
  // Đang dùng: Chi trước (danh mục chuẩn), rồi Thu; trong mỗi chiều xếp theo danh mục rồi gom nhóm.
  const sections = DIRECTIONS.flatMap((dir) =>
    groupIeTypesForPicker(sortIeTypesForPicker(active.filter((t) => t.type === dir.key))).map(
      (group) => ({ ...group, key: `${dir.key}::${group.label}`, direction: dir.label }),
    ),
  );

  const renderRow = (type: IncomeExpenseType) => {
    const mergedInto = type.merged_into_id ? byId.get(type.merged_into_id) : undefined;
    return (
      <TableRow key={type.id} className={type.archived_at ? 'text-muted-foreground' : undefined}>
        <TableCell className="font-medium">
          <div>{type.name}</div>
          {type.merged_into_id && (
            <div className="text-xs font-normal text-muted-foreground">
              → gộp vào {mergedInto?.name ?? 'hạng mục khác'}
            </div>
          )}
          {(type.system_only || type.manual_hidden || type.quick_entry_hidden) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {type.system_only && <Badge variant="outline" className="text-[11px] font-normal">Hệ thống</Badge>}
              {!type.system_only && type.manual_hidden && <Badge variant="outline" className="text-[11px] font-normal">Ẩn khi lập tay</Badge>}
              {type.quick_entry_hidden && <Badge variant="outline" className="text-[11px] font-normal">Ẩn Báo chi nhanh</Badge>}
            </div>
          )}
        </TableCell>
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
          <Switch checked={type.is_default} disabled aria-label="Mặc định" />
        </TableCell>
        {canAct && (
          <TableCell className="text-right">
            <div className="flex justify-end gap-1">
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(type)}
                  title="Sửa"
                  aria-label={`Sửa ${type.name}`}
                >
                  <Pencil className="h-4 w-4 text-purple-600" />
                </Button>
              )}
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(type.id)}
                  title="Xoá"
                  aria-label={`Xoá ${type.name}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              )}
            </div>
          </TableCell>
        )}
      </TableRow>
    );
  };

  const header = (
    <TableHeader>
      <TableRow>
        <TableHead>Tên loại</TableHead>
        <TableHead>Loại</TableHead>
        <TableHead>Mô tả</TableHead>
        <TableHead>Mặc định</TableHead>
        {canAct && <TableHead className="text-right">Thao tác</TableHead>}
      </TableRow>
    </TableHeader>
  );

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-lg border">
        <Table>
          {header}
          <TableBody>
            {sections.map((section) => (
              <Fragment key={section.key}>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={columnCount} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.direction} · {section.label}
                  </TableCell>
                </TableRow>
                {section.items.map(renderRow)}
              </Fragment>
            ))}
            {sections.length === 0 && (
              <TableRow>
                <TableCell colSpan={columnCount} className="py-6 text-center text-muted-foreground">
                  Chưa có hạng mục đang dùng.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {archived.length > 0 && (
        <Collapsible open={showArchived} onOpenChange={setShowArchived}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-full justify-between">
              <span>Đã lưu trữ ({archived.length})</span>
              {showArchived ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-2 text-xs text-muted-foreground">
              Ẩn khỏi mọi ô chọn; phiếu cũ vẫn giữ hạng mục này. Mục đã gộp được báo cáo cộng vào hạng mục đích.
            </p>
            <div className="mt-2 bg-white rounded-lg border">
              <Table>
                {header}
                <TableBody>{archived.map(renderRow)}</TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};

export default IncomeExpenseTypeList;
