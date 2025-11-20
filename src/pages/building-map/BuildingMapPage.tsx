import { useState, useMemo } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RoomCard, RoomStatus } from "@/components/building-map/RoomCard";
import { RoomDetailDialog } from "@/components/building-map/RoomDetailDialog";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Building2, Layers } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { differenceInDays } from "date-fns";

interface RoomWithContract {
  id: string;
  name: string;
  rent_price: number;
  floor: number;
  status: string;
  activeContract?: {
    id: string;
    end_date: string;
    tenant?: {
      full_name: string;
    };
  };
}

const BuildingMapPage = () => {
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>("");
  const [selectedFloor, setSelectedFloor] = useState<string>("all");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);

  const { data: buildings = [], isLoading: buildingsLoading } = useBuildings();
  const { data: allRooms = [], isLoading: roomsLoading } = useRooms();

  // Get rooms with active contracts
  const { data: roomsWithContracts = [] } = useQuery({
    queryKey: ["rooms-with-contracts", selectedBuildingId],
    queryFn: async (): Promise<RoomWithContract[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const query = supabase
        .from("rooms")
        .select(`
          id,
          name,
          rent_price,
          floor,
          status,
          contracts!inner(
            id,
            end_date,
            status,
            tenant:tenants(
              full_name
            )
          )
        `)
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .eq("contracts.status", "ACTIVE");

      if (selectedBuildingId) {
        query.eq("building_id", selectedBuildingId);
      }

      const { data, error } = await query;
      if (error) throw error;

      return data.map((room: any) => ({
        id: room.id,
        name: room.name,
        rent_price: room.rent_price,
        floor: room.floor,
        status: room.status,
        activeContract: room.contracts[0] || undefined,
      }));
    },
    enabled: !!selectedBuildingId,
  });

  // Determine room status with contract info
  const getRoomStatus = (room: any): RoomStatus => {
    const contract = roomsWithContracts.find(r => r.id === room.id);

    if (contract?.activeContract) {
      const daysUntilExpiry = differenceInDays(
        new Date(contract.activeContract.end_date),
        new Date()
      );

      if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
        return "EXPIRING_SOON";
      }
      return "OCCUPIED";
    }

    if (room.status === "MAINTENANCE") return "MAINTENANCE";
    if (room.status === "RESERVED") return "RESERVED";
    return "AVAILABLE";
  };

  // Filter rooms by building and floor
  const filteredRooms = useMemo(() => {
    let rooms = allRooms;

    if (selectedBuildingId) {
      rooms = rooms.filter(r => r.building_id === selectedBuildingId);
    }

    if (selectedFloor !== "all") {
      rooms = rooms.filter(r => r.floor === parseInt(selectedFloor));
    }

    return rooms.map(room => {
      const contract = roomsWithContracts.find(r => r.id === room.id);
      return {
        ...room,
        displayStatus: getRoomStatus(room),
        tenantName: contract?.activeContract?.tenant?.full_name,
        daysUntilExpiry: contract?.activeContract
          ? differenceInDays(new Date(contract.activeContract.end_date), new Date())
          : undefined,
      };
    });
  }, [allRooms, selectedBuildingId, selectedFloor, roomsWithContracts]);

  // Get unique floors from filtered rooms
  const floors = useMemo(() => {
    if (!selectedBuildingId) return [];
    const floorsSet = new Set(
      allRooms
        .filter(r => r.building_id === selectedBuildingId)
        .map(r => r.floor)
        .filter(f => f !== null)
    );
    return Array.from(floorsSet).sort((a, b) => a - b);
  }, [allRooms, selectedBuildingId]);

  // Statistics
  const stats = useMemo(() => {
    const total = filteredRooms.length;
    const occupied = filteredRooms.filter(r => r.displayStatus === "OCCUPIED").length;
    const available = filteredRooms.filter(r => r.displayStatus === "AVAILABLE").length;
    const expiring = filteredRooms.filter(r => r.displayStatus === "EXPIRING_SOON").length;
    const maintenance = filteredRooms.filter(r => r.displayStatus === "MAINTENANCE").length;

    return { total, occupied, available, expiring, maintenance };
  }, [filteredRooms]);

  const handleRoomClick = (roomId: string) => {
    setSelectedRoomId(roomId);
    setDetailDialogOpen(true);
  };

  // Auto-select first building if available
  if (!selectedBuildingId && buildings.length > 0) {
    setSelectedBuildingId(buildings[0].id);
  }

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sơ đồ Tòa nhà</h1>
          <p className="text-muted-foreground mt-1">
            Xem trực quan tình trạng phòng theo tòa nhà và tầng
          </p>
        </div>

        {/* Building Selector */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              Chọn tòa nhà
            </CardTitle>
          </CardHeader>
          <CardContent>
            {buildingsLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <Select value={selectedBuildingId} onValueChange={setSelectedBuildingId}>
                <SelectTrigger>
                  <SelectValue placeholder="Chọn tòa nhà" />
                </SelectTrigger>
                <SelectContent>
                  {buildings.map((building) => (
                    <SelectItem key={building.id} value={building.id}>
                      {building.name} - {building.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </CardContent>
        </Card>

        {selectedBuildingId && (
          <>
            {/* Statistics */}
            <div className="grid gap-4 md:grid-cols-5">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{stats.total}</div>
                  <p className="text-xs text-muted-foreground">Tổng số phòng</p>
                </CardContent>
              </Card>

              <Card className="bg-green-50">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-green-700">{stats.occupied}</div>
                  <p className="text-xs text-muted-foreground">Đã thuê</p>
                </CardContent>
              </Card>

              <Card className="bg-red-50">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-red-700">{stats.available}</div>
                  <p className="text-xs text-muted-foreground">Còn trống</p>
                </CardContent>
              </Card>

              <Card className="bg-purple-50">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-purple-700">{stats.expiring}</div>
                  <p className="text-xs text-muted-foreground">Sắp hết hạn</p>
                </CardContent>
              </Card>

              <Card className="bg-gray-50">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-gray-700">{stats.maintenance}</div>
                  <p className="text-xs text-muted-foreground">Bảo trì</p>
                </CardContent>
              </Card>
            </div>

            {/* Floor Selector & Room Grid */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-5 h-5" />
                  Danh sách phòng
                </CardTitle>
                <CardDescription>
                  Click vào phòng để xem chi tiết và thực hiện hành động
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs value={selectedFloor} onValueChange={setSelectedFloor}>
                  <TabsList className="mb-4">
                    <TabsTrigger value="all">Tất cả</TabsTrigger>
                    {floors.map((floor) => (
                      <TabsTrigger key={floor} value={floor.toString()}>
                        Tầng {floor}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  <TabsContent value={selectedFloor} className="mt-6">
                    {roomsLoading ? (
                      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
                        {[...Array(10)].map((_, i) => (
                          <Skeleton key={i} className="h-32" />
                        ))}
                      </div>
                    ) : filteredRooms.length === 0 ? (
                      <div className="text-center py-12 text-muted-foreground">
                        <Building2 className="w-12 h-12 mx-auto mb-2 opacity-50" />
                        <p>Không có phòng nào</p>
                      </div>
                    ) : (
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
                            onClick={() => handleRoomClick(room.id)}
                          />
                        ))}
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
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
                Vui lòng tạo tòa nhà và phòng trước khi sử dụng sơ đồ
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

export default BuildingMapPage;
