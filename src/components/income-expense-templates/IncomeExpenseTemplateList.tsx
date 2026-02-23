import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyState from '@/components/ui/EmptyState';
import { Pencil, Trash2, FileText, ExternalLink } from 'lucide-react';
import type { IncomeExpenseTemplate } from '@/hooks/useIncomeExpenseTemplates';

interface IncomeExpenseTemplateListProps {
  templates: IncomeExpenseTemplate[];
  isLoading: boolean;
  onEdit: (template: IncomeExpenseTemplate) => void;
  onDelete: (id: string) => void;
  onToggleDefault: (id: string, isDefault: boolean, isIncomeTemplate: boolean) => void;
}

const IncomeExpenseTemplateList = ({
  templates,
  isLoading,
  onEdit,
  onDelete,
  onToggleDefault,
}: IncomeExpenseTemplateListProps) => {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="Chưa có mẫu in thu chi nào"
        description="Hãy thêm mẫu in đầu tiên để bắt đầu quản lý"
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Mã</TableHead>
            <TableHead>Tên mẫu</TableHead>
            <TableHead>Xem mẫu PDF</TableHead>
            <TableHead>Mặc định</TableHead>
            <TableHead className="text-right">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((template) => (
            <TableRow key={template.id}>
              <TableCell className="font-medium">{template.code}</TableCell>
              <TableCell>{template.name}</TableCell>
              <TableCell>
                {template.template_file_url ? (
                  <a
                    href={template.template_file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    Xem PDF
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <Switch
                  checked={template.is_default}
                  onCheckedChange={(checked) =>
                    onToggleDefault(template.id, checked, template.is_income_template)
                  }
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEdit(template)}
                    title="Sửa"
                  >
                    <Pencil className="h-4 w-4 text-purple-600" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(template.id)}
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

export default IncomeExpenseTemplateList;
