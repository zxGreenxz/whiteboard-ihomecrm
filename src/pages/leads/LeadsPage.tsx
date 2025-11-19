import { useState } from 'react';
import { Plus, Users, TrendingUp, X, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useLeads, useUpdateLeadStatus, useLeadStats, type LeadWithRelations } from '@/hooks/useLeads';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import CreateLeadDialog from '@/components/leads/CreateLeadDialog';
import LeadDetailDialog from '@/components/leads/LeadDetailDialog';

// =============================================
// Types
// =============================================

type LeadStatus = 'B1_LEAD' | 'B2_APPOINTMENT' | 'B3_CONSULTING' | 'CONVERTED' | 'FAILED';

interface KanbanColumn {
  id: LeadStatus;
  title: string;
  color: string;
  bgColor: string;
}

const KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'B1_LEAD', title: 'B1 Bắn khách', color: 'text-blue-700', bgColor: 'bg-blue-50 border-blue-200' },
  { id: 'B2_APPOINTMENT', title: 'B2 Hẹn khách', color: 'text-purple-700', bgColor: 'bg-purple-50 border-purple-200' },
  { id: 'B3_CONSULTING', title: 'B3 Tư vấn', color: 'text-orange-700', bgColor: 'bg-orange-50 border-orange-200' },
  { id: 'CONVERTED', title: 'Đã chuyển đổi', color: 'text-green-700', bgColor: 'bg-green-50 border-green-200' },
  { id: 'FAILED', title: 'Thất bại', color: 'text-red-700', bgColor: 'bg-red-50 border-red-200' },
];

// =============================================
// Lead Card Component
// =============================================

interface LeadCardProps {
  lead: LeadWithRelations;
  onDragStart: (e: React.DragEvent, leadId: string) => void;
  onClick: () => void;
}

const LeadCard = ({ lead, onDragStart, onClick }: LeadCardProps) => {
  return (
    <Card
      draggable
      onDragStart={(e) => onDragStart(e, lead.id)}
      onClick={onClick}
      className="p-3 mb-2 cursor-move hover:shadow-md transition-shadow"
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h4 className="font-semibold text-sm">{lead.customer_name}</h4>
            <p className="text-xs text-muted-foreground">{lead.phone}</p>
          </div>
          {lead.source && (
            <Badge variant="outline" className="text-xs">
              {lead.source}
            </Badge>
          )}
        </div>

        {lead.building && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">🏢</span> {lead.building.name}
            {lead.room && ` - ${lead.room.name}`}
          </div>
        )}

        {lead.appointment_date && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">📅</span>{' '}
            {format(new Date(lead.appointment_date), 'dd/MM/yyyy HH:mm', { locale: vi })}
          </div>
        )}

        {lead.assigned_staff && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">👤</span> {lead.assigned_staff.full_name}
          </div>
        )}

        {lead.notes && (
          <p className="text-xs text-muted-foreground line-clamp-2">{lead.notes}</p>
        )}
      </div>
    </Card>
  );
};

// =============================================
// Main Page
// =============================================

