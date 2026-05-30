import { Fragment, useState } from 'react';
import { Plus, Trash2, MoreHorizontal, ChevronDown, ChevronRight, ArrowDown, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import MaterialAdjustmentFormDialog from '@/components/materials/MaterialAdjustmentFormDialog';
import {
  useMaterialAdjustments,
  useDeleteMaterialAdjustment,
  type MaterialAdjustmentWithItems,
} from '@/hooks/useMaterialAdjustments';
import { format } from 'date-fns';

export default function MaterialAdjustmentsContent() {
  const { data: adjustments = [], isLoading } = useMaterialAdjustments();
  const deleteMut = useDeleteMaterialAdjustment();

  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MaterialAdjustmentWithItems | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setFormOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          Tạo phiếu kiểm kê
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Mã phiếu</TableHead>
                <TableHead>Ngày</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Lý do</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    Đang tải…
                  </TableCell>
                </TableRow>
              ) : adjustments.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    Chưa có phiếu kiểm kê.
                  </TableCell>
                </TableRow>
              ) : (
                adjustments.map((a) => (
                  <Fragment key={a.id}>
                    <TableRow className="hover:bg-muted/40">
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => toggleExpanded(a.id)}
                        >
                          {expanded.has(a.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{a.code}</TableCell>
                      <TableCell>{format(new Date(a.adjustment_date), 'dd/MM/yyyy')}</TableCell>
                      <TableCell>
                        <Badge
                          className={
                            a.type === 'IN'
                              ? 'bg-green-100 text-green-800 border-green-300'
                              : 'bg-red-100 text-red-800 border-red-300'
                          }
                        >
                          {a.type === 'IN' ? (
                            <ArrowUp className="h-3 w-3 mr-1" />
                          ) : (
                            <ArrowDown className="h-3 w-3 mr-1" />
                          )}
                          {a.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground truncate max-w-[320px]">
                        {a.reason ?? '—'}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="h-7 w-7">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="text-red-600 focus:text-red-600"
                              onClick={() => setDeleteTarget(a)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Xoá
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                    {expanded.has(a.id) && (
                      <TableRow>
                        <TableCell colSpan={6} className="p-0 bg-muted/30">
                          <div className="px-6 py-3">
                            <div className="text-xs text-muted-foreground uppercase mb-2 font-semibold">
                              Chi tiết
                            </div>
                            <div className="overflow-x-auto border rounded bg-background">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Vật tư</TableHead>
                                    <TableHead className="text-right">Số lượng</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {a.items.map((it) => (
                                    <TableRow key={it.id}>
                                      <TableCell>
                                        {it.material?.name ?? '(đã xoá)'}
                                        <span className="text-muted-foreground text-xs ml-1">
                                          {it.material?.unit ? `(${it.material.unit})` : ''}
                                        </span>
                                      </TableCell>
                                      <TableCell className="text-right font-mono">
                                        {Number(it.quantity).toLocaleString('vi-VN')}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <MaterialAdjustmentFormDialog open={formOpen} onOpenChange={setFormOpen} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá phiếu kiểm kê {deleteTarget?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tồn kho của vật tư trong phiếu sẽ tự động được tính lại.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={async () => {
                if (!deleteTarget) return;
                await deleteMut.mutateAsync(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
