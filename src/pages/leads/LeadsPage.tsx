import { useState, useMemo } from "react";
import { Plus, Search, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLeads, useDeleteLead } from "@/hooks/useLeads";
import { CreateLeadDialog } from "@/components/leads/CreateLeadDialog";
import { EditLeadDialog } from "@/components/leads/EditLeadDialog";
import { LeadCard } from "@/components/leads/LeadCard";
import { ConvertLeadDialog } from "@/components/leads/ConvertLeadDialog";
import ExportExcelDialog from "@/components/import-export/ExportExcelDialog";
import type { LeadWithRelations } from "@/hooks/useLeads";

const LEAD_STATUSES = [
  { value: "NEW", label: "Khách mới", color: "bg-blue-100 text-blue-800" },
  { value: "CONTACTED", label: "Đã liên hệ", color: "bg-yellow-100 text-yellow-800" },
  { value: "VIEWED", label: "Đã xem phòng", color: "bg-purple-100 text-purple-800" },
  { value: "DEPOSITED", label: "Đã đặt cọc", color: "bg-green-100 text-green-800" },
  { value: "FAILED", label: "Không thành công", color: "bg-red-100 text-red-800" },
] as const;

const LeadsPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadWithRelations | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const { data: leads = [], isLoading } = useLeads();
  const deleteMutation = useDeleteLead();

  // Filter leads by search term
  const filteredLeads = useMemo(() => {
    if (!searchTerm.trim()) return leads;
    const search = searchTerm.toLowerCase();
    return leads.filter(
      (lead) =>
        lead.customer_name?.toLowerCase().includes(search) ||
        lead.phone?.toLowerCase().includes(search) ||
        lead.email?.toLowerCase().includes(search) ||
        lead.room?.name?.toLowerCase().includes(search) ||
        lead.room?.building?.name?.toLowerCase().includes(search)
    );
  }, [leads, searchTerm]);

  const handleEdit = (lead: LeadWithRelations) => {
    setSelectedLead(lead);
    setEditDialogOpen(true);
  };

  const handleConvert = (lead: LeadWithRelations) => {
    setSelectedLead(lead);
    setConvertDialogOpen(true);
  };

  const handleDelete = (lead: LeadWithRelations) => {
    if (confirm(`Xác nhận xóa khách hẹn "${lead.customer_name}"?`)) {
      deleteMutation.mutate(lead.id);
    }
  };

  const getLeadsByStatus = (status: string) => {
    return filteredLeads.filter((lead) => lead.status === status);
  };

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
          <h1 className="text-3xl font-bold">Quản lý Khách hẹn</h1>
          <p className="text-muted-foreground mt-1">
            Theo dõi tiến trình khách hàng tiềm năng
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setExportDialogOpen(true)}>
            <Download className="w-4 h-4 mr-2" />
            Xuất Excel
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Tạo khách hẹn
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
        <Input
          placeholder="Tìm kiếm theo tên, SĐT, email, phòng..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        {LEAD_STATUSES.map((status) => {
          const count = getLeadsByStatus(status.value).length;
          return (
            <Card key={status.value}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{status.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{count}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Kanban Board */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        {LEAD_STATUSES.map((status) => {
          const statusLeads = getLeadsByStatus(status.value);
          return (
            <div key={status.value} className="space-y-3">
              <div className={`p-3 rounded-lg ${status.color}`}>
                <h3 className="font-semibold text-sm">
                  {status.label} ({statusLeads.length})
                </h3>
              </div>
              <div className="space-y-3 min-h-[400px]">
                {statusLeads.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    onEdit={handleEdit}
                    onConvert={handleConvert}
                    onDelete={handleDelete}
                  />
                ))}
                {statusLeads.length === 0 && (
                  <Card className="border-dashed">
                    <CardContent className="p-4 text-center text-sm text-muted-foreground">
                      Chưa có khách hẹn
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Dialogs */}
      <CreateLeadDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {selectedLead && (
        <>
          <EditLeadDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            lead={selectedLead}
          />
          <ConvertLeadDialog
            open={convertDialogOpen}
            onOpenChange={setConvertDialogOpen}
            lead={selectedLead}
          />
        </>
      )}

      <ExportExcelDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        exportType="leads"
      />
    </div>
  );
};

export default LeadsPage;
