import { useState, useMemo, useEffect, useCallback, lazy, Suspense } from "react";
import { usePhoneViewport } from "@/hooks/use-mobile";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Input } from "@/components/ui/input";
import { RoomCard, RoomStatus } from "@/components/building-map/RoomCard";
import { RoomDetailDialog } from "@/components/building-map/RoomDetailDialog";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useFloors } from "@/hooks/useFloors";
import { useRoomsWithActiveContracts } from "@/hooks/useRoomsWithContracts";
import { getRoomDisplayStatus } from "@/lib/roomStatus";
import { Building2, Layers, Search, Filter } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { differenceInDays } from "date-fns";
import { usePersistedState } from "@/hooks/usePersistedState";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "Tất cả trạng thái" },
  { value: "OCCUPIED", label: "Đang thuê" },
  { value: "RESERVED", label: "Đã đặt cọc" },
  { value: "AVAILABLE", label: "Trống" },
  { value: "EXPIRING_SOON", label: "Sắp trống" },
  { value: "MAINTENANCE", label: "Ngừng hoạt động" },
];

const BuildingMapDesktop = () => {
  const [selectedBuildingId, setSelectedBuildingId] = usePersistedState<string>("flt:building-map:buildingId", "");
  const [selectedFloor, setSelectedFloor] = usePersistedState<string>("flt:building-map:floor", "all");
  const [selectedStatus, setSelectedStatus] = usePersistedState<string>("flt:building-map:status", "all");
  const [searchQuery, setSearchQuery] = usePersistedState<string>("flt:building-map:search", "");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);

  const { data: buildings = [], isLoading: buildingsLoading } = useBuildings();
  // Chỉ kéo phòng của toà đang chọn — kéo MỌI toà vừa thừa vừa dính cap 1000
  // dòng PostgREST → org lớn THIẾU phòng âm thầm trên sơ đồ. Chưa chọn toà
  // (chờ auto-select bên dưới) thì khỏi fetch.
  const { data: rooms = [], isLoading: roomsLoading } = useRooms(
    selectedBuildingId || undefined,
    { enabled: !!selectedBuildingId }
  );
  const { data: floors = [], isLoading: floorsLoading } = useFloors(selectedBuildingId || undefined);

  // Auto-select first building if none selected — trong effect, KHÔNG setState
  // giữa thân render (gây double render toàn trang).
  useEffect(() => {
    if (!selectedBuildingId && buildings.length > 0) {
      setSelectedBuildingId(buildings[0].id);
    }
  }, [selectedBuildingId, buildings]);

  // Dropdown toà nhà (đơn-chọn vì bản đồ vẽ 1 toà): gõ được cả TÊN KHU VỰC
  // để thu hẹp nhanh — thay cho dropdown "Khu vực" riêng trước đây.
  const buildingOptions = useMemo(
    () =>
      buildings.map((building) => {
        const areaNames: string[] = ((building as any).areas ?? []).map(
          (a: { name: string }) => a.name,
        );
        return {
          value: building.id,
          label: building.name,
          keywords: areaNames.length ? areaNames : undefined,
        };
      }),
    [buildings]
  );

  // Phòng kèm hợp đồng đang hiệu lực (ACTIVE/EXTENDED) của toà đang chọn
  const { data: roomsWithContracts = [] } = useRoomsWithActiveContracts(
    selectedBuildingId || undefined
  );

  const contractByRoomId = useMemo(() => {
    const map = new Map<string, (typeof roomsWithContracts)[number]>();
    roomsWithContracts.forEach((r) => map.set(r.id, r));
    return map;
  }, [roomsWithContracts]);

  // Determine room status with contract info
  const getRoomStatus = (room: any): RoomStatus =>
    getRoomDisplayStatus(
      room.status,
      contractByRoomId.get(room.id)?.activeContract?.end_date
    );

  // Filter rooms by floor, status, and search query (query đã scope theo toà)
  const filteredRooms = useMemo(() => {
    let scoped = rooms;

    if (selectedFloor !== "all") {
      scoped = scoped.filter(r => r.floor === parseInt(selectedFloor));
    }

    const enrichedRooms = scoped.map(room => {
      const contract = contractByRoomId.get(room.id);
      return {
        ...room,
        displayStatus: getRoomStatus(room),
        tenantName: contract?.activeContract?.tenant?.full_name,
        daysUntilExpiry: contract?.activeContract
          ? differenceInDays(new Date(contract.activeContract.end_date), new Date())
          : undefined,
      };
    });

    // Filter by status
    let result = enrichedRooms;
    if (selectedStatus !== "all") {
      result = result.filter(r => r.displayStatus === selectedStatus);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter(r =>
        r.name.toLowerCase().includes(query) ||
        r.tenantName?.toLowerCase().includes(query)
      );
    }

    return result;
  }, [rooms, selectedFloor, selectedStatus, searchQuery, contractByRoomId]);

  // Group rooms by floor for display
  const roomsByFloor = useMemo(() => {
    if (selectedFloor !== "all") return null; // Not needed when specific floor selected

    const grouped: Record<number, typeof filteredRooms> = {};
    filteredRooms.forEach(room => {
      const floor = room.floor ?? 0;
      if (!grouped[floor]) grouped[floor] = [];
      grouped[floor].push(room);
    });

    return Object.entries(grouped)
      .sort(([a], [b]) => Number(a) - Number(b));
  }, [filteredRooms, selectedFloor]);

  // Statistics — all rooms for the selected building (before status/search filters)
  const stats = useMemo(() => {
    const enriched = rooms.map(room => ({
      ...room,
      displayStatus: getRoomStatus(room),
    }));

    const total = enriched.length;
    const occupied = enriched.filter(r => r.displayStatus === "OCCUPIED").length;
    const available = enriched.filter(r => r.displayStatus === "AVAILABLE").length;
    const reserved = enriched.filter(r => r.displayStatus === "RESERVED").length;
    const expiring = enriched.filter(r => r.displayStatus === "EXPIRING_SOON").length;
    const maintenance = enriched.filter(r => r.displayStatus === "MAINTENANCE").length;

    return { total, occupied, available, reserved, expiring, maintenance };
  }, [rooms, contractByRoomId]);

  // useCallback: RoomCard đã memo — handler mới mỗi render sẽ vô hiệu memo.
  const handleRoomClick = useCallback((roomId: string) => {
    setSelectedRoomId(roomId);
    setDetailDialogOpen(true);
  }, []);

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sơ đồ Tòa nhà</h1>
          <p className="text-muted-foreground mt-1">
            Xem trực quan tình trạng căn hộ theo tòa nhà và tầng
          </p>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Filter className="w-5 h-5" />
              Bộ lọc
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {/* Building filter — gõ tên toà hoặc tên khu vực để tìm */}
              {buildingsLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <SearchableSelect
                  value={selectedBuildingId}
                  onValueChange={(val) => {
                    setSelectedBuildingId(val);
                    setSelectedFloor("all");
                  }}
                  placeholder="Chọn tòa nhà"
                  searchPlaceholder="Tìm tòa / khu vực..."
                  options={buildingOptions}
                />
              )}

              {/* Floor filter */}
              <SearchableSelect
                value={selectedFloor}
                onValueChange={setSelectedFloor}
                placeholder="Chọn tầng"
                options={[
                  { value: "all", label: "Tất cả tầng" },
                  ...floors.map((floor) => ({
                    value: floor.floor_number.toString(),
                    label: floor.name || `Tầng ${floor.floor_number}`,
                  })),
                ]}
              />

              {/* Status filter */}
              <SearchableSelect
                value={selectedStatus}
                onValueChange={setSelectedStatus}
                placeholder="Trạng thái"
                options={STATUS_OPTIONS.map((opt) => ({
                  value: opt.value,
                  label: opt.label,
                }))}
              />

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Tìm căn hộ..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {selectedBuildingId && (
          <>
            {/* Statistics */}
            <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{stats.total}</div>
                  <p className="text-xs text-muted-foreground">Tổng căn hộ</p>
                </CardContent>
              </Card>

              <Card className="border-l-4 border-l-green-500">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-green-700">{stats.occupied}</div>
                  <p className="text-xs text-muted-foreground">Đang thuê</p>
                </CardContent>
              </Card>

              <Card className="border-l-4 border-l-orange-500">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-orange-700">{stats.reserved}</div>
                  <p className="text-xs text-muted-foreground">Đã đặt cọc</p>
                </CardContent>
              </Card>

              <Card className="border-l-4 border-l-red-500">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-red-700">{stats.available}</div>
                  <p className="text-xs text-muted-foreground">Trống</p>
                </CardContent>
              </Card>

              <Card className="border-l-4 border-l-purple-500">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-purple-700">{stats.expiring}</div>
                  <p className="text-xs text-muted-foreground">Sắp trống</p>
                </CardContent>
              </Card>

              <Card className="border-l-4 border-l-gray-400">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-gray-700">{stats.maintenance}</div>
                  <p className="text-xs text-muted-foreground">Ngừng hoạt động</p>
                </CardContent>
              </Card>
            </div>

            {/* Color Legend */}
            <div className="flex flex-wrap gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-green-500" />
                <span>Đang thuê</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-orange-500" />
                <span>Đã đặt cọc</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500" />
                <span>Trống</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-purple-500" />
                <span>Sắp trống</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-gray-400" />
                <span>Ngừng hoạt động</span>
              </div>
            </div>

            {/* Room Grid */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-5 h-5" />
                  Sơ đồ căn hộ
                </CardTitle>
                <CardDescription>
                  Click vào căn hộ để xem chi tiết thông tin
                </CardDescription>
              </CardHeader>
              <CardContent>
                {roomsLoading || floorsLoading ? (
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                    {[...Array(10)].map((_, i) => (
                      <Skeleton key={i} className="h-32" />
                    ))}
                  </div>
                ) : filteredRooms.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Building2 className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>Không tìm thấy căn hộ nào</p>
                    {(searchQuery || selectedStatus !== "all" || selectedFloor !== "all") && (
                      <p className="text-sm mt-1">Thử thay đổi bộ lọc hoặc từ khóa tìm kiếm</p>
                    )}
                  </div>
                ) : selectedFloor !== "all" ? (
                  /* Single floor view */
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                    {filteredRooms.map((room) => (
                      <RoomCard
                        key={room.id}
                        id={room.id}
                        name={room.name}
                        price={room.rent_price}
                        status={room.displayStatus}
                        tenantName={room.tenantName}
                        daysUntilExpiry={room.daysUntilExpiry}
                        onClick={handleRoomClick}
                      />
                    ))}
                  </div>
                ) : (
                  /* All floors view - grouped by floor */
                  <div className="space-y-8">
                    {roomsByFloor?.map(([floorNum, rooms]) => {
                      const floorInfo = floors.find(f => f.floor_number === Number(floorNum));
                      return (
                        <div key={floorNum}>
                          <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
                            <Layers className="w-4 h-4" />
                            {floorInfo?.name || `Tầng ${floorNum}`}
                            <span className="text-sm font-normal text-muted-foreground">
                              ({rooms.length} căn hộ)
                            </span>
                          </h3>
                          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                            {rooms.map((room) => (
                              <RoomCard
                                key={room.id}
                                id={room.id}
                                name={room.name}
                                price={room.rent_price}
                                status={room.displayStatus}
                                tenantName={room.tenantName}
                                daysUntilExpiry={room.daysUntilExpiry}
                                onClick={handleRoomClick}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {!selectedBuildingId && !buildingsLoading && buildings.length === 0 && (
          <Card>
            <CardContent className="pt-12 pb-12 text-center">
              <Building2 className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
              <p className="text-lg text-muted-foreground mb-2">
                Chưa có tòa nhà nào
              </p>
              <p className="text-sm text-muted-foreground">
                Vui lòng tạo tòa nhà và căn hộ trước khi sử dụng sơ đồ
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Room Detail Dialog */}
      <RoomDetailDialog
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        roomId={selectedRoomId}
      />
    </MainLayout>
  );
};

const BuildingMapMobilePage = lazy(() => import("./BuildingMapMobilePage"));

export default function BuildingMapPage() {
  const isPhone = usePhoneViewport();
  if (isPhone)
    return (
      <Suspense fallback={null}>
        <BuildingMapMobilePage />
      </Suspense>
    );
  return <BuildingMapDesktop />;
}
