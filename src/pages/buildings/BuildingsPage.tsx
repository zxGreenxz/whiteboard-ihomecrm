import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Plus, Search, RefreshCw, LayoutGrid, List } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import EmptyState from '@/components/ui/EmptyState';
import BuildingStatsCards from '@/components/buildings/BuildingStatsCards';
import BuildingListFilters from '@/components/buildings/BuildingListFilters';
import BuildingListTable from '@/components/buildings/BuildingListTable';
import { DeleteBuildingDialog } from '@/components/buildings/DeleteBuildingDialog';
import BuildingFormDialog from '@/components/buildings/BuildingFormDialog';
import { useBuildings, useUpdateBuildingStatus } from '@/hooks/useBuildings';
import { useAreas } from '@/hooks/useAreas';
import type { BuildingWithRelations } from '@/types/building';
import { useQueryClient } from '@tanstack/react-query';

export default function BuildingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: buildingsData, isLoading } = useBuildings();
  const { data: areasData } = useAreas();
  const updateStatus = useUpdateBuildingStatus();

  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as BuildingWithRelations[],
    [buildingsData]
  );
  const areas = useMemo(
    () => (Array.isArray(areasData) ? areasData : []),
    [areasData]
  );

  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [areaFilter, setAreaFilter] = useState('all');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState<BuildingWithRelations | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editBuilding, setEditBuilding] = useState<BuildingWithRelations | undefined>(undefined);

  // Phạm vi cho thẻ thống kê: lọc theo tìm kiếm + khu vực (KHÔNG theo bộ lọc trạng thái).
  // Nhờ vậy 3 thẻ vẫn là phân tích Đang/Ngừng hoạt động đầy đủ của phạm vi đang xem;
  // nếu áp luôn bộ lọc trạng thái thì thẻ còn lại sẽ luôn bằng 0.
  const scopedBuildings = useMemo(() => {
    return buildings.filter((building) => {
      // Search filter: name, code, street_address (case-insensitive)
      const term = searchTerm.toLowerCase();
      const matchesSearch =
        !searchTerm ||
        building.name.toLowerCase().includes(term) ||
        building.code?.toLowerCase().includes(term) ||
        building.street_address?.toLowerCase().includes(term);

      // Area filter
      const matchesArea =
        areaFilter === 'all' || building.area_id === areaFilter;

      return matchesSearch && matchesArea;
    });
  }, [buildings, searchTerm, areaFilter]);

  // Stats theo phạm vi tìm kiếm + khu vực (cập nhật khi đổi bộ lọc)
  const stats = useMemo(() => {
    const total = scopedBuildings.length;
    const active = scopedBuildings.filter((b) => b.status === 'ACTIVE').length;
    const inactive = scopedBuildings.filter((b) => b.status === 'INACTIVE').length;
    return { total, active, inactive };
  }, [scopedBuildings]);

  // Bảng áp thêm bộ lọc trạng thái lên phạm vi trên
  const filteredBuildings = useMemo(() => {
    return scopedBuildings.filter(
      (building) => statusFilter === 'all' || building.status === statusFilter
    );
  }, [scopedBuildings, statusFilter]);

  // Handlers
  const handleEdit = (building: BuildingWithRelations) => {
    setEditBuilding(building);
    setEditDialogOpen(true);
  };

  const handleDelete = (building: BuildingWithRelations) => {
    setSelectedBuilding(building);
    setDeleteDialogOpen(true);
  };

  const handleToggleStatus = (id: string, newStatus: 'ACTIVE' | 'INACTIVE') => {
    updateStatus.mutate({ id, status: newStatus });
  };

  const handleViewRooms = (buildingId: string) => {
    navigate(`/apartments?building_id=${buildingId}`);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['buildings'] });
  };

  return (
    <MainLayout title="Toà nhà" subtitle="Danh mục dữ liệu > Toà nhà" icon={Building2}>
      <div className="space-y-4">
        {/* Stats Cards */}
        <BuildingStatsCards
          total={stats.total}
          active={stats.active}
          inactive={stats.inactive}
        />

        {/* Filters */}
        <BuildingListFilters
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          statusFilter={statusFilter}
          onStatusChange={setStatusFilter}
          areaFilter={areaFilter}
          onAreaChange={setAreaFilter}
          areas={areas}
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button onClick={() => setCreateDialogOpen(true)} size="sm">
              <Plus className="h-4 w-4 mr-1" />
              Thêm
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Tìm kiếm">
              <Search className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleRefresh}
              title="Làm mới"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode('grid')}
              title="Dạng lưới"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode('list')}
              title="Dạng danh sách"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Table / Content */}
        <div className="bg-white rounded-lg border">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu...</div>
          ) : filteredBuildings.length === 0 ? (
            searchTerm || statusFilter !== 'all' || areaFilter !== 'all' ? (
              <div className="p-8 text-center text-muted-foreground">
                Không tìm thấy toà nhà nào
              </div>
            ) : (
              <EmptyState
                icon={Building2}
                title="Chưa có toà nhà nào"
                description="Hãy thêm toà nhà đầu tiên để bắt đầu quản lý"
                actionLabel="Thêm toà nhà"
                onAction={() => setCreateDialogOpen(true)}
              />
            )
          ) : (
            <BuildingListTable
              buildings={filteredBuildings}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleStatus={handleToggleStatus}
              onViewRooms={handleViewRooms}
            />
          )}
        </div>

        {/* Delete Dialog */}
        {selectedBuilding && (
          <DeleteBuildingDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            building={selectedBuilding}
          />
        )}

        {/* Create Dialog */}
        <BuildingFormDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />

        {/* Edit Dialog */}
        <BuildingFormDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          building={editBuilding}
        />
      </div>
    </MainLayout>
  );
}
