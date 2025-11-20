import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLeads } from "@/hooks/useLeads";
import { CreateLeadDialog } from "@/components/leads/CreateLeadDialog";
import { EditLeadDialog } from "@/components/leads/EditLeadDialog";
import { LeadCard } from "@/components/leads/LeadCard";
import { ConvertLeadDialog } from "@/components/leads/ConvertLeadDialog";
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
  const [selectedLead, setSelectedLead] = useState<LeadWithRelations | null>(null);

  const { data: leads = [], isLoading } = useLeads();

  const handleEdit = (lead: LeadWithRelations) => {
    setSelectedLead(lead);
    setEditDialogOpen(true);
  };

  const handleConvert = (lead: LeadWithRelations) => {
    setSelectedLead(lead);
    setConvertDialogOpen(true);
  };

  const getLeadsByStatus = (status: string) => {
    return leads.filter((lead) => lead.status === status);
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
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Tạo khách hẹn
        </Button>
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
    </div>
  );
};

export default LeadsPage;
