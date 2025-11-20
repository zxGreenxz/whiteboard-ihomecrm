import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, User, MapPin } from "lucide-react";
import { type IssueWithRelations } from "@/hooks/useIssues";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";

const PRIORITY_CONFIG = {
  LOW: { label: "Thấp", color: "bg-gray-100 text-gray-800" },
  MEDIUM: { label: "Trung bình", color: "bg-blue-100 text-blue-800" },
  HIGH: { label: "Cao", color: "bg-orange-100 text-orange-800" },
  URGENT: { label: "Khẩn cấp", color: "bg-red-100 text-red-800" },
};

interface IssueCardProps {
  issue: IssueWithRelations;
  onClick?: () => void;
}

export function IssueCard({ issue, onClick }: IssueCardProps) {
  const priorityConfig = PRIORITY_CONFIG[issue.priority as keyof typeof PRIORITY_CONFIG] || PRIORITY_CONFIG.MEDIUM;

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onClick}
    >
      <CardContent className="p-3 space-y-2">
        {/* Title and Priority */}
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h4 className="font-medium text-sm line-clamp-2 flex-1">
              {issue.title}
            </h4>
            <Badge className={`${priorityConfig.color} text-xs shrink-0`}>
              {priorityConfig.label}
            </Badge>
          </div>
          {issue.category && (
            <Badge variant="outline" className="text-xs">
              {issue.category.name}
            </Badge>
          )}
        </div>

        {/* Description */}
        {issue.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {issue.description}
          </p>
        )}

        {/* Location */}
        {(issue.building || issue.room) && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="w-3 h-3" />
            <span className="line-clamp-1">
              {issue.building?.name}
              {issue.room && ` - ${issue.room.name}`}
            </span>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
          {/* Assigned to */}
          <div className="flex items-center gap-1">
            {issue.assigned_profile ? (
              <>
                <User className="w-3 h-3" />
                <span className="line-clamp-1">
                  {issue.assigned_profile.full_name || "Chưa rõ"}
                </span>
              </>
            ) : (
              <span className="text-gray-400 italic">Chưa phân công</span>
            )}
          </div>

          {/* Time ago */}
          <div className="flex items-center gap-1 shrink-0">
            <Clock className="w-3 h-3" />
            <span>
              {formatDistanceToNow(new Date(issue.created_at), {
                addSuffix: true,
                locale: vi,
              })}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
