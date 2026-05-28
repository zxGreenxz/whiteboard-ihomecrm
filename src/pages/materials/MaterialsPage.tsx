import { useMemo, useState } from 'react';
import { Plus, Search, Tag, Pencil, Trash2, MoreHorizontal, FolderTree } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { StockBadge } from '@/components/materials/StockBadge';
import MaterialFormDialog from '@/components/materials/MaterialFormDialog';
import MaterialCategoryFormDialog from '@/components/materials/MaterialCategoryFormDialog';
import { useMaterials, useSoftDeleteMaterial } from '@/hooks/useMaterials';
import {
  useMaterialCategories,
  useDeleteMaterialCategory,
} from '@/hooks/useMaterialCategories';
import type { Material, MaterialCategory } from '@/types/material';

const ALL = '__all__';

export default function MaterialsPage() {
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string>(ALL);
  const [tab, setTab] = useState<'all' | 'low'>('all');

  const filters = useMemo(
    () => ({
      search,
      categoryId: categoryId === ALL ? null : categoryId,
      onlyLowStock: tab === 'low',
    }),
    [search, categoryId, tab],
  );

  const { data: materials = [], isLoading } = useMaterials(filters);
  const { data: categories = [] } = useMaterialCategories();
  const softDelete = useSoftDeleteMaterial();
  const deleteCat = useDeleteMaterialCategory();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Material | null>(null);

  const [catFormOpen, setCatFormOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<MaterialCategory | null>(null);
  const [deleteCatTarget, setDeleteCatTarget] = useState<MaterialCategory | null>(null);
  const [showCategoriesPanel, setShowCategoriesPanel] = useState(false);

  const lowStockCount = useMemo(
    () => materials.filter((m) => Number(m.on_hand) <= Number(m.reorder_level)).length,
    [materials],
  );

  return (
    <MainLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold">Kho vật tư tiêu hao</h1>
            <p className="text-sm text-muted-foreground">
              Quản lý vòi nước, bóng đèn, ống nước, v.v. — tồn cập nhật tự động khi
              nhập/xuất theo phiếu công việc.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setShowCategoriesPanel((v) => !v)}
              className="gap-1.5"
            >
              <FolderTree className="h-4 w-4" />
              Danh mục
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Thêm vật tư
            </Button>
          </div>
        </div>

        {showCategoriesPanel && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">Danh mục vật tư</CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingCat(null);
                  setCatFormOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Thêm danh mục
              </Button>
            </CardHeader>
            <CardContent>
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">
                  Chưa có danh mục nào. Tạo danh mục để gom nhóm vật tư.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {categories.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center gap-1 rounded-md border bg-muted/30 pl-3 pr-1 py-1"
                    >
                      <Tag className="h-3 w-3" />
                      <span className="text-sm font-medium">{c.name}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-6 w-6">
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditingCat(c);
                              setCatFormOpen(true);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Sửa
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-600"
                            onClick={() => setDeleteCatTarget(c)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Xoá
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-3 md:p-4 space-y-3">
            <div className="flex flex-col md:flex-row gap-2 md:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Tìm theo tên, mã, mô tả…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger className="md:w-56">
                  <SelectValue placeholder="Mọi danh mục" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Mọi danh mục</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as 'all' | 'low')}>
              <TabsList>
                <TabsTrigger value="all">
                  Tất cả <Badge variant="outline" className="ml-1.5">{materials.length}</Badge>
                </TabsTrigger>
                <TabsTrigger value="low">
                  Sắp hết
                  {lowStockCount > 0 && (
                    <Badge variant="destructive" className="ml-1.5">
                      {lowStockCount}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">Mã</TableHead>
                    <TableHead>Tên</TableHead>
                    <TableHead>Danh mục</TableHead>
                    <TableHead>Đơn vị</TableHead>
                    <TableHead className="text-right">Tồn / Cảnh báo</TableHead>
                    <TableHead className="text-right">Giá vốn (TB)</TableHead>
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
                  ) : materials.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        Chưa có vật tư. Bấm "Thêm vật tư" để bắt đầu.
                      </TableCell>
                    </TableRow>
                  ) : (
                    materials.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono text-xs">{m.code ?? '—'}</TableCell>
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {m.category?.name ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{m.unit}</TableCell>
                        <TableCell className="text-right">
                          <StockBadge
                            onHand={Number(m.on_hand)}
                            reorderLevel={Number(m.reorder_level)}
                            unit={m.unit}
                          />
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {Number(m.avg_unit_cost).toLocaleString('vi-VN')}
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
                                  setEditing(m);
                                  setFormOpen(true);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5 mr-2" /> Sửa
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-red-600 focus:text-red-600"
                                onClick={() => setDeleteTarget(m)}
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-2" /> Xoá
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <MaterialFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />
      <MaterialCategoryFormDialog
        open={catFormOpen}
        onOpenChange={setCatFormOpen}
        editing={editingCat}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá vật tư?</AlertDialogTitle>
            <AlertDialogDescription>
              Vật tư <b>{deleteTarget?.name}</b> sẽ được đánh dấu xoá. Lịch sử
              phiếu nhập/xuất/kiểm kê liên quan vẫn được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={async () => {
                if (!deleteTarget) return;
                await softDelete.mutateAsync(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteCatTarget} onOpenChange={(o) => !o && setDeleteCatTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá danh mục?</AlertDialogTitle>
            <AlertDialogDescription>
              Danh mục <b>{deleteCatTarget?.name}</b> sẽ bị xoá vĩnh viễn. Nếu
              danh mục đang được dùng cho vật tư nào, thao tác sẽ bị chặn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={async () => {
                if (!deleteCatTarget) return;
                try {
                  await deleteCat.mutateAsync(deleteCatTarget.id);
                  setDeleteCatTarget(null);
                } catch {
                  /* toast */
                }
              }}
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
