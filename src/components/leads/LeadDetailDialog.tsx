import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Phone, Mail, Building2, MapPin, Calendar, FileText } from "lucide-react";
import type { LeadWithRelations } from "@/hooks/useLeads";
import { LeadActivityTimeline } from "./LeadActivityTimeline";
import { formatDate } from "@/lib/utils";

interface LeadDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadWithRelations;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  B1_LEAD: { label: "Mới", color: "bg-blue-100 text-blue-800" },
  B2_APPOINTMENT: { label: "Đã hẹn", color: "bg-yellow-100 text-yellow-800" },
  B3_CONSULTATION: { label: "Đang tư vấn", color: "bg-purple-100 text-purple-800" },
  CONVERTED: { label: "Đã chuyển đổi", color: "bg-green-100 text-green-800" },
  FAILED: { label: "Thất bại", color: "bg-red-100 text-red-800" },
};

const SOURCE_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  ZALO: "Zalo",
  PHONE: "Điện thoại",
  REFERRAL: "Giới thiệu",
  WALK_IN: "Khách đến trực tiếp",
  WEBSITE: "Website",
  OTHER: "Khác",
};

export function LeadDetailDialog({ open, onOpenChange, lead }: LeadDetailDialogProps) {
  const statusInfo = STATUS_LABELS[lead.status || "B1_LEAD"] || STATUS_LABELS.B1_LEAD;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Chi tiết khách hẹn: {lead.customer_name}
            <Badge className={statusInfo.color}>{statusInfo.label}</Badge>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <div className="space-y-6">
            {/* Thông tin cơ bản */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                {lead.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="w-4 h-4 text-muted-foreground" />
                    <span>{lead.phone}</span>
                  </div>
                )}
                {lead.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="w-4 h-4 text-muted-foreground" />
                    <span>{lead.email}</span>
                  </div>
                )}
                {lead.source && (
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <span>Nguồn: {SOURCE_LABELS[lead.source] || lead.source}</span>
                  </div>
                )}
              </div>
              <div className="space-y-3">
                {lead.building && (
                  <div className="flex items-center gap-2 text-sm">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <span>Toà nhà: {lead.building.name}</span>
                  </div>
                )}
                {lead.room && (
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="w-4 h-4 text-muted-foreground" />
                    <span>Căn hộ quan tâm: {lead.room.name}</span>
                  </div>
                )}
                {lead.appointment_date && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span>Hẹn: {formatDate(lead.appointment_date)}</span>
                  </div>
                )}
              </div>
            </div>

            {lead.notes && (
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm font-medium mb-1">Ghi chú:</p>
                <p className="text-sm text-muted-foreground">{lead.notes}</p>
              </div>
            )}

            {/* Lịch sử hoạt động */}
            <LeadActivityTimeline leadId={lead.id} />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
