import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, Mail, MapPin, Edit, ArrowRight } from "lucide-react";
import type { LeadWithRelations } from "@/hooks/useLeads";
import { formatDate } from "@/lib/utils";

interface LeadCardProps {
  lead: LeadWithRelations;
  onEdit: (lead: LeadWithRelations) => void;
  onConvert: (lead: LeadWithRelations) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  WEBSITE: "Website",
  FACEBOOK: "Facebook",
  ZALO: "Zalo",
  REFERRAL: "Giới thiệu",
  WALK_IN: "Khách đến trực tiếp",
  OTHER: "Khác",
};

export function LeadCard({ lead, onEdit, onConvert }: LeadCardProps) {
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

        {lead.room && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MapPin className="w-3 h-3" />
            <span className="truncate">
              {lead.room.building?.name} - {lead.room.name}
            </span>
          </div>
        )}

        {lead.appointment_date && (
          <div className="text-xs text-muted-foreground mt-2 pt-2 border-t">
            Hẹn: {formatDate(lead.appointment_date)}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex gap-2 pt-3 border-t">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => onEdit(lead)}
        >
          <Edit className="w-3 h-3 mr-1" />
          Sửa
        </Button>
        {lead.status !== "DEPOSITED" && lead.status !== "FAILED" && (
          <Button
            size="sm"
            className="flex-1"
            onClick={() => onConvert(lead)}
          >
            <ArrowRight className="w-3 h-3 mr-1" />
            Cọc
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
