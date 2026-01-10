import { useState, useMemo } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { useServices } from "@/hooks/useServices";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Search, Pencil, Trash2, Wrench, Check, X } from "lucide-react";
import { CreateServiceDialog } from "@/components/services/CreateServiceDialog";
import { EditServiceDialog } from "@/components/services/EditServiceDialog";
import { DeleteServiceDialog } from "@/components/services/DeleteServiceDialog";
import type { Database } from "@/integrations/supabase/types";

type Service = Database["public"]["Tables"]["services"]["Row"];

export default function ServicesPage() {
  const { data: services, isLoading } = useServices();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  // Filter services based on search and tab
  const filteredServices = useMemo(() => {
    if (!services) return [];

    return services.filter((service) => {
      const matchesSearch =
        service.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        service.code?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        service.description?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTab =
        activeTab === "all" || service.type === activeTab;

      return matchesSearch && matchesTab;
    });
  }, [services, searchTerm, activeTab]);

  // Count services by type
  const serviceCounts = useMemo(() => {
    if (!services) return { all: 0, FIXED: 0, PER_PERSON: 0, PER_ROOM: 0, METER_READING: 0 };
    
    return {
      all: services.length,
      FIXED: services.filter(s => s.type === "FIXED").length,
      PER_PERSON: services.filter(s => s.type === "PER_PERSON").length,
      PER_ROOM: services.filter(s => s.type === "PER_ROOM").length,
      METER_READING: services.filter(s => s.type === "METER_READING").length,
    };
  }, [services]);

  const handleEdit = (service: Service) => {
    setSelectedService(service);
    setEditDialogOpen(true);
  };

  const handleDelete = (service: Service) => {
    setSelectedService(service);
    setDeleteDialogOpen(true);
  };

  const getServiceTypeBadge = (type: string) => {
    const variants: Record<string, { label: string; color: "default" | "secondary" | "outline" | "destructive" }> = {
      FIXED: { label: "Cố định", color: "default" },
      PER_PERSON: { label: "Theo người", color: "secondary" },
      PER_ROOM: { label: "Theo phòng", color: "outline" },
      METER_READING: { label: "Theo chỉ số", color: "destructive" },
    };

    const config = variants[type] || { label: type, color: "default" };

    return (
      <Badge variant={config.color}>
        {config.label}
      </Badge>
    );
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <Wrench className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Quản lý Dịch vụ</h1>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Tạo dịch vụ
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách Dịch vụ</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, mã, mô tả..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          {/* Tabs for Service Types */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="all">
                Tất cả ({serviceCounts.all})
              </TabsTrigger>
              <TabsTrigger value="FIXED">
                Cố định ({serviceCounts.FIXED})
              </TabsTrigger>
              <TabsTrigger value="PER_PERSON">
                Theo người ({serviceCounts.PER_PERSON})
              </TabsTrigger>
              <TabsTrigger value="PER_ROOM">
                Theo phòng ({serviceCounts.PER_ROOM})
              </TabsTrigger>
              <TabsTrigger value="METER_READING">
                Theo chỉ số ({serviceCounts.METER_READING})
              </TabsTrigger>
            </TabsList>

            <TabsContent value={activeTab}>
              {isLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </div>
              ) : filteredServices && filteredServices.length > 0 ? (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tên dịch vụ</TableHead>
                        <TableHead>Loại</TableHead>
                        <TableHead className="text-right">Đơn giá</TableHead>
                        <TableHead>Đơn vị</TableHead>
                        <TableHead className="text-center">Mặc định</TableHead>
                        <TableHead className="text-center">Bắt buộc</TableHead>
                        <TableHead className="text-right">Thao tác</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredServices.map((service) => (
                        <TableRow key={service.id}>
                          <TableCell className="font-medium">
                            {service.name}
                            {service.code && (
                              <span className="text-sm text-muted-foreground ml-2">
                                ({service.code})
                              </span>
                            )}
                          </TableCell>
                          <TableCell>{getServiceTypeBadge(service.type)}</TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(service.unit_price)}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {service.unit || "-"}
                          </TableCell>
                          <TableCell className="text-center">
                            {service.is_default ? (
                              <Check className="h-4 w-4 mx-auto text-green-600" />
                            ) : (
                              <X className="h-4 w-4 mx-auto text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {service.is_mandatory ? (
                              <Check className="h-4 w-4 mx-auto text-green-600" />
                            ) : (
                              <X className="h-4 w-4 mx-auto text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit(service)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(service)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  {searchTerm || activeTab !== "all"
                    ? "Không tìm thấy dịch vụ nào"
                    : "Chưa có dịch vụ nào. Nhấn 'Tạo dịch vụ' để bắt đầu."}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateServiceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
      {selectedService && (
        <>
          <EditServiceDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            service={selectedService}
          />
          <DeleteServiceDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            service={selectedService}
          />
        </>
      )}
      </div>
    </MainLayout>
  );
}
