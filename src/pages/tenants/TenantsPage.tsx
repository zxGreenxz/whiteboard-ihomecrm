import { useState, useMemo } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { useTenants } from "@/hooks/useTenants";
import { usePagination, calculatePaginationInfo } from "@/hooks/usePagination";
import { usePersistedState } from "@/hooks/usePersistedState";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
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
import { Plus, Search, Pencil, Trash2, Users, Eye } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import { useNavigate } from "react-router-dom";
import { CreateTenantDialog } from "@/components/tenants/CreateTenantDialog";
import { EditTenantDialog } from "@/components/tenants/EditTenantDialog";
import { DeleteTenantDialog } from "@/components/tenants/DeleteTenantDialog";
import type { Database } from "@/integrations/supabase/types";

type Tenant = Database["public"]["Tables"]["tenants"]["Row"];

export default function TenantsPage() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = usePersistedState("flt:tenants:search", "");
  const [activeTab, setActiveTab] = usePersistedState<string>("flt:tenants:tab", "all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);

  // Pagination state
  const { page, pageSize, setPage, setPageSize } = usePagination(20);

  // Fetch tenants with pagination
  const { data: tenantsData, isLoading } = useTenants(
    { status: activeTab !== "all" ? activeTab : undefined },
    { page, pageSize }
  );

  // Extract data and count from response - DEFENSIVE CHECK
  const tenants = Array.isArray(tenantsData?.data) ? tenantsData.data : [];
  const totalCount = tenantsData?.count || 0;

  // Filter tenants based on search (client-side for current page)
  const filteredTenants = useMemo(() => {
    if (!Array.isArray(tenants)) return [];
    if (tenants.length === 0) return [];

    if (!searchTerm) return tenants;

    return tenants.filter((tenant) => {
      const matchesSearch =
        tenant.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tenant.phone?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tenant.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tenant.id_number?.toLowerCase().includes(searchTerm.toLowerCase());

      return matchesSearch;
    });
  }, [tenants, searchTerm]);

  // Calculate pagination info
  const paginationInfo = useMemo(() => {
    const count = searchTerm ? filteredTenants.length : totalCount;
    return calculatePaginationInfo(page, pageSize, count);
  }, [page, pageSize, totalCount, searchTerm, filteredTenants.length]);

  // Count tenants by status (for display on current page)
  const tenantCounts = useMemo(() => {
    if (!Array.isArray(tenants)) return { all: totalCount, PROSPECT: 0, DEPOSITED: 0, ACTIVE: 0, MOVED_OUT: 0, BLACKLISTED: 0 };

    return {
      all: totalCount,
      PROSPECT: tenants.filter(t => t.status === "PROSPECT").length,
      DEPOSITED: tenants.filter(t => t.status === "DEPOSITED").length,
      ACTIVE: tenants.filter(t => t.status === "ACTIVE").length,
      MOVED_OUT: tenants.filter(t => t.status === "MOVED_OUT").length,
      BLACKLISTED: tenants.filter(t => t.status === "BLACKLISTED").length,
    };
  }, [tenants, totalCount]);

  // Reset to page 1 when tab changes
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setPage(1);
  };

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
    return new Date(dateString).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Users className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Quản lý Khách hàng</h1>
              <p className="text-sm text-muted-foreground">Quản lý thông tin và trạng thái khách hàng</p>
            </div>
          </div>
          <Button onClick={() => setCreateDialogOpen(true)} className="shadow-sm">
            <Plus className="mr-2 h-4 w-4" />
            Thêm khách hàng
          </Button>
        </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Danh sách Khách hàng</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Search */}
          <div className="flex gap-4 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Tìm kiếm theo tên, SĐT, email, CMND/CCCD..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          {/* Tabs for Tenant Status */}
          <Tabs value={activeTab} onValueChange={handleTabChange}>
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
                        <TableHead>Tên</TableHead>
                        <TableHead>SĐT</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>CMND/CCCD</TableHead>
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
                          <TableCell>{getStatusBadge(tenant.status || "PROSPECT")}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => navigate(`/customers/${tenant.id}`)}
                                title="Xem chi tiết"
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit(tenant)}
                                title="Chỉnh sửa"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(tenant)}
                                title="Xóa"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  {/* Pagination */}
                  <DataTablePagination
                    paginationInfo={paginationInfo}
                    onPageChange={setPage}
                    onPageSizeChange={setPageSize}
                    showPageSizeSelector={true}
                    showItemCount={true}
                  />
                </div>
              ) : (
                searchTerm || activeTab !== "all" ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Không tìm thấy khách hàng nào
                  </div>
                ) : (
                  <EmptyState
                    icon={Users}
                    title="Chưa có khách hàng nào"
                    description="Hãy thêm khách hàng đầu tiên để bắt đầu quản lý"
                    actionLabel="Thêm khách hàng"
                    onAction={() => setCreateDialogOpen(true)}
                  />
                )
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
    </MainLayout>
  );
}
