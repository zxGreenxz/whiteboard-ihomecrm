import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ArrowDown, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
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
import { useMaterialUsages } from '@/hooks/useMaterialUsages';
import MaterialUsageFormDialog from '@/components/materials/MaterialUsageFormDialog';
import { format } from 'date-fns';

export default function MaterialUsagesContent() {
  const { data: usages = [], isLoading } = useMaterialUsages();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Phiếu xuất tạo tự động khi staff khai báo vật tư trong phiếu công việc.
          Mỗi job có nhiều nhất 1 phiếu xuất — sửa qua dialog "Chi tiết công việc".
          Ngoài ra có thể tạo phiếu xuất bằng tay (không gắn job).
        </p>
        <Button size="sm" className="gap-1 shrink-0" onClick={() => setFormOpen(true)}>
          <Plus className="h-4 w-4" /> Tạo phiếu xuất
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Mã phiếu</TableHead>
                <TableHead>Ngày xuất</TableHead>
                <TableHead>Phiếu công việc</TableHead>
                <TableHead>Người tạo</TableHead>
                <TableHead className="text-right">Tổng SL</TableHead>
                <TableHead className="text-right">Chi phí</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    Đang tải…
                  </TableCell>
                </TableRow>
              ) : usages.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    Chưa có phiếu xuất nào. Tạo phiếu công việc và thêm vật tư
                    để tự động phát sinh phiếu xuất.
                  </TableCell>
                </TableRow>
              ) : (
                usages.map((u) => {
                  const totalQty = u.items.reduce((s, it) => s + Number(it.quantity), 0);
                  const totalCost = u.items.reduce(
                    (s, it) => s + Number(it.quantity) * Number(it.unit_cost_at_usage),
                    0,
                  );
                  return (
                    <Fragment key={u.id}>
                      <TableRow className="hover:bg-muted/40">
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={() => toggleExpanded(u.id)}
                          >
                            {expanded.has(u.id) ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          <Badge
                            variant="outline"
                            className="bg-red-50 text-red-700 border-red-200 font-mono"
                          >
                            <ArrowDown className="h-3 w-3 mr-1" />
                            {u.code}
                          </Badge>
                        </TableCell>
                        <TableCell>{format(new Date(u.usage_date), 'dd/MM/yyyy')}</TableCell>
                        <TableCell>
                          {u.job ? (
                            <Link
                              to="/tasks"
                              className="text-blue-600 hover:underline font-mono text-xs"
                              title={u.job.title}
                            >
                              {u.job.code}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground text-xs">(không gắn job)</span>
                          )}
                          {u.job && (
                            <span className="text-muted-foreground text-xs ml-1.5">
                              — {u.job.title}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          <span>{u.creator?.full_name ?? '—'}</span>
                          <span
                            className="text-muted-foreground ml-1"
                            title={format(new Date(u.created_at), 'dd/MM/yyyy HH:mm')}
                          >
                            · {format(new Date(u.created_at), 'HH:mm')}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {totalQty.toLocaleString('vi-VN')}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {totalCost.toLocaleString('vi-VN')} đ
                        </TableCell>
                      </TableRow>
                      {expanded.has(u.id) && (
                        <TableRow>
                          <TableCell colSpan={7} className="p-0 bg-muted/30">
                            <div className="px-6 py-3">
                              <div className="text-xs text-muted-foreground uppercase mb-2 font-semibold">
                                Chi tiết phiếu xuất
                              </div>
                              <div className="overflow-x-auto border rounded bg-background">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Vật tư</TableHead>
                                      <TableHead className="text-right">Số lượng</TableHead>
                                      <TableHead className="text-right">Giá vốn lúc xuất</TableHead>
                                      <TableHead className="text-right">Thành tiền</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {u.items.length === 0 ? (
                                      <TableRow>
                                        <TableCell
                                          colSpan={4}
                                          className="text-muted-foreground text-center py-4"
                                        >
                                          Phiếu này chưa có dòng nào.
                                        </TableCell>
                                      </TableRow>
                                    ) : (
                                      u.items.map((it) => (
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
                                            {Number(it.unit_cost_at_usage).toLocaleString('vi-VN')}
                                          </TableCell>
                                          <TableCell className="text-right font-mono">
                                            {(
                                              Number(it.quantity) * Number(it.unit_cost_at_usage)
                                            ).toLocaleString('vi-VN')}
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
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <MaterialUsageFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </div>
  );
}
