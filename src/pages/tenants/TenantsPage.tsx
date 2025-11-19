import { useState, useMemo } from "react";
import { useTenants } from "@/hooks/useTenants";
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
import { Plus, Search, Pencil, Trash2, Users } from "lucide-react";
import { CreateTenantDialog } from "@/components/tenants/CreateTenantDialog";
import { EditTenantDialog } from "@/components/tenants/EditTenantDialog";
import { DeleteTenantDialog } from "@/components/tenants/DeleteTenantDialog";
import type { Database } from "@/integrations/supabase/types";

type Tenant = Database["public"]["Tables"]["tenants"]["Row"];

export default function TenantsPage() {
  const { data: tenants, isLoading } = useTenants();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);

  // Filter tenants based on search and tab
  const filteredTenants = useMemo(() => {
    if (!tenants) return [];

    return tenants.filter((tenant) => {
      const matchesSearch =
        tenant.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tenant.phone?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tenant.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tenant.id_number?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTab =
        activeTab === "all" || tenant.status === activeTab;

      return matchesSearch && matchesTab;
    });
  }, [tenants, searchTerm, activeTab]);

  // Count tenants by status
  const tenantCounts = useMemo(() => {
    if (!tenants) return { all: 0, PROSPECT: 0, DEPOSITED: 0, ACTIVE: 0, MOVED_OUT: 0, BLACKLISTED: 0 };
    
    return {
      all: tenants.length,
      PROSPECT: tenants.filter(t => t.status === "PROSPECT").length,
      DEPOSITED: tenants.filter(t => t.status === "DEPOSITED").length,
      ACTIVE: tenants.filter(t => t.status === "ACTIVE").length,
      MOVED_OUT: tenants.filter(t => t.status === "MOVED_OUT").length,
      BLACKLISTED: tenants.filter(t => t.status === "BLACKLISTED").length,
    };
  }, [tenants]);

  const handleEdit = (tenant: Tenant) => {
    setSelectedTenant(tenant);
    setEditDialogOpen(true);
  };

  const handleDelete = (tenant: Tenant) => {
    setSelectedTenant(tenant);
    setDeleteDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { label: string; color: "default" | "secondary" | "outline" | "destructive" }> = {
      PROSPECT: { label: "Tiềm năng", color: "outline" },
      DEPOSITED: { label: "Đã đặt cọc", color: "secondary" },
      ACTIVE: { label: "Đang thuê", color: "default" },
      MOVED_OUT: { label: "Đã chuyển đi", color: "outline" },
      BLACKLISTED: { label: "Danh sách đen", color: "destructive" },
    };

    const config = variants[status] || { label: status, color: "default" };

    return (
      <Badge variant={config.color}>
        {config.label}
      </Badge>
    );
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleDateString("vi-VN");
  };

  const getGenderLabel = (gender: string | null) => {
    if (!gender) return "-";
    const labels: Record<string, string> = {
      MALE: "Nam",
      FEMALE: "Nữ",
      OTHER: "Khác",
    };
    return labels[gender] || gender;
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <Users className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Quản lý Khách thuê</h1>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Tạo khách thuê
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách Khách thuê</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, SĐT, email, CCCD..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          {/* Tabs for Tenant Status */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="all">
                Tất cả ({tenantCounts.all})
              </TabsTrigger>
              <TabsTrigger value="PROSPECT">
                Tiềm năng ({tenantCounts.PROSPECT})
              </TabsTrigger>
              <TabsTrigger value="DEPOSITED">
                Đã đặt cọc ({tenantCounts.DEPOSITED})
              </TabsTrigger>
              <TabsTrigger value="ACTIVE">
                Đang thuê ({tenantCounts.ACTIVE})
              </TabsTrigger>
              <TabsTrigger value="MOVED_OUT">
                Đã chuyển đi ({tenantCounts.MOVED_OUT})
              </TabsTrigger>
              <TabsTrigger value="BLACKLISTED">
                Danh sách đen ({tenantCounts.BLACKLISTED})
              </TabsTrigger>
            </TabsList>

            <TabsContent value={activeTab}>
              {isLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </div>
              ) : filteredTenants && filteredTenants.length > 0 ? (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Họ tên</TableHead>
                        <TableHead>SĐT</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>CCCD/CMND</TableHead>
                        <TableHead>Giới tính</TableHead>
                        <TableHead>Ngày sinh</TableHead>
                        <TableHead>Trạng thái</TableHead>
                        <TableHead className="text-right">Thao tác</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredTenants.map((tenant) => (
                        <TableRow key={tenant.id}>
                          <TableCell className="font-medium">
                            {tenant.full_name}
                          </TableCell>
                          <TableCell>{tenant.phone || "-"}</TableCell>
                          <TableCell className="text-sm">
                            {tenant.email || "-"}
                          </TableCell>
                          <TableCell>
                            {tenant.id_number ? (
                              <div className="text-sm">
                                <div>{tenant.id_number}</div>
                                {tenant.id_type && (
                                  <span className="text-muted-foreground text-xs">
                                    ({tenant.id_type})
                                  </span>
                                )}
                              </div>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {getGenderLabel(tenant.gender)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {formatDate(tenant.date_of_birth)}
                          </TableCell>
                          <TableCell>{getStatusBadge(tenant.status)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit(tenant)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(tenant)}
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
                    ? "Không tìm thấy khách thuê nào"
                    : "Chưa có khách thuê nào. Nhấn 'Tạo khách thuê' để bắt đầu."}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateTenantDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
      {selectedTenant && (
        <>
          <EditTenantDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            tenant={selectedTenant}
          />
          <DeleteTenantDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            tenant={selectedTenant}
          />
        </>
      )}
    </div>
  );
}
