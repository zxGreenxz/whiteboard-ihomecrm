import { useState, useMemo } from "react";
import { useCustomers } from "@/hooks/useCustomers";
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
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { EditCustomerDialog } from "@/components/customers/EditCustomerDialog";
import { DeleteCustomerDialog } from "@/components/customers/DeleteCustomerDialog";
import type { Database } from "@/integrations/supabase/types";

type Customer = Database["public"]["Tables"]["customers"]["Row"];

export default function CustomersPage() {
  const { data: customers, isLoading } = useCustomers();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  // Filter customers based on search and tab
  const filteredCustomers = useMemo(() => {
    if (!customers) return [];

    return customers.filter((customer) => {
      const matchesSearch =
        customer.full_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.phone?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.id_number?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTab =
        activeTab === "all" || customer.status === activeTab;

      return matchesSearch && matchesTab;
    });
  }, [customers, searchTerm, activeTab]);

  // Count customers by status
  const customerCounts = useMemo(() => {
    if (!customers) return { all: 0, PROSPECT: 0, ACTIVE: 0, INACTIVE: 0, BLACKLIST: 0 };

    return {
      all: customers.length,
      PROSPECT: customers.filter(c => c.status === "PROSPECT").length,
      ACTIVE: customers.filter(c => c.status === "ACTIVE").length,
      INACTIVE: customers.filter(c => c.status === "INACTIVE").length,
      BLACKLIST: customers.filter(c => c.status === "BLACKLIST").length,
    };
  }, [customers]);

  const handleEdit = (customer: Customer) => {
    setSelectedCustomer(customer);
    setEditDialogOpen(true);
  };

  const handleDelete = (customer: Customer) => {
    setSelectedCustomer(customer);
    setDeleteDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { label: string; color: "default" | "secondary" | "outline" | "destructive" }> = {
      PROSPECT: { label: "Tiềm năng", color: "outline" },
      ACTIVE: { label: "Đang hoạt động", color: "default" },
      INACTIVE: { label: "Không hoạt động", color: "secondary" },
      BLACKLIST: { label: "Danh sách đen", color: "destructive" },
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

  const getCustomerTypeLabel = (type: string | null) => {
    if (!type) return "-";
    return type === "INDIVIDUAL" ? "Cá nhân" : "Tổ chức";
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <Users className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Quản lý Khách hàng</h1>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} className="bg-green-600 hover:bg-green-700">
          <Plus className="mr-2 h-4 w-4" />
          Tạo khách hàng
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách Khách hàng</CardTitle>
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

          {/* Tabs for Customer Status */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="all">
                Tất cả ({customerCounts.all})
              </TabsTrigger>
              <TabsTrigger value="PROSPECT">
                Tiềm năng ({customerCounts.PROSPECT})
              </TabsTrigger>
              <TabsTrigger value="ACTIVE">
                Đang hoạt động ({customerCounts.ACTIVE})
              </TabsTrigger>
              <TabsTrigger value="INACTIVE">
                Không hoạt động ({customerCounts.INACTIVE})
              </TabsTrigger>
              <TabsTrigger value="BLACKLIST">
                Danh sách đen ({customerCounts.BLACKLIST})
              </TabsTrigger>
            </TabsList>

            <TabsContent value={activeTab}>
              {isLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </div>
              ) : filteredCustomers && filteredCustomers.length > 0 ? (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Họ tên</TableHead>
                        <TableHead>Loại</TableHead>
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
                      {filteredCustomers.map((customer) => (
                        <TableRow key={customer.id}>
                          <TableCell className="font-medium">
                            {customer.full_name}
                          </TableCell>
                          <TableCell className="text-sm">
                            {getCustomerTypeLabel(customer.customer_type)}
                          </TableCell>
                          <TableCell>{customer.phone || "-"}</TableCell>
                          <TableCell className="text-sm">
                            {customer.email || "-"}
                          </TableCell>
                          <TableCell>
                            {customer.id_number ? (
                              <div className="text-sm">
                                <div>{customer.id_number}</div>
                                {customer.id_type && (
                                  <span className="text-muted-foreground text-xs">
                                    ({customer.id_type})
                                  </span>
                                )}
                              </div>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {getGenderLabel(customer.gender)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {formatDate(customer.date_of_birth)}
                          </TableCell>
                          <TableCell>{getStatusBadge(customer.status || "PROSPECT")}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit(customer)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(customer)}
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
                    ? "Không tìm thấy khách hàng nào"
                    : "Chưa có khách hàng nào. Nhấn 'Tạo khách hàng' để bắt đầu."}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateCustomerDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
      {selectedCustomer && (
        <>
          <EditCustomerDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            customer={selectedCustomer}
          />
          <DeleteCustomerDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            customer={selectedCustomer}
          />
        </>
      )}
    </div>
  );
}
