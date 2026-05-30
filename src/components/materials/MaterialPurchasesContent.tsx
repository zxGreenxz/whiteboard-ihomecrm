import { Fragment, useState } from 'react';
import { Plus, Pencil, Trash2, MoreHorizontal, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import MaterialPurchaseFormDialog from '@/components/materials/MaterialPurchaseFormDialog';
import {
  useMaterialPurchases,
  useDeleteMaterialPurchase,
  type MaterialPurchaseWithItems,
} from '@/hooks/useMaterialPurchases';
import { format } from 'date-fns';

export default function MaterialPurchasesContent() {
  const { data: purchases = [], isLoading } = useMaterialPurchases();
  const deleteMut = useDeleteMaterialPurchase();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MaterialPurchaseWithItems | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MaterialPurchaseWithItems | null>(null);
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
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Thêm phiếu nhập
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Mã phiếu</TableHead>
                <TableHead>Ngày nhập</TableHead>
                <TableHead>Nhà cung cấp</TableHead>
                <TableHead className="text-right">Tổng tiền</TableHead>
                <TableHead>Ghi chú</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    Đang tải…
                  </TableCell>
                </TableRow>
              ) : purchases.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    Chưa có phiếu nhập. Bấm "Thêm phiếu nhập" để bắt đầu.
                  </TableCell>
                </TableRow>
              ) : (
                purchases.map((p) => (
                  <Fragment key={p.id}>
                    <TableRow className="hover:bg-muted/40">
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => toggleExpanded(p.id)}
                        >
                          {expanded.has(p.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{p.code}</TableCell>
                      <TableCell>{format(new Date(p.purchase_date), 'dd/MM/yyyy')}</TableCell>
                      <TableCell>{p.supplier?.name ?? '—'}</TableCell>
                      <TableCell className="text-right font-mono">
                        {Number(p.total).toLocaleString('vi-VN')} đ
                      </TableCell>
                      <TableCell className="text-muted-foreground truncate max-w-[280px]">
                        {p.notes ?? '—'}
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
                              onClick={() => {
                                setEditing(p);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-2" /> Sửa
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-red-600 focus:text-red-600"
                              onClick={() => setDeleteTarget(p)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Xoá
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                    {expanded.has(p.id) && (
                      <TableRow>
                        <TableCell colSpan={7} className="p-0 bg-muted/30">
                          <div className="px-6 py-3">
                            <div className="text-xs text-muted-foreground uppercase mb-2 font-semibold">
                              Chi tiết phiếu nhập
                            </div>
                            <div className="overflow-x-auto border rounded bg-background">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Vật tư</TableHead>
                                    <TableHead className="text-right">Số lượng</TableHead>
                                    <TableHead className="text-right">Đơn giá</TableHead>
                                    <TableHead className="text-right">Thành tiền</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {p.items.length === 0 ? (
                                    <TableRow>
                                      <TableCell colSpan={4} className="text-muted-foreground text-center py-4">
                                        Phiếu này chưa có dòng nào.
                                      </TableCell>
                                    </TableRow>
                                  ) : (
                                    p.items.map((it) => (
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
                                        <TableCell className="text-right font-mono">
                                          {Number(it.unit_price).toLocaleString('vi-VN')}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {Number(it.line_total).toLocaleString('vi-VN')}
                                        </TableCell>
                                      </TableRow>
                                    ))
                                  )}
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

      <MaterialPurchaseFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá phiếu nhập {deleteTarget?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tồn kho và giá vốn trung bình của vật tư sẽ được tính lại tự động sau khi xoá.
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