export default function LeadsPage() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadWithRelations | null>(null);
  const [draggedLeadId, setDraggedLeadId] = useState<string | null>(null);

  // Hooks
  const { data: leads = [], isLoading } = useLeads();
  const { data: stats } = useLeadStats();
  const updateLeadStatus = useUpdateLeadStatus();

  // =============================================
  // Group leads by status
  // =============================================

  const leadsByStatus = KANBAN_COLUMNS.reduce((acc, column) => {
    acc[column.id] = leads.filter((lead) => lead.status === column.id);
    return acc;
  }, {} as Record<LeadStatus, LeadWithRelations[]>);

  // =============================================
  // Drag & Drop handlers
  // =============================================

  const handleDragStart = (e: React.DragEvent, leadId: string) => {
    setDraggedLeadId(leadId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetStatus: LeadStatus) => {
    e.preventDefault();

    if (!draggedLeadId) return;

    const draggedLead = leads.find((l) => l.id === draggedLeadId);
    if (!draggedLead) return;

    // Don't update if dropped in same column
    if (draggedLead.status === targetStatus) {
      setDraggedLeadId(null);
      return;
    }

    // Update lead status
    updateLeadStatus.mutate({
      leadId: draggedLeadId,
      status: targetStatus,
    });

    setDraggedLeadId(null);
  };

  const handleDragEnd = () => {
    setDraggedLeadId(null);
  };

  // =============================================
  // Stats calculation
  // =============================================

  const totalLeads = leads.length;
  const activeLeads = leads.filter((l) =>
    ['B1_LEAD', 'B2_APPOINTMENT', 'B3_CONSULTING'].includes(l.status || '')
  ).length;
  const convertedLeads = leads.filter((l) => l.status === 'CONVERTED').length;
  const conversionRate = totalLeads > 0 ? ((convertedLeads / totalLeads) * 100).toFixed(1) : '0.0';

  // =============================================
  // Render
  // =============================================

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
            <p className="mt-4 text-muted-foreground">Đang tải dữ liệu...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* =============================================
          Header
          ============================================= */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Quản lý Khách hẹn</h1>
          <p className="text-muted-foreground mt-1">
            Theo dõi khách hàng tiềm năng qua quy trình B1 → B2 → B3
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Tạo khách hẹn
        </Button>
      </div>

      {/* =============================================
          Statistics Cards
          ============================================= */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-blue-100 rounded-lg">
              <Users className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tổng khách hẹn</p>
              <p className="text-2xl font-bold">{totalLeads}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-orange-100 rounded-lg">
              <AlertCircle className="h-5 w-5 text-orange-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Đang xử lý</p>
              <p className="text-2xl font-bold">{activeLeads}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-green-100 rounded-lg">
              <TrendingUp className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Đã chuyển đổi</p>
              <p className="text-2xl font-bold">{convertedLeads}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-purple-100 rounded-lg">
              <TrendingUp className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tỷ lệ chuyển đổi</p>
              <p className="text-2xl font-bold">{conversionRate}%</p>
            </div>
          </div>
        </Card>
      </div>

      {/* =============================================
          Info Banner
          ============================================= */}
      <Card className="p-4 bg-blue-50 border-blue-200">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-blue-900">Hướng dẫn sử dụng Kanban Board</h3>
            <p className="text-sm text-blue-700 mt-1">
              • <strong>Kéo thả thẻ</strong> giữa các cột để cập nhật trạng thái khách hẹn<br />
              • <strong>Click vào thẻ</strong> để xem chi tiết và thực hiện các thao tác<br />
              • <strong>B1 → B2 → B3</strong>: Quy trình chăm sóc khách hàng tiềm năng<br />
              • <strong>Đã chuyển đổi</strong>: Khách hẹn đã đặt cọc thành công
            </p>
          </div>
        </div>
      </Card>

      {/* =============================================
          Kanban Board
          ============================================= */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        {KANBAN_COLUMNS.map((column) => (
          <div
            key={column.id}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, column.id)}
            className="space-y-3"
          >
            {/* Column Header */}
            <Card className={`p-3 ${column.bgColor} border`}>
              <div className="flex items-center justify-between">
                <h3 className={`font-semibold text-sm ${column.color}`}>
                  {column.title}
                </h3>
                <Badge variant="secondary" className="ml-2">
                  {leadsByStatus[column.id].length}
                </Badge>
              </div>
            </Card>

            {/* Cards Container */}
            <div className="space-y-2 min-h-[200px]">
              {leadsByStatus[column.id].length === 0 ? (
                <Card className="p-4 border-dashed">
                  <p className="text-sm text-muted-foreground text-center">
                    Chưa có khách hẹn
                  </p>
                </Card>
              ) : (
                leadsByStatus[column.id].map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    onDragStart={handleDragStart}
                    onClick={() => setSelectedLead(lead)}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {/* =============================================
          Dialogs
          ============================================= */}
      <CreateLeadDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />

      {selectedLead && (
        <LeadDetailDialog
          lead={selectedLead}
          open={!!selectedLead}
          onOpenChange={(open) => !open && setSelectedLead(null)}
        />
      )}
    </div>
  );
}
