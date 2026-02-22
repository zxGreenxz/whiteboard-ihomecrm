import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, DollarSign, AlertCircle } from "lucide-react";
import { useRecentActivities } from "@/hooks/useDashboard";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { formatCurrency } from "@/lib/utils";

export function RecentActivities({ buildingId }: { buildingId?: string | null }) {
  const { data: activities = [], isLoading } = useRecentActivities(buildingId);

  const getActivityConfig = (type: string) => {
    switch (type) {
      case "contract":
        return {
          icon: FileText,
          color: "text-blue-600",
          bgColor: "bg-blue-100",
        };
      case "payment":
        return {
          icon: DollarSign,
          color: "text-green-600",
          bgColor: "bg-green-100",
        };
      case "issue":
        return {
          icon: AlertCircle,
          color: "text-orange-600",
          bgColor: "bg-orange-100",
        };
      default:
        return {
          icon: FileText,
          color: "text-gray-600",
          bgColor: "bg-gray-100",
        };
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Hoạt động gần đây</CardTitle>
          <CardDescription>7 ngày qua</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-muted-foreground py-8">Đang tải...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hoạt động gần đây</CardTitle>
        <CardDescription>7 ngày qua</CardDescription>
      </CardHeader>
      <CardContent>
        {activities.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">
            Chưa có hoạt động nào
          </p>
        ) : (
          <div className="space-y-3">
            {activities.map((activity) => {
              const config = getActivityConfig(activity.type);
              const Icon = config.icon;

              return (
                <div key={activity.id} className="flex gap-3 items-start">
                  <div className={`flex-shrink-0 w-8 h-8 rounded-full ${config.bgColor} flex items-center justify-center`}>
                    <Icon className={`w-4 h-4 ${config.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="font-medium text-sm">{activity.title}</p>
                        <p className="text-sm text-muted-foreground line-clamp-1">
                          {activity.description}
                        </p>
                      </div>
                      {activity.amount && (
                        <p className="text-sm font-medium text-green-600 shrink-0">
                          {formatCurrency(activity.amount)}
                        </p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatDistanceToNow(new Date(activity.date), {
                        addSuffix: true,
                        locale: vi,
                      })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
