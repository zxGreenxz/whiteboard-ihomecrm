import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, Mail, MapPin, Building2, Edit, ArrowRight, Trash2, Eye } from "lucide-react";
import type { LeadWithRelations } from "@/hooks/useLeads";
import { formatDate } from "@/lib/utils";

interface LeadCardProps {
  lead: LeadWithRelations;
  onEdit: (lead: LeadWithRelations) => void;
  onConvert: (lead: LeadWithRelations) => void;
  onDelete: (lead: LeadWithRelations) => void;
  onViewDetail: (lead: LeadWithRelations) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  ZALO: "Zalo",
  PHONE: "Điện thoại",
  REFERRAL: "Giới thiệu",
  WALK_IN: "Khách đến trực tiếp",
  WEBSITE: "Website",
  OTHER: "Khác",
};

export function LeadCard({ lead, onEdit, onConvert, onDelete, onViewDetail }: LeadCardProps) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <h4 className="font-semibold text-sm">{lead.customer_name}</h4>
            {lead.source && (
              <Badge variant="outline" className="text-xs">
                {SOURCE_LABELS[lead.source] || lead.source}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pb-3 space-y-2">
        {lead.phone && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Phone className="w-3 h-3" />
            <span>{lead.phone}</span>
          </div>
        )}

        {lead.email && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Mail className="w-3 h-3" />
            <span className="truncate">{lead.email}</span>
          </div>
        )}

        {lead.building && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Building2 className="w-3 h-3" />
            <span className="truncate">{lead.building.name}</span>
          </div>
        )}

        {lead.room && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MapPin className="w-3 h-3" />
            <span className="truncate">
              {lead.room.building?.name ? `${lead.room.building.name} - ` : ""}{lead.room.name}
            </span>
          </div>
        )}

        {lead.appointment_date && (
          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
            Hẹn: {formatDate(lead.appointment_date)}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex gap-1 pt-3 border-t">
        <Button
          size="sm"
          variant="ghost"
          className="flex-1"
          onClick={() => onViewDetail(lead)}
          title="Xem chi tiết"
        >
          <Eye className="w-3 h-3" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => onEdit(lead)}
          title="Chỉnh sửa"
        >
          <Edit className="w-3 h-3" />
        </Button>
        {lead.status !== "CONVERTED" && lead.status !== "FAILED" && (
          <Button
            size="sm"
            className="flex-1"
            onClick={() => onConvert(lead)}
            title="Chuyển sang đặt cọc"
          >
            <ArrowRight className="w-3 h-3 mr-1" />
            Cọc
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => onDelete(lead)}
          title="Xóa"
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      </CardFooter>
    </Card>
  );
}
