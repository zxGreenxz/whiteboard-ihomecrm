import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Home, Plus, Search, RefreshCw, LayoutGrid, List } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import EmptyState from '@/components/ui/EmptyState';
import RoomListFilters from '@/components/rooms/RoomListFilters';
import RoomListTable from '@/components/rooms/RoomListTable';
import { DeleteRoomDialog } from '@/components/rooms/DeleteRoomDialog';
import RoomFormDialog from '@/components/rooms/RoomFormDialog';

import { useRooms, useUpdateRoomStatus } from '@/hooks/useRooms';
import { useBuildings } from '@/hooks/useBuildings';
import { useAreas } from '@/hooks/useAreas';
import { useFloors } from '@/hooks/useFloors';
import type { RoomWithRelations } from '@/types/room';
import type { BuildingWithRelations } from '@/types/building';
import { useQueryClient } from '@tanstack/react-query';
import { compareBuildingThenRoom } from '@/lib/roomSort';

export default function RoomsPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // Pre-filter from URL query param
  const preselectedBuildingId = searchParams.get('building_id') || '';

  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [areaFilter, setAreaFilter] = useState('all');
  const [buildingFilter, setBuildingFilter] = useState(preselectedBuildingId || 'all');
  const [floorFilter, setFloorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<RoomWithRelations | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // Sync building filter with URL param on mount
  useEffect(() => {
    if (preselectedBuildingId) {
      setBuildingFilter(preselectedBuildingId);
    }
  }, [preselectedBuildingId]);

  // Data
  const { data: areasData } = useAreas();
  const areas = useMemo(
    () => (Array.isArray(areasData) ? areasData : []),
    [areasData]
  );

  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as BuildingWithRelations[],
    [buildingsData]
  );

  // Toà nhà thuộc khu vực đang lọc (để giới hạn dropdown toà nhà cho khớp)
  const buildingsInArea = useMemo(
    () =>
      areaFilter === 'all'
        ? buildings
        : buildings.filter((b) => b.area_id === areaFilter),
    [buildings, areaFilter]
  );

  const { data: floorsData } = useFloors(buildingFilter !== 'all' ? buildingFilter : undefined);
  const floors = useMemo(
    () => (Array.isArray(floorsData) ? floorsData : []),
    [floorsData]
  );

  const { data: roomsData, isLoading } = useRooms();
  const rooms = useMemo(
    () => (Array.isArray(roomsData) ? roomsData : []) as RoomWithRelations[],
    [roomsData]
  );

  const updateStatus = useUpdateRoomStatus();

  // Client-side filtering + sắp xếp: gom theo toà nhà rồi theo tên phòng
  // (MB* → G* → L* → 1,2,3,4...)
  const filteredRooms = useMemo(() => {
    const result = rooms.filter((room) => {
      // Search filter: name, code (case-insensitive)
      const term = searchTerm.toLowerCase();
      const matchesSearch =
        !searchTerm ||
        room.name.toLowerCase().includes(term) ||
        room.code?.toLowerCase().includes(term);

      // Area (khu vực) filter — khu vực nằm ở toà nhà của phòng
      const matchesArea =
        areaFilter === 'all' || room.building?.area_id === areaFilter;

      // Building filter
      const matchesBuilding =
        buildingFilter === 'all' || room.building_id === buildingFilter;

      // Floor filter
      const matchesFloor =
        floorFilter === 'all' || room.floor === parseInt(floorFilter);

      // Status filter (ACTIVE = AVAILABLE, INACTIVE = UNAVAILABLE)
      let matchesStatus = true;
      if (statusFilter === 'ACTIVE') {
        matchesStatus = room.status === 'AVAILABLE';
      } else if (statusFilter === 'INACTIVE') {
        matchesStatus = room.status === 'UNAVAILABLE';
      }

      return matchesSearch && matchesArea && matchesBuilding && matchesFloor && matchesStatus;
    });

    return result.sort((a, b) =>
      compareBuildingThenRoom(
        a.building?.name ?? '',
        a.name ?? '',
        b.building?.name ?? '',
        b.name ?? '',
      ),
    );
  }, [rooms, searchTerm, areaFilter, buildingFilter, floorFilter, statusFilter]);

  // Handlers
  const handleEdit = (room: RoomWithRelations) => {
    setSelectedRoom(room);
    setEditDialogOpen(true);
  };

  const handleDelete = (room: RoomWithRelations) => {
    setSelectedRoom(room);
    setDeleteDialogOpen(true);
  };

  const handleToggleStatus = (id: string, isActive: boolean) => {
    updateStatus.mutate({
      id,
      status: isActive ? 'AVAILABLE' : 'UNAVAILABLE',
    });
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['rooms'] });
  };

  // Đổi khu vực → reset toà nhà + tầng (toà nhà cũ có thể không thuộc khu vực mới)
  const handleAreaChange = (value: string) => {
    setAreaFilter(value);
    setBuildingFilter('all');
    setFloorFilter('all');
  };

  const hasFilters = searchTerm || areaFilter !== 'all' || buildingFilter !== 'all' || floorFilter !== 'all' || statusFilter !== 'all';

  return (
    <MainLayout title="Căn hộ" subtitle="Danh mục dữ liệu > Căn hộ" icon={Home}>
      <div className="space-y-4">
        {/* Filters */}
        <RoomListFilters
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          areaFilter={areaFilter}
          onAreaChange={handleAreaChange}
          buildingFilter={buildingFilter}
          onBuildingChange={setBuildingFilter}
          floorFilter={floorFilter}
          onFloorChange={setFloorFilter}
          statusFilter={statusFilter}
          onStatusChange={setStatusFilter}
          areas={areas}
          buildings={buildingsInArea}
          floors={floors}
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
          ) : filteredRooms.length === 0 ? (
            hasFilters ? (
              <div className="p-8 text-center text-muted-foreground">
                Không tìm thấy căn hộ nào
              </div>
            ) : (
              <EmptyState
                icon={Home}
                title="Chưa có căn hộ nào"
                description="Hãy thêm căn hộ đầu tiên để bắt đầu quản lý"
                actionLabel="Thêm căn hộ"
                onAction={() => setCreateDialogOpen(true)}
              />
            )
          ) : (
            <RoomListTable
              rooms={filteredRooms}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleStatus={handleToggleStatus}
            />
          )}
        </div>

        {/* Room Form Dialog */}
        <RoomFormDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          preselectedBuildingId={buildingFilter !== 'all' ? buildingFilter : undefined}
        />

        {selectedRoom && (
          <>
            <RoomFormDialog
              open={editDialogOpen}
              onOpenChange={setEditDialogOpen}
              room={selectedRoom}
            />
            <DeleteRoomDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              room={selectedRoom}
            />
          </>
        )}
      </div>
    </MainLayout>
  );
}
