import { useState } from "react";
import { Plus, Search, FileText, ArrowRightLeft, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAssets, type AssetWithRelations } from "@/hooks/useAssets";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CreateAssetDialog } from "@/components/assets/CreateAssetDialog";
import { EditAssetDialog } from "@/components/assets/EditAssetDialog";
import { AssetHandoverDialog } from "@/components/assets/AssetHandoverDialog";
import { AssetMovementDialog } from "@/components/assets/AssetMovementDialog";
import { AssetMaintenanceDialog } from "@/components/assets/AssetMaintenanceDialog";
import { formatCurrency } from "@/lib/utils";

const CONDITION_CONFIG = {
  NEW: { label: "Mới", color: "bg-green-100 text-green-800" },
  GOOD: { label: "Tốt", color: "bg-blue-100 text-blue-800" },
  FAIR: { label: "Khá", color: "bg-yellow-100 text-yellow-800" },
  POOR: { label: "Kém", color: "bg-orange-100 text-orange-800" },
  BROKEN: { label: "Hỏng", color: "bg-red-100 text-red-800" },
};

const AssetsPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [handoverDialogOpen, setHandoverDialogOpen] = useState(false);
  const [movementDialogOpen, setMovementDialogOpen] = useState(false);
  const [maintenanceDialogOpen, setMaintenanceDialogOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<AssetWithRelations | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [conditionFilter, setConditionFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: assets = [], isLoading } = useAssets({
    category_id: categoryFilter || undefined,
    condition: conditionFilter || undefined,
  });

  // Fetch categories for filter
  const { data: categories = [] } = useQuery({
    queryKey: ["asset-categories"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("asset_categories")
        .select("*")
        .eq('user_id', user.id)
        .order("name");

      if (error) throw error;
      return data || [];
    },
  });

  const handleEdit = (asset: AssetWithRelations) => {
    setSelectedAsset(asset);
    setEditDialogOpen(true);
  };

  const handleHandover = () => {
    setHandoverDialogOpen(true);
  };

  const filteredAssets = assets.filter((asset) => {
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (
      asset.name?.toLowerCase().includes(search) ||
      asset.code?.toLowerCase().includes(search) ||
      asset.category?.name?.toLowerCase().includes(search)
    );
  });

  // Calculate summary stats
  const totalAssets = filteredAssets.length;
  const totalValue = filteredAssets.reduce((sum, asset) => sum + (asset.purchase_price || 0) * (asset.quantity || 1), 0);
  const byCondition = filteredAssets.reduce((acc, asset) => {
    const condition = asset.condition || "GOOD";
    acc[condition] = (acc[condition] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground">Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Quản lý Tài sản</h1>
          <p className="text-muted-foreground mt-1">
            Theo dõi và quản lý tài sản nội thất
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setMovementDialogOpen(true)}>
            <ArrowRightLeft className="w-4 h-4 mr-2" />
            Di chuyển
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMaintenanceDialogOpen(true)}>
            <Wrench className="w-4 h-4 mr-2" />
            Bảo trì
          </Button>
          <Button variant="outline" onClick={handleHandover}>
            <FileText className="w-4 h-4 mr-2" />
            Biên bản bàn giao
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Tạo tài sản
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tổng số tài sản
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalAssets}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Giá trị tổng
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {formatCurrency(totalValue)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tốt / Mới
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {(byCondition.GOOD || 0) + (byCondition.NEW || 0)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Hỏng / Kém
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {(byCondition.BROKEN || 0) + (byCondition.POOR || 0)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Tìm kiếm theo tên, mã, loại..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Lọc theo loại" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả loại</SelectItem>
            {categories.map((cat) => (
              <SelectItem key={cat.id} value={cat.id}>
                {cat.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={conditionFilter} onValueChange={setConditionFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Tình trạng" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả</SelectItem>
            {Object.entries(CONDITION_CONFIG).map(([key, config]) => (
              <SelectItem key={key} value={key}>
                {config.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Assets Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mã TS</TableHead>
              <TableHead>Tên tài sản</TableHead>
              <TableHead>Loại</TableHead>
              <TableHead>Số lượng</TableHead>
              <TableHead>Tình trạng</TableHead>
              <TableHead>Vị trí</TableHead>
              <TableHead>Giá trị</TableHead>
              <TableHead>Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAssets.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Không tìm thấy tài sản nào
                </TableCell>
              </TableRow>
            ) : (
              filteredAssets.map((asset) => (
                <TableRow key={asset.id}>
                  <TableCell className="font-mono">{asset.code || "-"}</TableCell>
                  <TableCell className="font-medium">{asset.name}</TableCell>
                  <TableCell>{asset.category?.name || "-"}</TableCell>
                  <TableCell>{asset.quantity || 1}</TableCell>
                  <TableCell>
                    <Badge
                      className={
                        CONDITION_CONFIG[asset.condition as keyof typeof CONDITION_CONFIG]?.color || ""
                      }
                    >
                      {CONDITION_CONFIG[asset.condition as keyof typeof CONDITION_CONFIG]?.label ||
                        asset.condition}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {asset.building?.name}
                    {asset.room && ` - ${asset.room.name}`}
                  </TableCell>
                  <TableCell className="font-semibold">
                    {formatCurrency((asset.purchase_price || 0) * (asset.quantity || 1))}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEdit(asset)}
                    >
                      Sửa
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Dialogs */}
      <CreateAssetDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {selectedAsset && (
        <EditAssetDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          asset={selectedAsset}
        />
      )}

      <AssetHandoverDialog
        open={handoverDialogOpen}
        onOpenChange={setHandoverDialogOpen}
      />

      <AssetMovementDialog
        open={movementDialogOpen}
        onOpenChange={setMovementDialogOpen}
      />

      <AssetMaintenanceDialog
        open={maintenanceDialogOpen}
        onOpenChange={setMaintenanceDialogOpen}
      />
    </div>
  );
};

export default AssetsPage;
