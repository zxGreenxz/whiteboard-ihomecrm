import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus, Search, Pencil, Trash2, MapPin } from 'lucide-react';
import { useAreas, Area } from '@/hooks/useAreas';
import { Skeleton } from '@/components/ui/skeleton';
import CreateAreaDialog from '@/components/areas/CreateAreaDialog';
import EditAreaDialog from '@/components/areas/EditAreaDialog';
import DeleteAreaDialog from '@/components/areas/DeleteAreaDialog';

const AreasPage = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingArea, setEditingArea] = useState<Area | null>(null);
  const [deletingArea, setDeletingArea] = useState<Area | null>(null);

  const { data: areas, isLoading } = useAreas();

  // Filter areas based on search and status
  const filteredAreas = areas?.filter((area) => {
    const matchesSearch =
      area.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      area.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      area.description?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || area.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <MapPin className="h-8 w-8" />
              Quản lý Khu vực
            </h1>
            <p className="text-muted-foreground mt-1">
              Quản lý các khu vực chứa tòa nhà
            </p>
          </div>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Tạo khu vực
          </Button>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle>Tìm kiếm & Lọc</CardTitle>
            <CardDescription>
              Tìm kiếm theo mã, tên, mô tả hoặc lọc theo trạng thái
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Tìm kiếm khu vực..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(value: 'all' | 'active' | 'inactive') =>
                  setStatusFilter(value)
                }
              >
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue placeholder="Trạng thái" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả trạng thái</SelectItem>
                  <SelectItem value="active">Hoạt động</SelectItem>
                  <SelectItem value="inactive">Không hoạt động</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Areas Table */}
        <Card>
          <CardHeader>
            <CardTitle>Danh sách khu vực</CardTitle>
            <CardDescription>
              {filteredAreas
                ? `Hiển thị ${filteredAreas.length} khu vực`
                : 'Đang tải...'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : filteredAreas && filteredAreas.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã</TableHead>
                      <TableHead>Tên khu vực</TableHead>
                      <TableHead>Mô tả</TableHead>
                      <TableHead className="text-center">Số tòa nhà</TableHead>
                      <TableHead className="text-center">Trạng thái</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAreas.map((area) => (
                      <TableRow key={area.id}>
                        <TableCell className="font-medium">{area.code}</TableCell>
                        <TableCell className="font-medium">{area.name}</TableCell>
                        <TableCell className="text-muted-foreground max-w-xs truncate">
                          {area.description || '—'}
                        </TableCell>
                        <TableCell className="text-center">
                          {area.buildings_count || 0}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge
                            variant={area.status === 'active' ? 'default' : 'secondary'}
                          >
                            {area.status === 'active' ? 'Hoạt động' : 'Không hoạt động'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingArea(area)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeletingArea(area)}
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
            ) : (
              <div className="text-center py-12">
                <MapPin className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">
                  {searchQuery || statusFilter !== 'all'
                    ? 'Không tìm thấy khu vực nào phù hợp'
                    : 'Chưa có khu vực nào. Hãy tạo khu vực đầu tiên!'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Dialogs */}
      <CreateAreaDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
      />
      <EditAreaDialog
        area={editingArea}
        open={!!editingArea}
        onOpenChange={(open) => !open && setEditingArea(null)}
      />
      <DeleteAreaDialog
        area={deletingArea}
        open={!!deletingArea}
        onOpenChange={(open) => !open && setDeletingArea(null)}
      />
    </MainLayout>
  );
};

export default AreasPage;
