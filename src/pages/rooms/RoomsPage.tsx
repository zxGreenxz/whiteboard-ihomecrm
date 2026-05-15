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
import RoomQRDialog from '@/components/rooms/RoomQRDialog';

import { useRooms, useUpdateRoomStatus } from '@/hooks/useRooms';
import { useBuildings } from '@/hooks/useBuildings';
import { useFloors } from '@/hooks/useFloors';
import type { RoomWithRelations } from '@/types/room';
import type { BuildingWithRelations } from '@/types/building';
import { useQueryClient } from '@tanstack/react-query';

export default function RoomsPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // Pre-filter from URL query param
  const preselectedBuildingId = searchParams.get('building_id') || '';

  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [buildingFilter, setBuildingFilter] = useState(preselectedBuildingId || 'all');
  const [floorFilter, setFloorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<RoomWithRelations | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // Sync building filter with URL param on mount
  useEffect(() => {
    if (preselectedBuildingId) {
      setBuildingFilter(preselectedBuildingId);
    }
  }, [preselectedBuildingId]);

  // Data
  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as BuildingWithRelations[],
    [buildingsData]
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

  // Client-side filtering
  const filteredRooms = useMemo(() => {
    return rooms.filter((room) => {
      // Search filter: name, code (case-insensitive)
      const term = searchTerm.toLowerCase();
      const matchesSearch =
        !searchTerm ||
        room.name.toLowerCase().includes(term) ||
        room.code?.toLowerCase().includes(term);

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

      return matchesSearch && matchesBuilding && matchesFloor && matchesStatus;
    });
  }, [rooms, searchTerm, buildingFilter, floorFilter, statusFilter]);

  // Handlers
  const handleEdit = (room: RoomWithRelations) => {
    setSelectedRoom(room);
    setEditDialogOpen(true);
  };

  const handleDelete = (room: RoomWithRelations) => {
    setSelectedRoom(room);
    setDeleteDialogOpen(true);
  };

  const handleShowQR = (room: RoomWithRelations) => {
    setSelectedRoom(room);
    setQrDialogOpen(true);
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

  const hasFilters = searchTerm || buildingFilter !== 'all' || floorFilter !== 'all' || statusFilter !== 'all';

  return (
    <MainLayout title="Căn hộ" subtitle="Danh mục dữ liệu > Căn hộ" icon={Home}>
      <div className="space-y-4">
        {/* Filters */}
        <RoomListFilters
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          buildingFilter={buildingFilter}
          onBuildingChange={setBuildingFilter}
          floorFilter={floorFilter}
          onFloorChange={setFloorFilter}
          statusFilter={statusFilter}
          onStatusChange={setStatusFilter}
          buildings={buildings}
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
              onShowQR={handleShowQR}
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
            <RoomQRDialog
              open={qrDialogOpen}
              onOpenChange={setQrDialogOpen}
              roomId={selectedRoom.id}
              roomLabel={selectedRoom.code || selectedRoom.name}
            />
          </>
        )}
      </div>
    </MainLayout>
  );
}
