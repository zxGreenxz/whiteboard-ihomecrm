import { useCopilotPageContext } from '@/hooks/useCopilotPageContext';
import { memo, useCallback, useMemo, useState } from "react";
import { Plus, Search, Download, UserPlus } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLeads, useDeleteLead } from "@/hooks/useLeads";
import EmptyState from "@/components/ui/EmptyState";
import { CreateLeadDialog } from "@/components/leads/CreateLeadDialog";
import { EditLeadDialog } from "@/components/leads/EditLeadDialog";
import { LeadCard } from "@/components/leads/LeadCard";
import { ConvertLeadDialog } from "@/components/leads/ConvertLeadDialog";
import { LeadDetailDialog } from "@/components/leads/LeadDetailDialog";
import ExportExcelDialog from "@/components/import-export/ExportExcelDialog";
import type { LeadWithRelations } from "@/hooks/useLeads";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { usePersistedState } from "@/hooks/usePersistedState";

const LEAD_STATUSES = [
  { value: "B1_LEAD", label: "Mới", color: "bg-blue-100 text-blue-800" },
  { value: "B2_APPOINTMENT", label: "Đã hẹn", color: "bg-yellow-100 text-yellow-800" },
  { value: "B3_CONSULTATION", label: "Đang tư vấn", color: "bg-purple-100 text-purple-800" },
  { value: "CONVERTED", label: "Đã chuyển đổi", color: "bg-green-100 text-green-800" },
  { value: "FAILED", label: "Thất bại", color: "bg-red-100 text-red-800" },
] as const;

/**
 * Số thẻ dựng mỗi trang trong một cột kanban. Cột "Đã chuyển đổi" / "Thất bại"
 * tích luỹ hàng trăm khách; dựng hết là hàng nghìn node cho phần không ai
 * cuộn tới. Nút "Xem thêm" nạp trang kế của đúng cột đó.
 */
const THE_MOI_TRANG = 30;

/** Thẻ khách — memo: gõ tìm kiếm chỉ dựng lại thẻ vào/ra danh sách. */
const MemoLeadCard = memo(LeadCard);

const LeadsPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadWithRelations | null>(null);
  const [searchTerm, setSearchTerm] = usePersistedState("flt:leads:search", "");
  // Số thẻ đang hiện theo cột; cột chưa bấm "Xem thêm" dùng THE_MOI_TRANG.
  const [shown, setShown] = useState<Record<string, number>>({});

  useCopilotPageContext('leads.list', { search: searchTerm }, detailDialogOpen ? selectedLead : null);
  const { data: leads = [], isLoading } = useLeads();
  const deleteMutation = useDeleteLead();
  const { data: perms } = useMyPermissions();
  const canCreateLead = canUse(perms, "leads", "create");
  const canExportLeads = canUse(perms, "leads", "export");

  // Lọc khách hẹn theo từ khóa tìm kiếm
  const filteredLeads = useMemo(() => {
    if (!searchTerm.trim()) return leads;
    const search = searchTerm.toLowerCase();
    return leads.filter(
      (lead) =>
        lead.customer_name?.toLowerCase().includes(search) ||
        lead.phone?.toLowerCase().includes(search) ||
        lead.email?.toLowerCase().includes(search) ||
        lead.room?.name?.toLowerCase().includes(search) ||
        lead.building?.name?.toLowerCase().includes(search)
    );
  }, [leads, searchTerm]);

  // Gom theo trạng thái MỘT lần thay vì `.filter` 10 lần mỗi render (5 thẻ
  // thống kê + 5 cột). Trạng thái lạ (không có trong LEAD_STATUSES) bị bỏ như cũ.
  const leadsByStatus = useMemo(() => {
    const groups: Record<string, LeadWithRelations[]> = {};
    for (const s of LEAD_STATUSES) groups[s.value] = [];
    for (const lead of filteredLeads) {
      const group = lead.status ? groups[lead.status] : undefined;
      if (group) group.push(lead);
    }
    return groups;
  }, [filteredLeads]);

  const handleEdit = useCallback((lead: LeadWithRelations) => {
    setSelectedLead(lead);
    setEditDialogOpen(true);
  }, []);

  const handleConvert = useCallback((lead: LeadWithRelations) => {
    setSelectedLead(lead);
    setConvertDialogOpen(true);
  }, []);

  const handleViewDetail = useCallback((lead: LeadWithRelations) => {
    setSelectedLead(lead);
    setDetailDialogOpen(true);
  }, []);

  const { mutate: deleteLead } = deleteMutation;
  const handleDelete = useCallback(
    (lead: LeadWithRelations) => {
      if (confirm(`Bạn có chắc chắn muốn xóa khách hẹn "${lead.customer_name}"?`)) {
        deleteLead(lead.id);
      }
    },
    [deleteLead],
  );

  const showMore = useCallback((status: string) => {
    setShown((prev) => ({ ...prev, [status]: (prev[status] ?? THE_MOI_TRANG) + THE_MOI_TRANG }));
  }, []);

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground">Đang tải...</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Quản lý Khách hẹn</h1>
            <p className="text-muted-foreground mt-1">
              Theo dõi tiến trình khách hàng tiềm năng
            </p>
          </div>
          <div className="flex gap-2">
            {canExportLeads && (
              <Button variant="outline" onClick={() => setExportDialogOpen(true)}>
                <Download className="w-4 h-4 mr-2" />
                Xuất Excel
              </Button>
            )}
            {canCreateLead && (
              <Button onClick={() => setCreateDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Tạo khách hẹn
              </Button>
            )}
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
          <Input
            placeholder="Tìm kiếm theo tên, SĐT, email, căn hộ, toà nhà..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {LEAD_STATUSES.map((status) => {
            const count = (leadsByStatus[status.value] ?? []).length;
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
        {leads.length === 0 && !searchTerm ? (
          <EmptyState
            icon={UserPlus}
            title="Chưa có khách hẹn nào"
            description="Hãy tạo khách hẹn đầu tiên để bắt đầu theo dõi khách hàng tiềm năng"
            actionLabel={canCreateLead ? "Tạo khách hẹn" : undefined}
            onAction={canCreateLead ? () => setCreateDialogOpen(true) : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {LEAD_STATUSES.map((status) => {
              const statusLeads = leadsByStatus[status.value] ?? [];
              const limit = shown[status.value] ?? THE_MOI_TRANG;
              const visible = statusLeads.length > limit ? statusLeads.slice(0, limit) : statusLeads;
              const remaining = statusLeads.length - visible.length;
              return (
                <div key={status.value} className="space-y-3">
                  <div className={`p-3 rounded-lg ${status.color}`}>
                    <h3 className="font-semibold text-sm">
                      {status.label} ({statusLeads.length})
                    </h3>
                  </div>
                  <div className="space-y-3 min-h-[400px]">
                    {visible.map((lead) => (
                      <MemoLeadCard
                        key={lead.id}
                        lead={lead}
                        onEdit={handleEdit}
                        onConvert={handleConvert}
                        onDelete={handleDelete}
                        onViewDetail={handleViewDetail}
                      />
                    ))}
                    {remaining > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => showMore(status.value)}
                      >
                        Xem thêm {Math.min(THE_MOI_TRANG, remaining)} (còn {remaining})
                      </Button>
                    )}
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
        )}

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
            <LeadDetailDialog
              open={detailDialogOpen}
              onOpenChange={setDetailDialogOpen}
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
    </MainLayout>
  );
};

export default LeadsPage;
